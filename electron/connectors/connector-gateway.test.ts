import { once } from "node:events";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// @ts-expect-error express ships without types here; only the test server uses it.
import express from "express";

const testDb = vi.hoisted(() => ({ current: null as DatabaseSync | null }));
vi.mock("../db.ts", () => ({ getDb: () => testDb.current }));

import type { SecretBox } from "../desktop-identity.ts";
import { toAcpMcpServers } from "../mcp-servers.ts";
import { addConnector, removeConnector, updateConnector } from "./connector-edits.ts";
import { ConnectorRequests, ensureConnectorRequestSchema } from "./connector-requests.ts";
import { ConnectorGateway, connectorServerName } from "./connector-gateway.ts";
import { ConnectorStore, ensureConnectorSchema } from "./connector-store.ts";

/** Stands in for the OS keychain: reversible, but never the plain text. */
const fakeKeychain: SecretBox = {
  available: () => true,
  encrypt: (plain) =>
    Buffer.from(Buffer.from(plain).toString("base64").split("").reverse().join("")),
  decrypt: (cipher) =>
    Buffer.from(cipher.toString().split("").reverse().join(""), "base64").toString(),
};

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, transport_type TEXT NOT NULL,
      url TEXT, command TEXT, args TEXT, env TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  ensureConnectorSchema(db);
  ensureConnectorRequestSchema(db);
  return db;
}

