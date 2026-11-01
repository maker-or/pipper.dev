import type { DatabaseSync } from "node:sqlite";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServerInput, McpServerRecord } from "../../contracts/acp.ts";
import type {
  ConnectorSnapshot,
  ConnectorStatus,
  ConnectorTool,
} from "../../contracts/connectors.ts";
import type { SecretBox } from "../desktop-identity.ts";
import {
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  updateMcpServer,
} from "../mcp-servers.ts";

/** An `mcp_servers` row with the columns connectors add. */
export interface ConnectorRow extends McpServerRecord {
  enabled: number;
  status: string | null;
  last_error: string | null;
  tools_json: string | null;
  catalog_id: string | null;
}

/** What Pipper keeps for a connector that no tool or renderer ever reads. */
export interface ConnectorSecretData {
  /** `env` values for a local connector. */
  env?: Record<string, string>;
  /** Headers Pipper sends a remote connector, such as an API key. */
  headers?: Record<string, string>;
  oauth?: {
    client?: OAuthClientInformationMixed;
    /** The redirect URL `client` was registered with. */
    clientRedirectUrl?: string;
    tokens?: OAuthTokens;
    codeVerifier?: string;
  };
}

/** A tool from a connector's `tools/list`: name and description, plus its schema and annotations. */
export interface ConnectorToolDefinition {
  name: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ConnectorInput extends McpServerInput {
  headers?: Record<string, string> | null;
  catalogId?: string | null;
}

export function ensureConnectorSchema(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const add = (name: string, ddl: string) => {
    if (!columns.has(name)) db.exec(`ALTER TABLE mcp_servers ADD COLUMN ${ddl};`);
  };
  add("enabled", "enabled INTEGER NOT NULL DEFAULT 1");
  add("status", "status TEXT");
  add("last_error", "last_error TEXT");
  add("tools_json", "tools_json TEXT");
  add("catalog_id", "catalog_id TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_secrets (
      connector_id TEXT PRIMARY KEY,
      sealed BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const STATUSES = new Set<ConnectorStatus>(["unknown", "connected", "needs_sign_in", "error"]);

/**
 * Connector rows (`mcp_servers`) and their secrets. Secrets are sealed with
 * the OS keychain (`safeStorage`); without one they live in memory only, so
 * a sign-in lasts until Pipper quits, and `env` stays in the row as before.
 */
export class ConnectorStore {
  private readonly memorySecrets = new Map<string, ConnectorSecretData>();

  private readonly getDb: () => DatabaseSync;
  private readonly box: SecretBox | null;

  constructor(getDb: () => DatabaseSync, box: SecretBox | null) {
    this.getDb = getDb;
    this.box = box;
  }

  private get sealing(): boolean {
    return Boolean(this.box?.available());
  }

  list(): ConnectorRow[] {
    return listMcpServers() as ConnectorRow[];
  }

  get(id: string): ConnectorRow | null {
    return getMcpServer(id) as ConnectorRow | null;
  }

  create(input: ConnectorInput): ConnectorRow {
    const sealing = this.sealing;
    const row = createMcpServer({ ...input, env: sealing ? null : input.env });
    if (sealing && input.env) this.updateSecrets(row.id, (data) => ({ ...data, env: input.env! }));
    if (input.headers) this.updateSecrets(row.id, (data) => ({ ...data, headers: input.headers! }));
    if (input.catalogId) {
      this.getDb()
        .prepare("UPDATE mcp_servers SET catalog_id = ? WHERE id = ?")
        .run(input.catalogId, row.id);
    }
    return this.get(row.id)!;
  }

  /** Changing where a connector points drops its sign-in and its saved state. */
  update(id: string, input: Partial<ConnectorInput>): ConnectorRow | null {
    const before = this.get(id);
    if (!before) return null;
    const sealing = this.sealing;
    updateMcpServer(id, {
      ...input,
      ...(input.env !== undefined && sealing ? { env: null } : {}),
    });
    if (input.env !== undefined && sealing) {
      this.updateSecrets(id, (data) => ({ ...data, env: input.env ?? undefined }));
    }
    if (input.headers !== undefined) {
      this.updateSecrets(id, (data) => ({ ...data, headers: input.headers ?? undefined }));
    }
    const after = this.get(id)!;
    if (after.url !== before.url || after.transport_type !== before.transport_type) {
      this.updateSecrets(id, (data) => ({ ...data, oauth: undefined }));
      this.setState(id, { status: "unknown", lastError: null, tools: [] });
    } else if (input.headers !== undefined) {
      this.setState(id, { status: "unknown", lastError: null });
    }
    return this.get(id);
  }

  remove(id: string): void {
    deleteMcpServer(id);
    this.getDb().prepare("DELETE FROM connector_secrets WHERE connector_id = ?").run(id);
    this.memorySecrets.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.getDb()
      .prepare("UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  setState(
    id: string,
    state: {
      status: ConnectorStatus;
      lastError?: string | null;
      tools?: ConnectorToolDefinition[];
    },
  ): void {
    const db = this.getDb();
    db.prepare("UPDATE mcp_servers SET status = ?, last_error = ? WHERE id = ?").run(
      state.status,
      state.lastError ?? null,
      id,
    );
    if (state.tools) {
      db.prepare("UPDATE mcp_servers SET tools_json = ? WHERE id = ?").run(
        JSON.stringify(state.tools),
        id,
      );
    }
  }

  /** The connector's last `tools/list`, as the server sent it. */
  toolDefinitions(row: ConnectorRow): ConnectorToolDefinition[] {
    return parseJson<ConnectorToolDefinition[]>(row.tools_json, []);
  }

  tools(row: ConnectorRow): ConnectorTool[] {
    return this.toolDefinitions(row).map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
    }));
  }

  /** `env` for a local connector's session entry. */
  env(row: ConnectorRow): Record<string, string> {
    return this.secrets(row.id).env ?? parseJson<Record<string, string>>(row.env, {});
  }

  secrets(id: string): ConnectorSecretData {
    if (!this.sealing) return this.memorySecrets.get(id) ?? {};
    const row = this.getDb()
      .prepare("SELECT sealed FROM connector_secrets WHERE connector_id = ?")
      .get(id) as { sealed: Uint8Array } | undefined;
    if (!row) return {};
    try {
      return JSON.parse(this.box!.decrypt(Buffer.from(row.sealed))) as ConnectorSecretData;
    } catch {
      // Sealed by another keychain (a copied profile): the sign-in is lost.
      return {};
    }
  }

  updateSecrets(id: string, change: (data: ConnectorSecretData) => ConnectorSecretData): void {
    const next = change(this.secrets(id));
    if (!this.sealing) {
      this.memorySecrets.set(id, next);
      return;
    }
    this.getDb()
      .prepare(
        `INSERT INTO connector_secrets (connector_id, sealed, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(connector_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at`,
      )
      .run(id, this.box!.encrypt(JSON.stringify(next)), Date.now());
  }

  /** Moves `env` values saved in plain text before connectors into the keychain. */
  sealPlainEnv(): void {
    if (!this.sealing) return;
    for (const row of this.list()) {
      if (!row.env) continue;
      const env = parseJson<Record<string, string>>(row.env, {});
      this.updateSecrets(row.id, (data) => ({ ...data, env: { ...env, ...data.env } }));
      this.getDb().prepare("UPDATE mcp_servers SET env = NULL WHERE id = ?").run(row.id);
    }
  }

  snapshot(row: ConnectorRow): ConnectorSnapshot {
    const secrets = this.secrets(row.id);
    const status = row.status as ConnectorStatus | null;
    return {
      id: row.id,
      name: row.name,
      catalogId: row.catalog_id ?? null,
      transport: row.transport_type,
      url: row.url,
      command: row.command,
      args: parseJson<string[]>(row.args, []),
      envNames: Object.keys(this.env(row)),
      headerNames: Object.keys(secrets.headers ?? {}),
      enabled: row.enabled !== 0,
      status: status && STATUSES.has(status) ? status : "unknown",
      lastError: row.last_error,
      signedIn: Boolean(secrets.oauth?.tokens),
      signingIn: false,
      tools: this.tools(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
