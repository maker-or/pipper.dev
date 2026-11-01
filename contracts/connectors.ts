/**
 * Connectors: MCP servers Pipper connects once for every thread on every
 * harness. Remote ones go through Pipper's gateway, which signs in and keeps
 * the tokens; local (stdio) ones are started by the harness. Secrets (tokens,
 * keys, `env` values) never appear here.
 */

export type ConnectorTransport = "http" | "sse" | "stdio";

/**
 * - `unknown`: not tried since it was added or changed.
 * - `connected`: the last connection worked.
 * - `needs_sign_in`: the server wants a sign-in Pipper doesn't have.
 * - `error`: the last connection failed for another reason (`lastError`).
 */
export type ConnectorStatus = "unknown" | "connected" | "needs_sign_in" | "error";

export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
}

export interface ConnectorSnapshot {
  id: string;
  name: string;
  /** The catalog entry it was added from; null for a custom URL or command. */
  catalogId: string | null;
  transport: ConnectorTransport;
  url: string | null;
  command: string | null;
  args: string[];
  /** Names of the `env` values a local connector gets; the values stay in Pipper. */
  envNames: string[];
  /** Names of the headers Pipper sends a remote connector; the values stay in Pipper. */
  headerNames: string[];
  enabled: boolean;
  status: ConnectorStatus;
  lastError: string | null;
  /** True once the user has signed in with OAuth and the tokens are kept. */
  signedIn: boolean;
  /** A sign-in page is open in the browser and Pipper is waiting for it. */
  signingIn: boolean;
  /** The last `tools/list` Pipper saw; empty for local connectors. */
  tools: ConnectorTool[];
  createdAt: number;
  updatedAt: number;
}

/** Values for headers and `env` come from the user and are stored encrypted. */
export type ConnectorAddInput =
  | { catalogId: string; key?: string }
  | { name: string; transport: "http" | "sse"; url: string; headers?: Record<string, string> }
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

/**
 * Changes the user makes to a connector. A header or `env` value left empty
 * keeps the one Pipper has; a name left out is removed. `key` replaces the
 * key of a catalog connector that signs in with one.
 */
export interface ConnectorUpdateInput {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  key?: string;
}

/**
 * - `requested`: the card waits for the user to press Connect.
 * - `connecting`: Pipper is connecting, or waiting for a sign-in in the browser.
 * - `connected`: done; the asking thread got a note.
 * - `declined`: the user pressed Don't connect.
 * - `failed`: connecting failed (`error`); the user can try again.
 * - `expired`: nobody answered for a week.
 */
export type ConnectorRequestState =
  | "requested"
  | "connecting"
  | "connected"
  | "declined"
  | "failed"
  | "expired";

/** An agent's `add_connector` call, as its card in the thread shows it. */
export interface ConnectorRequestSnapshot {
  requestId: string;
  threadId: string;
  /** The catalog entry asked for; null for a custom URL or command. */
  catalogId: string | null;
  name: string;
  url: string | null;
  command: string | null;
  args: string[];
  /** Names of values the user types into the card; the values never reach the agent. */
  envNames: string[];
  headerNames: string[];
  /** The agent's one line on why it needs it. */
  reason: string;
  state: ConnectorRequestState;
  error: string | null;
  /** The connector it set up or points at, while it exists. */
  connector: ConnectorSnapshot | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * How a transcript finds a card: by the id in the tool's result, or, for
 * adapters that don't forward MCP results, by the thread and what it asked for.
 */
export type ConnectorRequestRef =
  | { id: string }
  | {
      threadId: string;
      input: { catalog?: string; url?: string; command?: string; args?: string[] };
    };

/** What the user typed into the card: a catalog key, or header / `env` values by name. */
export interface ConnectorRequestAnswer {
  key?: string;
  values?: Record<string, string>;
}
