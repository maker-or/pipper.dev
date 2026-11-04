import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  CONNECTOR_CATALOG,
  connectorCatalogEntry,
  type ConnectorCatalogEntry,
} from "../../contracts/connector-catalog.ts";
import type {
  ConnectorRequestAnswer,
  ConnectorRequestRef,
  ConnectorRequestSnapshot,
  ConnectorRequestState,
  ConnectorSnapshot,
} from "../../contracts/connectors.ts";
import { addConnector, REMOTE_URL, updateConnector } from "./connector-edits.ts";
import type { ConnectorGateway } from "./connector-gateway.ts";
import type { ConnectorRow, ConnectorStore } from "./connector-store.ts";

/**
 * `add_connector`: an agent asks for a connector, the user connects it from a
 * card in the thread. Nothing is saved until the user presses Connect, and
 * any key or `env` value goes from the card to main, never through the agent.
 * See docs/capabilities/design.md, "Connectors".
 */

/** Unanswered cards expire after this long, like thread proposals. */
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const NAMES = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+$/, "Names are letters, digits, '_', '.' and '-'."),
  )
  .max(20);

export const ADD_CONNECTOR_INPUT = z.strictObject({
  catalog: z
    .string()
    .min(1)
    .optional()
    .describe("A catalog id from get_settings' connector_catalog. Prefer it to a custom server."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("Custom server only: what to call it."),
  url: REMOTE_URL.optional().describe("Custom remote server only: its MCP endpoint (https)."),
  command: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Custom local server only: the command the agent starts, such as npx."),
  args: z.array(z.string().max(4_000)).max(100).optional().describe("With command."),
  env_names: NAMES.optional().describe(
    "With command: names of environment values the user types into the card, such as " +
      "DATABASE_URL. Never the values.",
  ),
  header_names: NAMES.optional().describe(
    "With url: names of headers the user types into the card, such as Authorization. Never " +
      "the values.",
  ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('One line the card shows the user, such as "To file the bug you described".'),
});

export type AddConnectorInput = z.infer<typeof ADD_CONNECTOR_INPUT>;

/** Thrown for input the agent can fix; worded for it. */
export class ConnectorRequestInputError extends Error {}

interface RequestRow {
  id: string;
  thread_id: string;
  catalog_id: string | null;
  name: string;
  url: string | null;
  command: string | null;
  args: string;
  env_names: string;
  header_names: string;
  reason: string;
  state: ConnectorRequestState;
  error: string | null;
  connector_id: string | null;
  created_at: number;
  updated_at: number;
}

export function ensureConnectorRequestSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_requests (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      catalog_id TEXT,
      name TEXT NOT NULL,
      url TEXT,
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      env_names TEXT NOT NULL DEFAULT '[]',
      header_names TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      connector_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS connector_requests_thread ON connector_requests (thread_id);
  `);
}

const OPEN: ReadonlySet<ConnectorRequestState> = new Set(["requested", "connecting", "failed"]);

function sameArgs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseList(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolCount(connector: ConnectorSnapshot): string {
  const n = connector.tools.length;
  return `${n} ${n === 1 ? "tool" : "tools"}`;
}

/** Whether connecting this catalog entry can open a sign-in page. */
function signsInWithBrowser(entry: ConnectorCatalogEntry | null): boolean {
  return entry?.auth.kind !== "key" && entry?.auth.kind !== "none";
}

export interface ConnectorRequestsOptions {
  db: () => DatabaseSync;
  store: ConnectorStore;
  gateway: ConnectorGateway;
  /** A card changed, so open threads redraw it. */
  onChanged?(request: ConnectorRequestSnapshot): void;
  now?: () => number;
}

export class ConnectorRequests {
  /**
   * Told when a request's connector is ready: reload the asking thread so its
   * session gets the tools, then send it `note`. Set by the agent manager.
   */
  onReady: ((threadId: string, note: string) => void) | null = null;

  private readonly options: ConnectorRequestsOptions;

  constructor(options: ConnectorRequestsOptions) {
    this.options = options;
  }

  private get db(): DatabaseSync {
    return this.options.db();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The agent's call. Returns the tool result. */
  ask(threadId: string, raw: AddConnectorInput): Record<string, unknown> {
    const input = ADD_CONNECTOR_INPUT.parse(raw);
    const target = this.target(input);
    const existing = this.existingConnector(target);
    const live = existing ? this.options.gateway.snapshotOf(existing) : null;
    if (live?.enabled && (live.transport === "stdio" || live.status === "connected")) {
      return {
        status: "connected",
        connector: live.name,
        tools: live.transport === "stdio" ? null : live.tools.length,
        next:
          `${live.name} is already connected. Threads get a connector's tools when their ` +
          "session starts; if its tools aren't in your list, this thread started before it " +
          "was connected, so tell the user a new thread will have them.",
      };
    }
    const waiting = this.list(threadId).find(
      (request) =>
        OPEN.has(request.state) &&
        request.catalogId === target.catalogId &&
        request.url === target.url &&
        request.command === target.command &&
        sameArgs(request.args, target.args),
    );
    const request =
      waiting ??
      this.insert({
        threadId,
        ...target,
        reason: input.reason,
        connectorId: existing?.id ?? null,
      });
    return {
      // First, so it survives into the transcript's tool output preview.
      request_id: request.requestId,
      status: "awaiting_user",
      connector: request.name,
      next:
        `Pipper shows the user a card under your reply to connect ${request.name}; nothing is ` +
        "connected until they press Connect, and any key goes from the card to Pipper, not to " +
        "you. Don't call add_connector again for it or paste the request id. End your turn, " +
        "or carry on with something that doesn't need it. Once it's connected, Pipper reloads " +
        "this thread so its tools are available and sends you a note.",
    };
  }

  /**
   * A transcript's card: by id, or, for harnesses that don't forward MCP
   * results, the thread's newest request for the connector its call named.
   * See docs/harness-differences.md.
   */
  find(ref: ConnectorRequestRef): ConnectorRequestSnapshot | null {
    if ("id" in ref) return this.get([ref.id])[0] ?? null;
    const { catalog, url, command, args } = ref.input;
    const entry = connectorCatalogEntry(catalog);
    return (
      this.list(ref.threadId).find((request) =>
        catalog
          ? request.catalogId === (entry?.id ?? catalog)
          : url
            ? request.catalogId === null && request.url === url
            : request.command === command && (!args || sameArgs(request.args, args)),
      ) ?? null
    );
  }

  get(ids: string[]): ConnectorRequestSnapshot[] {
    return ids
      .map((id) => this.row(id))
      .filter((row): row is RequestRow => row !== null)
      .map((row) => this.snapshot(row));
  }

  /** The user pressed Connect (or Try again). */
  async connect(
    id: string,
    answer: ConnectorRequestAnswer = {},
  ): Promise<ConnectorRequestSnapshot> {
    const row = this.requireOpen(id);
    if (row.state === "connecting") return this.snapshot(row);
    this.setState(id, { state: "connecting", error: null });
    const { store, gateway } = this.options;
    const entry = connectorCatalogEntry(row.catalog_id);
    let connector: ConnectorSnapshot;
    try {
      const values = answer.values ?? {};
      const current = row.connector_id ? store.get(row.connector_id) : null;
      if (current) {
        if (answer.key) updateConnector(store, gateway, current.id, { key: answer.key });
        connector = gateway.setEnabled(current.id, true);
      } else if (entry) {
        connector = addConnector(store, gateway, { catalogId: entry.id, key: answer.key });
      } else if (row.command) {
        connector = addConnector(store, gateway, {
          name: row.name,
          transport: "stdio",
          command: row.command,
          args: parseList(row.args),
          env: pick(values, parseList(row.env_names)),
        });
      } else {
        connector = addConnector(store, gateway, {
          name: row.name,
          transport: "http",
          url: row.url!,
          headers: pick(values, parseList(row.header_names)),
        });
      }
      this.db
        .prepare("UPDATE connector_requests SET connector_id = ? WHERE id = ?")
        .run(connector.id, id);
      this.changed(id);
      if (connector.transport !== "stdio") {
        connector = signsInWithBrowser(entry)
          ? await gateway.connect(connector.id)
          : await gateway.check(connector.id);
      }
    } catch (error) {
      const message = errorText(error);
      // The user closed the sign-in; the card goes back to waiting for them.
      if (message.endsWith("The sign-in was cancelled.")) {
        this.setState(id, { state: "requested", error: null });
      } else {
        this.setState(id, { state: "failed", error: message });
      }
      return this.snapshot(this.row(id)!);
    }
    if (connector.transport !== "stdio" && connector.status !== "connected") {
      const message =
        connector.status === "needs_sign_in"
          ? entry?.auth.kind === "key"
            ? `${connector.name} didn't accept the key.`
            : `${connector.name} still needs a sign-in.`
          : (connector.lastError ?? `Couldn't connect to ${connector.name}.`);
      this.setState(id, { state: "failed", error: message });
      return this.snapshot(this.row(id)!);
    }
    this.setState(id, { state: "connected", error: null });
    this.onReady?.(
      row.thread_id,
      connector.transport === "stdio"
        ? `[Pipper] The user connected ${connector.name}. Pipper reloaded this thread, so its ` +
            "server starts with your session and its tools are available now. Carry on where " +
            "you stopped."
        : `[Pipper] The user connected ${connector.name} (${toolCount(connector)}). Pipper ` +
            "reloaded this thread, so its tools are available now. Carry on where you stopped.",
    );
    return this.snapshot(this.row(id)!);
  }

  /** The user pressed Cancel while the sign-in page was open. */
  cancel(id: string): void {
    const row = this.row(id);
    if (row?.connector_id) this.options.gateway.cancelSignIn(row.connector_id);
  }

  decline(id: string): ConnectorRequestSnapshot {
    const row = this.requireOpen(id);
    if (row.state === "connecting") this.cancel(id);
    this.setState(id, { state: "declined", error: null });
    return this.snapshot(this.row(id)!);
  }

  /** A connector changed (signed in from Settings, say): redraw the cards that point at it. */
  connectorChanged(connectorId: string): void {
    const rows = this.db
      .prepare("SELECT id FROM connector_requests WHERE connector_id = ?")
      .all(connectorId) as Array<{ id: string }>;
    for (const { id } of rows) this.changed(id);
  }

  // ---------------------------------------------------------------------------

  /** What the agent asked for, checked; a catalog id fills in the rest. */
  private target(input: AddConnectorInput) {
    if (input.catalog) {
      const entry = connectorCatalogEntry(input.catalog);
      if (!entry) {
        throw new ConnectorRequestInputError(
          `"${input.catalog}" isn't in Pipper's catalog. Catalog ids: ` +
            `${CONNECTOR_CATALOG.map((item) => item.id).join(", ")}. For another server, ` +
            "leave catalog out and give name with url or command.",
        );
      }
      if (input.url || input.command) {
        throw new ConnectorRequestInputError(
          "Give either catalog, or name with url or command; not both.",
        );
      }
      return {
        catalogId: entry.id,
        name: entry.name,
        url: entry.url,
        command: null,
        args: [] as string[],
        envNames: [] as string[],
        headerNames: [] as string[],
      };
    }
    if (!input.name || Boolean(input.url) === Boolean(input.command)) {
      throw new ConnectorRequestInputError(
        "Give catalog, or name with exactly one of url (a remote server) or command (a local one).",
      );
    }
    if (input.url && (input.args || input.env_names)) {
      throw new ConnectorRequestInputError("args and env_names go with command, not url.");
    }
    if (input.command && input.header_names) {
      throw new ConnectorRequestInputError("header_names go with url, not command.");
    }
    return {
      catalogId: null,
      name: input.name,
      url: input.url ?? null,
      command: input.command ?? null,
      args: input.args ?? [],
      envNames: input.env_names ?? [],
      headerNames: input.header_names ?? [],
    };
  }

  /** A connector the user already has for this target. */
  private existingConnector(target: ReturnType<ConnectorRequests["target"]>): ConnectorRow | null {
    return (
      this.options.store.list().find((row) => {
        if (target.catalogId) return row.catalog_id === target.catalogId;
        if (target.url) return row.transport_type !== "stdio" && row.url === target.url;
        return (
          row.transport_type === "stdio" &&
          row.command === target.command &&
          sameArgs(parseList(row.args), target.args)
        );
      }) ?? null
    );
  }

  private insert(request: {
    threadId: string;
    catalogId: string | null;
    name: string;
    url: string | null;
    command: string | null;
    args: string[];
    envNames: string[];
    headerNames: string[];
    reason: string;
    connectorId: string | null;
  }): ConnectorRequestSnapshot {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO connector_requests
          (id, thread_id, catalog_id, name, url, command, args, env_names, header_names, reason,
           state, connector_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
      )
      .run(
        id,
        request.threadId,
        request.catalogId,
        request.name,
        request.url,
        request.command,
        JSON.stringify(request.args),
        JSON.stringify(request.envNames),
        JSON.stringify(request.headerNames),
        request.reason,
        request.connectorId,
        now,
        now,
      );
    return this.snapshot(this.row(id)!);
  }

  private list(threadId: string): ConnectorRequestSnapshot[] {
    return (
      this.db
        .prepare("SELECT * FROM connector_requests WHERE thread_id = ? ORDER BY created_at DESC")
        .all(threadId) as unknown as RequestRow[]
    ).map((row) => this.snapshot(this.expire(row)));
  }

  private row(id: string): RequestRow | null {
    const row = this.db.prepare("SELECT * FROM connector_requests WHERE id = ?").get(id) as
      | RequestRow
      | undefined;
    return row ? this.expire(row) : null;
  }

  private requireOpen(id: string): RequestRow {
    const row = this.row(id);
    if (!row) throw new Error("This request no longer exists.");
    if (row.state === "expired") throw new Error("This request expired.");
    if (row.state === "declined") throw new Error("This request was declined.");
    if (row.state === "connected") throw new Error(`${row.name} is already connected.`);
    return row;
  }

  private expire(row: RequestRow): RequestRow {
    if (row.state !== "requested" || this.now() - row.created_at < REQUEST_TTL_MS) return row;
    this.db
      .prepare("UPDATE connector_requests SET state = 'expired', updated_at = ? WHERE id = ?")
      .run(this.now(), row.id);
    return { ...row, state: "expired" };
  }

  private setState(id: string, change: { state: ConnectorRequestState; error: string | null }) {
    this.db
      .prepare("UPDATE connector_requests SET state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(change.state, change.error, this.now(), id);
    this.changed(id);
  }

  private changed(id: string): void {
    const row = this.row(id);
    if (row) this.options.onChanged?.(this.snapshot(row));
  }

  private snapshot(row: RequestRow): ConnectorRequestSnapshot {
    const connectorRow = row.connector_id ? this.options.store.get(row.connector_id) : null;
    return {
      requestId: row.id,
      threadId: row.thread_id,
      catalogId: row.catalog_id,
      name: row.name,
      url: row.url,
      command: row.command,
      args: parseList(row.args),
      envNames: parseList(row.env_names),
      headerNames: parseList(row.header_names),
      reason: row.reason,
      state: row.state,
      error: row.error,
      connector: connectorRow ? this.options.gateway.snapshotOf(connectorRow) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** The named values the user filled in; empty ones are left out. */
function pick(values: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => (values[name]?.trim() ? [[name, values[name]!.trim()]] : [])),
  );
}
