import { randomBytes, randomUUID } from "node:crypto";
import { auth, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import type { ConnectorSnapshot, ConnectorStatus } from "../../contracts/connectors.ts";
import {
  McpHttpServer,
  type McpEndpoint,
  type McpToolDefinition,
  type McpToolResult,
} from "../mcp/mcp-http-server.ts";
import { ConnectorAuthProvider, LoopbackCallback } from "./connector-oauth.ts";
import type { ConnectorRow, ConnectorStore } from "./connector-store.ts";

/** A first connection (and its first `tools/list`) waits this long before using the saved tools. */
const CONNECT_TIMEOUT_MS = 20_000;
/** Connector tools can run long (a search, a report); progress resets the clock. */
const CALL_TIMEOUT_MS = 10 * 60_000;
/** How long Pipper waits for the user to finish signing in in the browser. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const MAX_TOOLS = 1000;

export interface ConnectorGatewayOptions {
  store: ConnectorStore;
  /** Opens a sign-in page in the user's browser. */
  openExternal(url: string): void | Promise<void>;
  /** The stdio↔HTTP shim for harnesses without HTTP MCP. */
  stdioShimPath(): Promise<string>;
  /** Told when a connector's status or tools change, so open views refresh. */
  onChanged?(connector: ConnectorSnapshot): void;
  clientVersion?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function isRemote(row: ConnectorRow): boolean {
  return row.transport_type !== "stdio" && Boolean(row.url);
}

/** A name harnesses accept as an MCP server name and use in tool ids. */
export function connectorServerName(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "connector";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Pipper's side of remote connectors. Pipper is the MCP client: one upstream
 * connection per connector, signed in with tokens only Pipper holds, shared
 * by every session. Each session reaches a connector through a local endpoint
 * named for it, over HTTP or the stdio shim, so every harness gets every
 * remote connector and none sees a token.
 *
 * The tool list is fixed per session (a harness reads `tools/list` once), so
 * a connector turned off, removed or signed out mid-session stays listed and
 * its calls fail with an error that says why.
 */
export class ConnectorGateway {
  private readonly server = new McpHttpServer({ name: "pipper-connectors", version: "1.0.0" });
  private readonly callback = new LoopbackCallback();
  /** connector id → endpoint token; stable for the app's run. */
  private readonly tokens = new Map<string, string>();
  /** connector id → the upstream connection, once asked for. */
  private readonly connections = new Map<string, Promise<Client>>();
  private readonly liveClients = new Map<string, Client>();
  private readonly liveTools = new Map<string, Tool[]>();
  private readonly instructions = new Map<string, string>();
  private readonly signIns = new Map<string, { state: string; done: Promise<ConnectorSnapshot> }>();
  /** Per share key (OpenCode's directory): attachments waiting on a session, and live sessions. */
  private readonly shared = new Map<string, { pending: number; sessions: Set<string> }>();
  private disposed = false;

  private readonly options: ConnectorGatewayOptions;

  constructor(options: ConnectorGatewayOptions) {
    this.options = options;
  }

  private get store(): ConnectorStore {
    return this.options.store;
  }

  /**
   * Adds every enabled remote connector to a session's MCP servers. Like
   * `pipper-agents`, a harness that keeps servers per directory gets them
   * only from the directory's first live session, since re-adding a server
   * there closes the calls in flight.
   */
  async attachMcpServers(
    baseServers: Array<Record<string, unknown>>,
    caps: AgentCapabilities,
    shareKey: string | null = null,
  ): Promise<{
    servers: Array<Record<string, unknown>>;
    /** Records the session that got the servers, once it exists. */
    bind: (sessionId: string) => void;
    /** Drops an attachment that never got a session. */
    release: () => void;
  }> {
    const rows = this.disposed
      ? []
      : this.store.list().filter((row) => row.enabled && isRemote(row));
    const none = { servers: baseServers, bind: () => {}, release: () => {} };
    if (rows.length === 0) return none;
    if (shareKey) {
      const directory = this.shared.get(shareKey) ?? { pending: 0, sessions: new Set<string>() };
      if (directory.sessions.size > 0) return none;
      directory.pending += 1;
      this.shared.set(shareKey, directory);
    }
    let settled = false;
    const settle = (sessionId: string | null) => {
      if (settled || !shareKey) return;
      settled = true;
      const directory = this.shared.get(shareKey);
      if (!directory) return;
      directory.pending = Math.max(0, directory.pending - 1);
      if (sessionId) directory.sessions.add(sessionId);
      if (directory.pending === 0 && directory.sessions.size === 0) this.shared.delete(shareKey);
    };
    await this.server.start();
    const shim = caps.mcpCapabilities?.http ? null : await this.options.stdioShimPath();
    const taken = new Set(baseServers.map((server) => String(server.name)));
    const entries = rows.map((row) => {
      const name = connectorServerName(row.name, taken);
      const url = this.server.urlFor(this.tokenFor(row.id));
      // Connect now, so the harness's first tools/list doesn't wait as long.
      void this.connection(row.id).catch(() => {});
      return shim
        ? {
            type: "stdio",
            name,
            command: process.execPath,
            args: [shim, url],
            env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
          }
        : // `headers` is required by the ACP HttpMcpServer schema.
          { type: "http", name, url, headers: [] };
    });
    return {
      servers: [...baseServers, ...entries],
      bind: (sessionId) => settle(sessionId),
      release: () => settle(null),
    };
  }

  /** A session ended; its directory may hand the servers to the next one. */
  releaseSession(sessionId: string): void {
    for (const [shareKey, directory] of this.shared) {
      if (!directory.sessions.delete(sessionId)) continue;
      if (directory.pending === 0 && directory.sessions.size === 0) this.shared.delete(shareKey);
    }
  }

  /** Signs in to a connector in the user's browser, then connects. */
  signIn(id: string): Promise<ConnectorSnapshot> {
    const running = this.signIns.get(id);
    if (running) return running.done;
    const state = randomBytes(24).toString("base64url");
    const done = this.runSignIn(id, state)
      .finally(() => {
        this.signIns.delete(id);
        this.notify(id);
      })
      // Taken once the sign-in is over, so it doesn't say one is running.
      .then(() => this.snapshot(id));
    this.signIns.set(id, { state, done });
    this.notify(id);
    return done;
  }

  /** Connects, and signs in first if the server asks for it. */
  async connect(id: string): Promise<ConnectorSnapshot> {
    const checked = await this.check(id);
    return checked.status === "needs_sign_in" ? this.signIn(id) : checked;
  }

  cancelSignIn(id: string): void {
    const running = this.signIns.get(id);
    if (running) this.callback.cancel(running.state);
  }

  signOut(id: string): ConnectorSnapshot {
    const row = this.requireRow(id);
    this.disconnect(id);
    this.store.updateSecrets(id, (data) => ({
      ...data,
      oauth: { ...data.oauth, tokens: undefined, codeVerifier: undefined },
    }));
    this.setState(row.id, { status: "needs_sign_in", lastError: null });
    return this.snapshot(id);
  }

  /** Connects again from scratch and refreshes the tools. */
  async check(id: string): Promise<ConnectorSnapshot> {
    const row = this.requireRow(id);
    this.disconnect(id);
    if (isRemote(row)) await this.connection(id).catch(() => {});
    return this.snapshot(id);
  }

  setEnabled(id: string, enabled: boolean): ConnectorSnapshot {
    this.requireRow(id);
    this.store.setEnabled(id, enabled);
    if (!enabled) this.disconnect(id);
    this.notify(id);
    return this.snapshot(id);
  }

  /** Drops the connection and endpoint of a connector that was removed or now points elsewhere. */
  forget(id: string): void {
    this.cancelSignIn(id);
    this.disconnect(id);
    const token = this.tokens.get(id);
    if (token) this.server.unregister(token);
    this.tokens.delete(id);
    this.instructions.delete(id);
  }

  snapshot(id: string): ConnectorSnapshot {
    return this.snapshotOf(this.requireRow(id));
  }

  snapshotOf(row: ConnectorRow): ConnectorSnapshot {
    return { ...this.store.snapshot(row), signingIn: this.signIns.has(row.id) };
  }

  dispose(): void {
    this.disposed = true;
    // Deleting the current entry while iterating a Map is safe.
    for (const id of this.connections.keys()) this.disconnect(id);
    this.callback.close();
    this.server.close();
    this.tokens.clear();
  }

  private requireRow(id: string): ConnectorRow {
    const row = this.store.get(id);
    if (!row) throw new Error("This connector was removed from Pipper.");
    return row;
  }

  private tokenFor(id: string): string {
    let token = this.tokens.get(id);
    if (!token) {
      token = randomUUID();
      this.tokens.set(id, token);
      this.server.register(token, this.endpointFor(id));
    }
    return token;
  }

  private endpointFor(id: string): McpEndpoint {
    return {
      info: () => ({
        name: this.store.get(id)?.name ?? "connector",
        version: "1.0.0",
        instructions: this.instructionsFor(id),
      }),
      listTools: async () => {
        // A connector that can't connect now still lists the tools it had, so
        // the agent sees them and its calls say what's wrong.
        await this.connection(id).catch(() => {});
        return this.toolsFor(id);
      },
      callTool: (name, args) => this.callTool(id, name, args),
    };
  }

  /**
   * The server's own instructions, or, when it can't be used now, what the
   * agent should do instead: its tool list may be empty or stale.
   */
  private instructionsFor(id: string): string | undefined {
    const row = this.store.get(id);
    if (row?.status === "needs_sign_in") return this.signInMessage(row);
    if (row?.status === "error") {
      return `Pipper can't reach ${row.name} right now${row.last_error ? `: ${row.last_error}` : ""}.`;
    }
    return this.instructions.get(id);
  }

  private toolsFor(id: string): McpToolDefinition[] {
    const tools = this.liveTools.get(id);
    if (tools) return tools as unknown as McpToolDefinition[];
    const row = this.store.get(id);
    return row ? (this.store.toolDefinitions(row) as unknown as McpToolDefinition[]) : [];
  }

  private async callTool(
    id: string,
    name: string,
    args: Record<string, unknown>,
    retried = false,
  ): Promise<McpToolResult> {
    const row = this.requireRow(id);
    if (!row.enabled) {
      throw new Error(
        `${row.name} is turned off in Pipper. Tell the user; they can turn it on in Settings → Connectors.`,
      );
    }
    const client = await this.connection(id);
    try {
      // The upstream result goes back as it came: content, structuredContent, isError.
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      })) as McpToolResult;
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        this.disconnect(id);
        this.setState(id, { status: "needs_sign_in", lastError: null });
        throw new Error(this.signInMessage(row));
      }
      // The connection dropped under the call: connect again once.
      if (!retried && this.liveClients.get(id) !== client) {
        return this.callTool(id, name, args, true);
      }
      throw error;
    }
  }

  private signInMessage(row: ConnectorRow): string {
    return (
      `${row.name} needs the user to sign in${row.tools_json ? " again" : ""}. Call ` +
      "pipper-agents' add_connector for it, which shows the user a sign-in card in this " +
      "thread; you get a note when it's ready. Don't retry its tools until then."
    );
  }

  private connection(id: string): Promise<Client> {
    const existing = this.connections.get(id);
    if (existing) return existing;
    const attempt = this.open(id);
    this.connections.set(id, attempt);
    attempt.catch(() => {
      if (this.connections.get(id) === attempt) this.connections.delete(id);
    });
    return attempt;
  }

  private async open(id: string): Promise<Client> {
    const row = this.requireRow(id);
    if (!isRemote(row)) throw new Error(`${row.name} is a local connector.`);
    const provider = new ConnectorAuthProvider({ connectorId: id, store: this.store });
    let client: Client;
    try {
      client = await withTimeout(
        this.connectClient(row, provider),
        CONNECT_TIMEOUT_MS,
        `${row.name} didn't answer in ${CONNECT_TIMEOUT_MS / 1000} s.`,
      );
    } catch (error) {
      if (provider.needsSignIn || error instanceof UnauthorizedError) {
        this.setState(id, { status: "needs_sign_in", lastError: null });
        throw new Error(this.signInMessage(row));
      }
      const message = errorMessage(error);
      this.setState(id, { status: "error", lastError: message });
      throw new Error(`${row.name} isn't reachable: ${message}`);
    }
    client.onclose = () => {
      if (this.liveClients.get(id) !== client) return;
      this.liveClients.delete(id);
      this.connections.delete(id);
    };
    this.liveClients.set(id, client);
    const instructions = client.getInstructions();
    if (instructions) this.instructions.set(id, instructions);
    try {
      const tools = await this.listAllTools(client);
      this.liveTools.set(id, tools);
      this.setState(id, { status: "connected", lastError: null, tools });
    } catch (error) {
      this.setState(id, { status: "error", lastError: errorMessage(error) });
      throw error;
    }
    return client;
  }

  private async connectClient(row: ConnectorRow, provider: ConnectorAuthProvider): Promise<Client> {
    const url = new URL(row.url!);
    const requestInit = { headers: this.store.secrets(row.id).headers ?? {} };
    const newClient = () =>
      new Client({ name: "pipper", version: this.options.clientVersion ?? "1.0.0" });
    if (row.transport_type === "sse") {
      const client = newClient();
      await client.connect(new SSEClientTransport(url, { authProvider: provider, requestInit }));
      return client;
    }
    const client = newClient();
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit }),
      );
      return client;
    } catch (error) {
      if (provider.needsSignIn || error instanceof UnauthorizedError) throw error;
      // Servers from before streamable HTTP speak only the older SSE transport.
      const fallback = newClient();
      try {
        await fallback.connect(
          new SSEClientTransport(url, { authProvider: provider, requestInit }),
        );
      } catch {
        throw error;
      }
      return fallback;
    }
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    return tools;
  }

  private async runSignIn(id: string, state: string): Promise<ConnectorSnapshot> {
    const row = this.requireRow(id);
    if (!isRemote(row)) throw new Error(`${row.name} is a local connector; it has no sign-in.`);
    const redirectUrl = await this.callback.start();
    const signInPage: { url: URL | null } = { url: null };
    const provider = new ConnectorAuthProvider({
      connectorId: id,
      store: this.store,
      redirectUrl,
      state,
      onRedirect: (url) => {
        signInPage.url = url;
      },
    });
    this.disconnect(id);
    // A sign-in the user asks for is a fresh one, not a refresh.
    provider.invalidateCredentials("tokens");
    try {
      let result = await auth(provider, { serverUrl: row.url! });
      if (result === "REDIRECT") {
        const page = signInPage.url;
        if (!page) throw new Error(`${row.name} gave no sign-in page.`);
        // The page comes from the server; only a web page is opened.
        if (page.protocol !== "https:" && page.protocol !== "http:") {
          throw new Error(`${row.name} gave a sign-in page that isn't a web page.`);
        }
        const code = this.callback.waitFor(state, SIGN_IN_TIMEOUT_MS);
        await this.options.openExternal(page.toString());
        result = await auth(provider, { serverUrl: row.url!, authorizationCode: await code });
      }
      if (result !== "AUTHORIZED") throw new Error(`${row.name} didn't finish the sign-in.`);
    } catch (error) {
      const message = errorMessage(error);
      this.setState(id, { status: "needs_sign_in", lastError: message });
      throw new Error(`Couldn't sign in to ${row.name}: ${message}`);
    }
    await this.connection(id);
    return this.snapshot(id);
  }

  private disconnect(id: string): void {
    const client = this.liveClients.get(id);
    this.liveClients.delete(id);
    this.connections.delete(id);
    this.liveTools.delete(id);
    if (client) void client.close().catch(() => {});
  }

  private setState(
    id: string,
    state: { status: ConnectorStatus; lastError?: string | null; tools?: Tool[] },
  ): void {
    if (!this.store.get(id)) return;
    this.store.setState(id, state);
    this.notify(id);
  }

  private notify(id: string): void {
    const row = this.store.get(id);
    if (row) this.options.onChanged?.(this.snapshotOf(row));
  }
}