/** An MCP server with one `echo` tool, behind OAuth when `auth` is set. */
async function startUpstream(options: { auth: boolean }) {
  const app = express();
  app.use(express.json());
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = new URL(`http://127.0.0.1:${port}`);
  const mcpUrl = new URL("/mcp", base);
  const guards: unknown[] = [];
  if (options.auth) {
    const provider = new DemoInMemoryAuthProvider();
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: base,
        resourceServerUrl: mcpUrl,
        scopesSupported: ["mcp:tools"],
      }),
    );
    guards.push(
      requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
      }),
    );
  }
  let calls = 0;
  app.post("/mcp", ...guards, async (req: any, res: any) => {
    const mcp = new McpServer({ name: "echo", version: "1.0.0" }, { instructions: "Echo things." });
    mcp.registerTool(
      "echo",
      { description: "Echoes text", inputSchema: { text: z.string() } },
      async ({ text }) => {
        calls += 1;
        return { content: [{ type: "text", text: `echo: ${text}` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get("/mcp", (_req: any, res: any) => res.status(405).end());
  return {
    url: mcpUrl.toString(),
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A harness's view: an MCP client on the session's server entry. */
async function harnessClient(entry: Record<string, unknown>) {
  const client = new Client({ name: "harness", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(String(entry.url))));
  return client;
}

const HTTP_CAPS = { mcpCapabilities: { http: true } };

let store: ConnectorStore;
let gateway: ConnectorGateway;
const opened: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  testDb.current = freshDb();
  store = new ConnectorStore(() => testDb.current!, fakeKeychain);
  opened.length = 0;
  gateway = new ConnectorGateway({
    store,
    // The demo server signs in at once and redirects to Pipper's callback;
    // following the redirect is what the user's browser would do.
    openExternal: async (url) => {
      opened.push(url);
      await fetch(url);
    },
    stdioShimPath: async () => "/tmp/shim.mjs",
  });
});

afterEach(async () => {
  gateway.dispose();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ConnectorStore", () => {
  test("keeps env and headers sealed and shows only their names", () => {
    const row = store.create({
      name: "db",
      transport_type: "stdio",
      command: "npx",
      args: ["db-mcp"],
      env: { DB_PASSWORD: "hunter2" },
    });
    expect(row.env).toBeNull();
    const sealed = testDb.current!.prepare("SELECT sealed FROM connector_secrets").get() as {
      sealed: Uint8Array;
    };
    expect(Buffer.from(sealed.sealed).toString()).not.toContain("hunter2");
    expect(store.env(row)).toEqual({ DB_PASSWORD: "hunter2" });
    const snapshot = store.snapshot(row);
    expect(snapshot.envNames).toEqual(["DB_PASSWORD"]);
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  test("moves env saved in plain text before connectors into the keychain", () => {
    testDb
      .current!.prepare(
        `INSERT INTO mcp_servers (id, name, transport_type, command, env, created_at, updated_at)
       VALUES ('old', 'old', 'stdio', 'run', '{"TOKEN":"abc"}', 1, 1)`,
      )
      .run();
    store.sealPlainEnv();
    const row = store.get("old")!;
    expect(row.env).toBeNull();
    expect(store.env(row)).toEqual({ TOKEN: "abc" });
  });

  test("without a keychain, secrets live in memory and env stays in the row", () => {
    const plain = new ConnectorStore(() => testDb.current!, {
      ...fakeKeychain,
      available: () => false,
    });
    const row = plain.create({
      name: "x",
      transport_type: "stdio",
      command: "run",
      env: { A: "1" },
    });
    expect(plain.env(row)).toEqual({ A: "1" });
    plain.updateSecrets(row.id, (data) => ({ ...data, headers: { Authorization: "k" } }));
    expect(testDb.current!.prepare("SELECT * FROM connector_secrets").all()).toEqual([]);
    expect(plain.snapshot(row).headerNames).toEqual(["Authorization"]);
  });
});

test("local connectors reach every agent, remote and turned-off ones don't", () => {
  const local = store.create({
    name: "fs",
    transport_type: "stdio",
    command: "fs-mcp",
    env: { K: "v" },
  });
  store.create({ name: "web", transport_type: "http", url: "https://example.com/mcp" });
  const off = store.create({ name: "off", transport_type: "stdio", command: "off-mcp" });
  store.setEnabled(off.id, false);
  const servers = toAcpMcpServers(store.list(), (row) => store.env(row));
  expect(servers).toEqual([
    { type: "stdio", name: "fs", command: "fs-mcp", args: [], env: [{ name: "K", value: "v" }] },
  ]);
  expect(local.id).toBeTruthy();
});

test("connector names become server names harnesses accept, without clashes", () => {
  const taken = new Set(["pipper-agents"]);
  expect(connectorServerName("My Linear!", taken)).toBe("my-linear");
  expect(connectorServerName("my linear", taken)).toBe("my-linear-2");
  expect(connectorServerName("Pipper Agents", taken)).toBe("pipper-agents-2");
  expect(connectorServerName("!!!", taken)).toBe("connector");
});

describe("ConnectorGateway", () => {
  test("serves a remote connector's tools to a session and passes calls through", async () => {
    const upstream = await startUpstream({ auth: false });
    cleanups.push(upstream.close);
    const row = store.create({ name: "Echo", transport_type: "http", url: upstream.url });

    const attached = await gateway.attachMcpServers([{ name: "pipper-agents" }], HTTP_CAPS);
    const entry = attached.servers[1]!;
    expect(entry).toMatchObject({ type: "http", name: "echo", headers: [] });
    expect(String(entry.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//);

    const harness = await harnessClient(entry);
    cleanups.push(() => harness.close());
    expect(harness.getServerVersion()?.name).toBe("Echo");
    const { tools } = await harness.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await harness.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: hi" }]);

    const snapshot = gateway.snapshot(row.id);
    expect(snapshot.status).toBe("connected");
    expect(snapshot.tools).toEqual([{ name: "echo", description: "Echoes text" }]);
  });

  test("a connector turned off mid-session stays listed and says why its calls fail", async () => {
    const upstream = await startUpstream({ auth: false });
    cleanups.push(upstream.close);
    const row = store.create({ name: "Echo", transport_type: "http", url: upstream.url });
    const attached = await gateway.attachMcpServers([], HTTP_CAPS);
    const harness = await harnessClient(attached.servers[0]!);
    cleanups.push(() => harness.close());
    await harness.listTools();

    gateway.setEnabled(row.id, false);
    const result = await harness.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Echo is turned off in Pipper");
    expect(upstream.calls()).toBe(0);
    expect((await gateway.attachMcpServers([], HTTP_CAPS)).servers).toEqual([]);
  });

  test("an agent without HTTP MCP gets the connector through the stdio shim", async () => {
    store.create({ name: "Echo", transport_type: "http", url: "http://127.0.0.1:9/mcp" });
    const attached = await gateway.attachMcpServers([], { mcpCapabilities: {} });
    expect(attached.servers[0]).toMatchObject({
      type: "stdio",
      name: "echo",
      command: process.execPath,
      args: ["/tmp/shim.mjs", expect.stringMatching(/\/mcp\//)],
    });
  });

  test("a harness that shares servers per directory gets them from the first live session only", async () => {
    store.create({ name: "Echo", transport_type: "http", url: "http://127.0.0.1:9/mcp" });
    const first = await gateway.attachMcpServers([], HTTP_CAPS, "conn\0/repo");
    first.bind("s1");
    expect((await gateway.attachMcpServers([], HTTP_CAPS, "conn\0/repo")).servers).toEqual([]);
    gateway.releaseSession("s1");
    expect((await gateway.attachMcpServers([], HTTP_CAPS, "conn\0/repo")).servers).toHaveLength(1);
  });

  test("signs in with OAuth in the browser, keeps the tokens sealed, then connects", async () => {
    const upstream = await startUpstream({ auth: true });
    cleanups.push(upstream.close);
    const row = store.create({ name: "Secure", transport_type: "http", url: upstream.url });

    // Without a sign-in, the session's call says what the user has to do.
    const attached = await gateway.attachMcpServers([], HTTP_CAPS);
    const harness = await harnessClient(attached.servers[0]!);
    cleanups.push(() => harness.close());
    expect((await harness.listTools()).tools).toEqual([]);
    expect(gateway.snapshot(row.id)).toMatchObject({ status: "needs_sign_in", lastError: null });
    // Only a sign-in the user starts registers Pipper with the server.
    expect(store.secrets(row.id).oauth?.client).toBeUndefined();
    expect(opened).toEqual([]);

    const snapshot = await gateway.signIn(row.id);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/authorize");
    expect(snapshot).toMatchObject({ status: "connected", signedIn: true });
    const sealed = testDb.current!.prepare("SELECT sealed FROM connector_secrets").get() as {
      sealed: Uint8Array;
    };
    expect(Buffer.from(sealed.sealed).toString()).not.toContain("access_token");

    const result = await harness.callTool({ name: "echo", arguments: { text: "secure" } });
    expect(result.content).toEqual([{ type: "text", text: "echo: secure" }]);

    // A new gateway (Pipper restarted) uses the kept tokens without a page.
    gateway.dispose();
    gateway = new ConnectorGateway({
      store,
      openExternal: (url) => void opened.push(url),
      stdioShimPath: async () => "/tmp/shim.mjs",
    });
    expect((await gateway.check(row.id)).status).toBe("connected");
    expect(opened).toHaveLength(1);

    expect(gateway.signOut(row.id)).toMatchObject({ status: "needs_sign_in", signedIn: false });
  });

  test("a server that isn't there reports an error with the reason", async () => {
    const row = store.create({
      name: "Gone",
      transport_type: "http",
      url: "http://127.0.0.1:9/mcp",
    });
    const snapshot = await gateway.check(row.id);
    expect(snapshot.status).toBe("error");
    expect(snapshot.lastError).toBeTruthy();
  });
});

describe("adding and editing connectors", () => {
  test("a catalog connector gets Pipper's URL and name, and only once", () => {
    const linear = addConnector(store, gateway, { catalogId: "linear" });
    expect(linear).toMatchObject({
      name: "Linear",
      catalogId: "linear",
      url: "https://mcp.linear.app/mcp",
      signingIn: false,
    });
    expect(() => addConnector(store, gateway, { catalogId: "linear" })).toThrow(/already added/);
    expect(() => addConnector(store, gateway, { catalogId: "nope" })).toThrow(/catalog/);
    // The renderer can't slip its own URL into a catalog connector.
    expect(() =>
      addConnector(store, gateway, { catalogId: "notion", url: "https://evil.example" }),
    ).toThrow();
    // Its name and URL are Pipper's.
    updateConnector(store, gateway, linear.id, { name: "Other", url: "https://evil.example/mcp" });
    expect(gateway.snapshot(linear.id)).toMatchObject({
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
    });
  });

  test("a keyed catalog connector needs the key, seals it and can replace it", () => {
    expect(() => addConnector(store, gateway, { catalogId: "github" })).toThrow(
      /Personal access token/,
    );
    const github = addConnector(store, gateway, { catalogId: "github", key: "ghp_first" });
    expect(github.headerNames).toEqual(["Authorization"]);
    expect(JSON.stringify(github)).not.toContain("ghp_first");
    expect(store.secrets(github.id).headers).toEqual({ Authorization: "Bearer ghp_first" });

    updateConnector(store, gateway, github.id, { key: "ghp_second" });
    expect(store.secrets(github.id).headers).toEqual({ Authorization: "Bearer ghp_second" });
    expect(() =>
      updateConnector(store, gateway, addConnector(store, gateway, { catalogId: "linear" }).id, {
        key: "x",
      }),
    ).toThrow(/signs in in the browser/);
  });

  test("a custom remote connector needs https, except on this computer", () => {
    expect(() =>
      addConnector(store, gateway, { name: "Plain", transport: "http", url: "http://example.com" }),
    ).toThrow(/https/);
    expect(() =>
      addConnector(store, gateway, { name: " ", transport: "http", url: "https://a.example" }),
    ).toThrow(/name/);
    const local = addConnector(store, gateway, {
      name: "Dev",
      transport: "http",
      url: "http://localhost:3000/mcp",
      headers: { "X-Api-Key": "secret-1" },
    });
    expect(local).toMatchObject({ catalogId: null, headerNames: ["X-Api-Key"] });
  });

  test("editing keeps values left empty, drops names left out, and a new URL signs out", () => {
    const custom = addConnector(store, gateway, {
      name: "Acme",
      transport: "http",
      url: "https://acme.example/mcp",
      headers: { "X-Api-Key": "secret-1", "X-Team": "core" },
    });
    store.updateSecrets(custom.id, (data) => ({
      ...data,
      oauth: { tokens: { access_token: "t", token_type: "bearer" } },
    }));

    updateConnector(store, gateway, custom.id, { headers: { "X-Api-Key": "", "X-Org": "pipper" } });
    expect(store.secrets(custom.id).headers).toEqual({
      "X-Api-Key": "secret-1",
      "X-Org": "pipper",
    });
    expect(gateway.snapshot(custom.id).signedIn).toBe(true);

    updateConnector(store, gateway, custom.id, { url: "https://other.example/mcp" });
    expect(gateway.snapshot(custom.id)).toMatchObject({ signedIn: false, status: "unknown" });

    const local = addConnector(store, gateway, {
      name: "Postgres",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server-postgres"],
      env: { DATABASE_URL: "postgres://secret" },
    });
    updateConnector(store, gateway, local.id, {
      args: ["-y", "server-postgres@2"],
      env: { DATABASE_URL: "" },
    });
    expect(gateway.snapshot(local.id)).toMatchObject({
      args: ["-y", "server-postgres@2"],
      envNames: ["DATABASE_URL"],
    });
    expect(store.env(store.get(local.id)!)).toEqual({ DATABASE_URL: "postgres://secret" });

    removeConnector(store, gateway, local.id);
    expect(store.get(local.id)).toBeNull();
    expect(store.secrets(local.id)).toEqual({});
  });

  test("connect signs in only when the server asks for it", async () => {
    const open = await startUpstream({ auth: false });
    const secure = await startUpstream({ auth: true });
    cleanups.push(open.close, secure.close);
    const openRow = store.create({ name: "Open", transport_type: "http", url: open.url });
    const secureRow = store.create({ name: "Secure", transport_type: "http", url: secure.url });

    const changes: boolean[] = [];
    gateway.dispose();
    gateway = new ConnectorGateway({
      store,
      openExternal: async (url) => {
        opened.push(url);
        // While the page is open, Settings sees the sign-in in progress.
        expect(gateway.snapshot(secureRow.id).signingIn).toBe(true);
        await fetch(url);
      },
      stdioShimPath: async () => "/tmp/shim.mjs",
      onChanged: (connector) => {
        if (connector.id === secureRow.id) changes.push(connector.signingIn);
      },
    });

    expect(await gateway.connect(openRow.id)).toMatchObject({ status: "connected" });
    expect(opened).toEqual([]);
    expect(await gateway.connect(secureRow.id)).toMatchObject({
      status: "connected",
      signingIn: false,
    });
    expect(opened).toHaveLength(1);
    expect(changes).toContain(true);
    expect(changes.at(-1)).toBe(false);
  });
});

describe("add_connector requests", () => {
  function requestsWith(now = () => Date.now()) {
    const ready: Array<{ threadId: string; note: string }> = [];
    const requests = new ConnectorRequests({ db: () => testDb.current!, store, gateway, now });
    requests.onReady = (threadId, note) => ready.push({ threadId, note });
    return { requests, ready };
  }

  test("asks once per thread and target, and saves nothing until the user connects", () => {
    const { requests } = requestsWith();
    const first = requests.ask("t1", { catalog: "linear", reason: "To file the bug" });
    expect(first).toMatchObject({ status: "awaiting_user", connector: "Linear" });
    expect(Object.keys(first)[0]).toBe("request_id");
    expect(requests.ask("t1", { catalog: "linear", reason: "Again" }).request_id).toBe(
      first.request_id,
    );
    expect(requests.ask("t2", { catalog: "linear", reason: "Other thread" }).request_id).not.toBe(
      first.request_id,
    );
    expect(store.list()).toEqual([]);
    expect(requests.get([String(first.request_id)])[0]).toMatchObject({
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      reason: "To file the bug",
      state: "requested",
      connector: null,
    });

    expect(() => requests.ask("t1", { catalog: "jira", reason: "x" })).toThrow(/linear/);
    expect(() =>
      requests.ask("t1", { catalog: "linear", url: "https://x.example/mcp", reason: "x" }),
    ).toThrow(/not both/);
    expect(() => requests.ask("t1", { name: "Both", reason: "x" })).toThrow(/exactly one/);
    expect(() =>
      requests.ask("t1", { name: "Plain", url: "http://example.com/mcp", reason: "x" }),
    ).toThrow();
  });

  test("connecting a custom server stores the user's header, then reloads the thread with a note", async () => {
    const upstream = await startUpstream({ auth: false });
    cleanups.push(upstream.close);
    const { requests, ready } = requestsWith();
    const asked = requests.ask("t1", {
      name: "Echo",
      url: upstream.url.replace("127.0.0.1", "localhost"),
      header_names: ["X-Api-Key"],
      reason: "To echo",
    });
    const id = String(asked.request_id);
    expect(requests.get([id])[0]!.headerNames).toEqual(["X-Api-Key"]);

    const done = await requests.connect(id, { values: { "X-Api-Key": "k-123", Other: "no" } });
    expect(done).toMatchObject({ state: "connected", error: null });
    expect(done.connector).toMatchObject({
      name: "Echo",
      status: "connected",
      headerNames: ["X-Api-Key"],
    });
    expect(JSON.stringify(done)).not.toContain("k-123");
    expect(store.secrets(done.connector!.id).headers).toEqual({ "X-Api-Key": "k-123" });
    expect(ready).toEqual([{ threadId: "t1", note: expect.stringContaining("Echo (1 tool)") }]);

    // Asking again now says it's connected.
    expect(
      requests.ask("t1", {
        name: "Echo",
        url: upstream.url.replace("127.0.0.1", "localhost"),
        reason: "x",
      }),
    ).toMatchObject({ status: "connected", tools: 1 });
    await expect(requests.connect(id)).rejects.toThrow(/already connected/);
  });

  test("a connector that's off is turned back on rather than added twice", async () => {
    const upstream = await startUpstream({ auth: false });
    cleanups.push(upstream.close);
    const row = store.create({ name: "Echo", transport_type: "http", url: upstream.url });
    store.setEnabled(row.id, false);
    const { requests } = requestsWith();
    const asked = requests.ask("t1", { name: "Echo", url: upstream.url, reason: "x" });
    expect(requests.get([String(asked.request_id)])[0]!.connector).toMatchObject({ id: row.id });

    const done = await requests.connect(String(asked.request_id));
    expect(done.state).toBe("connected");
    expect(store.list()).toHaveLength(1);
    expect(gateway.snapshot(row.id)).toMatchObject({ enabled: true, status: "connected" });
  });

  test("a sign-in the user cancels goes back to waiting; a dead server fails with the reason", async () => {
    const secure = await startUpstream({ auth: true });
    cleanups.push(secure.close);
    const holder: { requests: ConnectorRequests | null; id: string } = { requests: null, id: "" };
    gateway.dispose();
    gateway = new ConnectorGateway({
      store,
      // The user closes the page instead of signing in.
      openExternal: () => holder.requests!.cancel(holder.id),
      stdioShimPath: async () => "/tmp/shim.mjs",
    });
    const { requests, ready } = requestsWith();
    holder.requests = requests;
    holder.id = String(
      requests.ask("t1", { name: "Secure", url: secure.url, reason: "x" }).request_id,
    );
    expect(await requests.connect(holder.id)).toMatchObject({ state: "requested", error: null });

    const dead = String(
      requests.ask("t1", { name: "Gone", url: "http://127.0.0.1:9/mcp", reason: "x" }).request_id,
    );
    const failed = await requests.connect(dead);
    expect(failed.state).toBe("failed");
    expect(failed.error).toBeTruthy();
    expect(ready).toEqual([]);
  });

  test("a card is found by id, or by thread and the connector asked for", () => {
    const { requests } = requestsWith();
    const linear = String(requests.ask("t1", { catalog: "linear", reason: "x" }).request_id);
    const custom = String(
      requests.ask("t1", { name: "Acme", url: "https://acme.example/mcp", reason: "x" }).request_id,
    );
    const local = String(
      requests.ask("t1", { name: "PG", command: "npx", args: ["-y", "pg"], reason: "x" })
        .request_id,
    );

    expect(requests.find({ id: linear })?.requestId).toBe(linear);
    expect(requests.find({ threadId: "t1", input: { catalog: "linear" } })?.requestId).toBe(linear);
    expect(
      requests.find({ threadId: "t1", input: { url: "https://acme.example/mcp" } })?.requestId,
    ).toBe(custom);
    expect(
      requests.find({ threadId: "t1", input: { command: "npx", args: ["-y", "pg"] } })?.requestId,
    ).toBe(local);
    // Another thread's request isn't this thread's card.
    expect(requests.find({ threadId: "t2", input: { catalog: "linear" } })).toBeNull();
    expect(requests.find({ threadId: "t1", input: { catalog: "notion" } })).toBeNull();
  });

  test("decline ends the card, and an unanswered one expires after a week", () => {
    let now = 1_000;
    const { requests } = requestsWith(() => now);
    const declined = String(requests.ask("t1", { catalog: "notion", reason: "x" }).request_id);
    expect(requests.decline(declined).state).toBe("declined");
    expect(() => requests.decline(declined)).toThrow(/declined/);

    const stale = String(requests.ask("t1", { catalog: "sentry", reason: "x" }).request_id);
    now += 8 * 24 * 60 * 60 * 1000;
    expect(requests.get([stale])[0]!.state).toBe("expired");
    // A new ask makes a new card.
    expect(requests.ask("t1", { catalog: "sentry", reason: "x" }).request_id).not.toBe(stale);
  });
});
