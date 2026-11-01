import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Minimal MCP server over streamable HTTP (JSON response mode only, no SSE).
 * Each client-hosted tool family (agent tasks, browser) runs one instance and
 * registers a distinct endpoint per ACP session at `/mcp/<token>`, so tool
 * calls are attributable to the session that made them — that's what depth
 * limits, cancel cascades and per-session browser pages key off.
 *
 * Only the message types agents need to use tools are implemented:
 * initialize, ping, tools/list, tools/call. Notifications get 202.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
  /**
   * Sent as `instructions` in the initialize result. Clients that support it
   * add it to the model's context, so it can say when to reach for the tools.
   */
  instructions?: string;
}

export interface McpEndpoint {
  /** Overrides the server's name and instructions for this endpoint (connectors). */
  info?: () => McpServerInfo;
  listTools(): McpToolDefinition[] | Promise<McpToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const DEFAULT_SERVER_INFO: McpServerInfo = { name: "pipper", version: "1.0.0" };
const REQUEST_TIMEOUT_MS = 30_000;
/** How long an idle keep-alive connection stays open; longer than clients keep theirs. */
export const KEEP_ALIVE_TIMEOUT_MS = 10 * 60_000;
const MAX_IN_FLIGHT_PER_ENDPOINT = 16;

function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => {
      req.destroy(new Error("request body timed out"));
      reject(new Error("request body timed out"));
    }, REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    const cleanup = () => clearTimeout(timeout);
    req.once("aborted", () => {
      cleanup();
      reject(new Error("request aborted"));
    });
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function rpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export class McpHttpServer {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly endpoints = new Map<string, McpEndpoint>();
  private readonly inFlight = new Map<string, number>();

  private readonly serverInfo: McpServerInfo;

  constructor(serverInfo: McpServerInfo = DEFAULT_SERVER_INFO) {
    this.serverInfo = serverInfo;
  }

  async start(): Promise<number> {
    if (this.port != null) return this.port;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, "internal error"));
      });
    });
    // Node closes an idle keep-alive connection after 5 s by default. Agent
    // harnesses (OpenCode runs on Bun) can hold idle connections longer and
    // reuse one just as Node closes it; that call then fails as "Connection
    // closed" without reaching us. Outlast any client's idle pool instead.
    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
    server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;
    this.server = server;
    this.port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error(`failed to bind ${this.serverInfo.name} MCP server`));
      });
    });
    return this.port;
  }

  urlFor(token: string): string {
    if (this.port == null) throw new Error(`${this.serverInfo.name} MCP server not started`);
    return `http://127.0.0.1:${this.port}/mcp/${token}`;
  }

  register(token: string, endpoint: McpEndpoint): void {
    this.endpoints.set(token, endpoint);
  }

  unregister(token: string): void {
    this.endpoints.delete(token);
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.port = null;
    this.endpoints.clear();
    this.inFlight.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(req.url ?? "");
    const endpoint = match ? this.endpoints.get(match[1]) : undefined;
    if (!endpoint) {
      sendJson(res, 404, rpcError(null, -32001, "unknown MCP endpoint"));
      return;
    }
    const token = match![1];
    const inFlight = this.inFlight.get(token) ?? 0;
    if (inFlight >= MAX_IN_FLIGHT_PER_ENDPOINT) {
      sendJson(res, 429, rpcError(null, -32002, "too many in-flight MCP requests"));
      return;
    }
    this.inFlight.set(token, inFlight + 1);
    try {
      await this.handleEndpointRequest(req, res, endpoint);
    } finally {
      const remaining = (this.inFlight.get(token) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(token, remaining);
      else this.inFlight.delete(token);
    }
  }

  private async handleEndpointRequest(
    req: IncomingMessage,
    res: ServerResponse,
    endpoint: McpEndpoint,
  ): Promise<void> {
    // Streamable HTTP clients may open a GET stream or DELETE the session;
    // neither is needed in JSON response mode.
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(await readBody(req)) as JsonRpcMessage;
    } catch {
      sendJson(res, 400, rpcError(null, -32700, "parse error"));
      return;
    }
    if (Array.isArray(message)) {
      sendJson(res, 400, rpcError(null, -32600, "batch requests are not supported"));
      return;
    }

    // Notifications and client responses: acknowledge without a body.
    if (message.id === undefined || message.id === null || !message.method) {
      res.writeHead(202).end();
      return;
    }

    const result = await this.dispatch(endpoint, message);
    sendJson(res, 200, result);
  }

  private async dispatch(endpoint: McpEndpoint, message: JsonRpcMessage): Promise<unknown> {
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        const info = endpoint.info?.() ?? this.serverInfo;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            ...(info.instructions ? { instructions: info.instructions } : {}),
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        try {
          return { jsonrpc: "2.0", id, result: { tools: await endpoint.listTools() } };
        } catch (err) {
          return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
        }
      case "tools/call": {
        const params = (message.params ?? {}) as {
          name?: unknown;
          arguments?: Record<string, unknown>;
        };
        if (typeof params.name !== "string") {
          return rpcError(id, -32602, "tools/call requires a tool name");
        }
        // Calls block until the tool settles; there is no SSE progress
        // stream. Tools keep their own calls short (agent tasks return at once
        // and wait at most 240 s) and a client that gives up does not cancel
        // the work behind them.
        try {
          const result = await endpoint.callTool(params.name, params.arguments ?? {});
          return { jsonrpc: "2.0", id, result };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text }], isError: true },
          };
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${message.method}`);
    }
  }
}
