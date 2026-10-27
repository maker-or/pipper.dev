import { afterEach, describe, expect, test } from "vitest";
import { McpHttpServer, type McpEndpoint } from "./mcp-http-server.ts";

const endpoint: McpEndpoint = {
  listTools: () => [
    {
      name: "spawn_subagent",
      description: "spawn",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  callTool: async (name, args) => {
    if (name === "boom") throw new Error("exploded");
    return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
  },
};

async function rpc(url: string, body: unknown): Promise<{ status: number; json: any | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("client-hosted MCP http server", () => {
  const server = new McpHttpServer();

  afterEach(() => server.close());

  test("speaks enough MCP for an agent to discover and call tools", async () => {
    await server.start();
    server.register("tok1", endpoint);
    const url = server.urlFor("tok1");

    const init = await rpc(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.protocolVersion).toBe("2025-06-18");
    expect(init.json.result.serverInfo.name).toBe("pipper-subagents");
    expect(init.json.result.instructions).toBeUndefined();
    expect(init.json.result.capabilities.tools).toBeDefined();

    // initialized notification is acknowledged without a body
    const notified = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBe(202);

    const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((t: any) => t.name)).toEqual(["spawn_subagent"]);

    const call = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { a: 1 } },
    });
    expect(call.json.result.content[0].text).toBe('echo:{"a":1}');
    expect(call.json.result.isError).toBeUndefined();
  });

  test("tool errors surface as isError results, not protocol failures", async () => {
    await server.start();
    server.register("tok1", endpoint);
    const call = await rpc(server.urlFor("tok1"), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    expect(call.status).toBe(200);
    expect(call.json.result.isError).toBe(true);
    expect(call.json.result.content[0].text).toContain("exploded");
  });

  test("unknown tokens 404 and unregistered tokens stop resolving", async () => {
    await server.start();
    server.register("tok1", endpoint);
    const bad = await rpc(`http://127.0.0.1:${new URL(server.urlFor("tok1")).port}/mcp/other`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(bad.status).toBe(404);

    server.unregister("tok1");
    const gone = await rpc(server.urlFor("tok1"), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(gone.status).toBe(404);
  });

  test("unknown methods return JSON-RPC method-not-found", async () => {
    await server.start();
    server.register("tok1", endpoint);
    const res = await rpc(server.urlFor("tok1"), {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    });
    expect(res.json.error.code).toBe(-32601);
  });

  test("each instance identifies itself and passes image results through", async () => {
    const browser = new McpHttpServer({
      name: "pipper-browser",
      version: "1.0.0",
      instructions: "Use show_widget for visuals.",
    });
    try {
      await browser.start();
      browser.register("tok1", {
        listTools: () => [],
        callTool: async () => ({
          content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
        }),
      });
      const url = browser.urlFor("tok1");
      const init = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(init.json.result.serverInfo).toEqual({ name: "pipper-browser", version: "1.0.0" });
      expect(init.json.result.instructions).toBe("Use show_widget for visuals.");
      const call = await rpc(url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_screenshot", arguments: {} },
      });
      expect(call.json.result.content[0]).toEqual({
        type: "image",
        data: "aGk=",
        mimeType: "image/png",
      });
    } finally {
      browser.close();
    }
  });
});
