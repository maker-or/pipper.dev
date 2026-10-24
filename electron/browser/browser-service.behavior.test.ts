import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => "/nonexistent-userdata" },
}));

import type {
  AxNode,
  BrowserPage,
  NavigationResult,
  PageEvents,
  PageHost,
} from "./browser-page.ts";
import { BrowserService, type BrowserLimits } from "./browser-service.ts";
import type { UrlDecision } from "./url-policy.ts";

/**
 * Scripted page: navigation bumps the document generation, the a11y tree is
 * a heading plus one button, and clicks are recorded by backend node id.
 */
class FakePage implements BrowserPage {
  closed = false;
  url = "about:blank";
  generation = 0;
  clicks: number[] = [];
  readonly partition: string;
  readonly events: PageEvents;
  readonly checkUrl: (url: string) => UrlDecision;
  private consoleLog: Array<{ level: "error"; message: string }> = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(options: {
    partition: string;
    events: PageEvents;
    checkUrl: (url: string) => UrlDecision;
  }) {
    this.partition = options.partition;
    this.events = options.events;
    this.checkUrl = options.checkUrl;
  }

  async navigate(url: string): Promise<NavigationResult> {
    // A page that never answers, like a wedged renderer.
    if (url.includes("hang")) return new Promise(() => undefined);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight--;
    this.url = url;
    this.generation++;
    return this.current();
  }
  async history(): Promise<NavigationResult> {
    this.generation++;
    return this.current();
  }
  current(): NavigationResult {
    return { url: this.url, title: `Title of ${this.url}`, status: 200 };
  }
  async accessibilityTree(): Promise<AxNode[]> {
    return [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "heading" },
        name: { value: "Welcome" },
        backendDOMNodeId: 10,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { value: "button" },
        name: { value: "Buy" },
        backendDOMNodeId: 20,
      },
    ];
  }
  async click(backendNodeId: number): Promise<void> {
    this.clicks.push(backendNodeId);
  }
  async type(): Promise<void> {}
  async press(): Promise<void> {}
  async scroll(): Promise<{ x: number; y: number }> {
    return { x: 0, y: 600 };
  }
  async screenshot() {
    return { data: "cG5n", mimeType: "image/png" as const };
  }
  async evaluate(): Promise<unknown> {
    return { ok: true };
  }
  drainConsole() {
    return this.consoleLog.splice(0);
  }
  drainNetwork() {
    return [];
  }
  memoryBytes(): number | null {
    return 1024;
  }
  documentGeneration(): number {
    return this.generation;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClosed();
  }
  logError(message: string): void {
    this.consoleLog.push({ level: "error", message });
  }
}

class FakeHost implements PageHost {
  pages: FakePage[] = [];
  cleared: string[] = [];
  async createPage(options: {
    partition: string;
    checkUrl: (url: string) => UrlDecision;
    events: PageEvents;
  }): Promise<BrowserPage> {
    const page = new FakePage(options);
    this.pages.push(page);
    return page;
  }
  async clearPartition(partition: string): Promise<void> {
    this.cleared.push(partition);
  }
}

type ToolCall = { text: string; isError: boolean; content: Array<Record<string, unknown>> };

async function setup(options: { limits?: Partial<BrowserLimits>; http?: boolean } = {}) {
  const host = new FakeHost();
  const service = new BrowserService({
    host,
    limits: options.limits,
    appOrigins: () => ["http://localhost:5173"],
    baseDir: await mkdtemp(join(tmpdir(), "pipper-browser-test-")),
    downloadsDir: await mkdtemp(join(tmpdir(), "pipper-browser-downloads-")),
  });
  services.push(service);
  return { host, service };
}

async function openSession(service: BrowserService, sessionId: string, http = true) {
  const attached = await service.attachMcpServers([], {
    mcpCapabilities: http ? { http: true } : {},
  });
  if (!attached.token) throw new Error("expected a token");
  service.bindSession(attached.token, sessionId);
  const entry = attached.servers[0] as { url?: string; args?: string[]; type: string };
  const url = entry.url ?? entry.args?.[1] ?? "";
  let id = 1;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCall> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const json = (await res.json()) as {
      result: { content: Array<Record<string, unknown>>; isError?: boolean };
    };
    const text = json.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return { text, isError: json.result.isError === true, content: json.result.content };
  };
  return { url, entry, call, token: attached.token };
}

const services: BrowserService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

describe("agent browser service", () => {
  test("an agent can open a page, read it and act on refs", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");

    const opened = await call("browser_open", { url: "example.com" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toContain("Page p1");
    expect(opened.text).toContain("https://example.com");

    const snapshot = await call("browser_snapshot");
    expect(snapshot.text).toContain('- heading "Welcome" [ref=');
    expect(snapshot.text).toMatch(/button "Buy" \[ref=(e\d+)\]/);
    const ref = /button "Buy" \[ref=(e\d+)\]/.exec(snapshot.text)![1];

    const clicked = await call("browser_click", { ref });
    expect(clicked.isError).toBe(false);
    expect(host.pages[0].clicks).toEqual([20]);

    const shot = await call("browser_screenshot");
    expect(shot.content[0]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
  });

  test("closing a session closes its pages, clears its storage and retires its endpoint", async () => {
    const { host, service } = await setup();
    const { call, url } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    await call("browser_open", { url: "https://b.test", new_page: true });
    expect(service.pageCount()).toBe(2);

    service.releaseSessionMcp("s1");
    await vi.waitFor(() => expect(host.cleared).toHaveLength(1));

    expect(host.pages.every((page) => page.closed)).toBe(true);
    expect(service.pageCount()).toBe(0);
    expect(service.endpointCount()).toBe(0);
    const gone = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(gone.status).toBe(404);
  });

  test("sessions never share a storage partition", async () => {
    const { host, service } = await setup();
    const one = await openSession(service, "s1");
    const two = await openSession(service, "s2");
    await one.call("browser_open", { url: "https://a.test" });
    await two.call("browser_open", { url: "https://a.test" });
    expect(host.pages).toHaveLength(2);
    expect(host.pages[0].partition).not.toBe(host.pages[1].partition);
    expect(host.pages[0].partition.startsWith("persist:")).toBe(false);
  });

  test("blocked URLs are refused before any page loads them, including popups", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");

    for (const url of [
      "file:///etc/hosts",
      "http://localhost:5173/settings.html",
      "chrome://gpu",
    ]) {
      const result = await call("browser_open", { url });
      expect(result.isError).toBe(true);
    }
    expect(host.pages).toHaveLength(0);

    // Agents may still test their own dev servers on other localhost ports.
    const dev = await call("browser_open", { url: "localhost:3000" });
    expect(dev.isError).toBe(false);
    expect(host.pages[0].checkUrl("file:///etc/hosts").allowed).toBe(false);

    host.pages[0].events.onPopup("file:///etc/passwd");
    const next = await call("browser_pages");
    expect(next.text).toContain("blocked");
    expect(host.pages).toHaveLength(1);
  });

  test("hitting the page limit returns an actionable error and keeps existing pages working", async () => {
    const { service } = await setup({ limits: { pagesPerSession: 2 } });
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    await call("browser_open", { url: "https://b.test", new_page: true });

    const third = await call("browser_open", { url: "https://c.test", new_page: true });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("browser_close");

    const snapshot = await call("browser_snapshot", { page_id: "p1" });
    expect(snapshot.isError).toBe(false);
  });

  test("the limit across all sessions is enforced too", async () => {
    const { service } = await setup({ limits: { pagesTotal: 1 } });
    const one = await openSession(service, "s1");
    const two = await openSession(service, "s2");
    await one.call("browser_open", { url: "https://a.test" });
    const refused = await two.call("browser_open", { url: "https://a.test" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("limit");
  });

  test("a ref from before a navigation is rejected instead of clicking something else", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    const snapshot = await call("browser_snapshot");
    const ref = /button "Buy" \[ref=(e\d+)\]/.exec(snapshot.text)![1];

    await call("browser_open", { url: "https://b.test" });
    const stale = await call("browser_click", { ref });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("browser_snapshot");

    const unknown = await call("browser_click", { ref: "e999" });
    expect(unknown.isError).toBe(true);
    expect(host.pages[0].clicks).toEqual([]);
  });

  test("a crashed page is dropped and the agent is told on its next call", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    host.pages[0].events.onCrash("oom");

    const next = await call("browser_snapshot");
    expect(next.isError).toBe(true);
    expect(next.text).toContain("crashed (oom)");
    expect(service.pageCount()).toBe(0);

    const reopened = await call("browser_open", { url: "https://a.test" });
    expect(reopened.isError).toBe(false);
  });

  test("tool calls from one session run one at a time", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    await Promise.all([
      call("browser_open", { url: "https://b.test" }),
      call("browser_open", { url: "https://c.test" }),
      call("browser_open", { url: "https://d.test" }),
    ]);
    expect(host.pages[0].maxInFlight).toBe(1);
  });

  test("pages idle past the timeout are closed", async () => {
    let now = 1_000;
    const host = new FakeHost();
    const service = new BrowserService({
      host,
      limits: { idlePageMs: 100 },
      baseDir: await mkdtemp(join(tmpdir(), "pipper-browser-test-")),
      now: () => now,
    });
    services.push(service);
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });

    now += 101;
    service.sweepNow();
    expect(service.pageCount()).toBe(0);
    const next = await call("browser_pages");
    expect(next.text).toContain("idle");
  });

  test("a token that never gets a session is released", async () => {
    const { service } = await setup({ limits: { unboundTokenMs: 20 } });
    await service.attachMcpServers([], { mcpCapabilities: { http: true } });
    expect(service.endpointCount()).toBe(1);
    await vi.waitFor(() => expect(service.endpointCount()).toBe(0));
  });

  test("agents without HTTP MCP get the same tools through the stdio shim", async () => {
    const { service } = await setup();
    const { entry, call } = await openSession(service, "s1", false);
    expect(entry.type).toBe("stdio");
    expect(entry.args?.[0]).toMatch(/browser-stdio-proxy\.mjs$/);
    const result = await call("browser_open", { url: "https://a.test" });
    expect(result.isError).toBe(false);
  });

  test("console output is returned once and filtered by level", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });
    host.pages[0].logError("Uncaught TypeError: x is undefined");

    const first = await call("browser_console", { level: "error" });
    expect(first.text).toContain("[error] Uncaught TypeError");
    const second = await call("browser_console");
    expect(second.text).toBe("No console messages");
  });

  test("a disabled service attaches nothing", async () => {
    const service = new BrowserService({ host: new FakeHost(), isEnabled: () => false });
    services.push(service);
    const attached = await service.attachMcpServers([{ name: "user" }], {
      mcpCapabilities: { http: true },
    });
    expect(attached.token).toBeNull();
    expect(attached.servers).toEqual([{ name: "user" }]);
  });

  test("a timed-out call holds the queue until its page is closed as wedged", async () => {
    const { host, service } = await setup({
      limits: { toolTimeoutMs: 40, wedgedPageGraceMs: 40 },
    });
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });

    const stuck = call("browser_open", { url: "https://hang.test" });
    const next = call("browser_pages");
    const stuckResult = await stuck;
    expect(stuckResult.isError).toBe(true);
    expect(stuckResult.text).toContain("timed out");

    const nextResult = await next;
    expect(host.pages[0].closed).toBe(true);
    expect(nextResult.text).toContain("stopped responding");
  });

  test("turning the browser off closes pages and refuses further calls", async () => {
    const { host, service } = await setup();
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://a.test" });

    await service.setConfig({ enabled: false });
    expect(host.pages[0].closed).toBe(true);
    const refused = await call("browser_open", { url: "https://a.test" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("turned off");
    const attached = await service.attachMcpServers([], { mcpCapabilities: { http: true } });
    expect(attached.token).toBeNull();

    await service.setConfig({ enabled: true });
    expect((await call("browser_open", { url: "https://a.test" })).isError).toBe(false);
  });

  test("settings change the page limit and survive a restart", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "pipper-browser-test-"));
    const first = new BrowserService({ host: new FakeHost(), baseDir });
    services.push(first);
    await first.setConfig({ pagesPerSession: 1, idleMinutes: 999 });

    const second = new BrowserService({ host: new FakeHost(), baseDir });
    services.push(second);
    await second.init();
    expect(second.getConfig()).toMatchObject({ pagesPerSession: 1, idleMinutes: 60 });
    const { call } = await openSession(second, "s1");
    await call("browser_open", { url: "https://a.test" });
    const refused = await call("browser_open", { url: "https://b.test", new_page: true });
    expect(refused.isError).toBe(true);
  });

  test("downloads wait for the user's answer in the thread", async () => {
    const { host, service } = await setup();
    const asked: Array<{ sessionId: string; title: string }> = [];
    let answer = false;
    service.setPermissionRequester(async (request) => {
      asked.push(request);
      return answer;
    });
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://files.test" });
    const request = {
      url: "https://files.test/report.pdf",
      filename: "report.pdf",
      totalBytes: 10,
    };

    expect(await host.pages[0].events.onDownload(request)).toBe(false);
    expect(asked[0]).toMatchObject({ sessionId: "s1" });
    expect(asked[0].title).toContain("report.pdf");
    expect((await call("browser_pages")).text).toContain("declined");

    answer = true;
    expect(await host.pages[0].events.onDownload(request)).toBe(true);
    host.pages[0].events.onDownloadFinished({
      url: request.url,
      path: "/downloads/report.pdf",
      state: "completed",
    });
    expect((await call("browser_pages")).text).toContain(
      "Downloaded https://files.test/report.pdf to /downloads/report.pdf",
    );
  });

  test("downloads are blocked without asking when turned off", async () => {
    const { host, service } = await setup();
    const requester = vi.fn(async () => true);
    service.setPermissionRequester(requester);
    await service.setConfig({ downloads: "block" });
    const { call } = await openSession(service, "s1");
    await call("browser_open", { url: "https://files.test" });

    const allowed = await host.pages[0].events.onDownload({
      url: "https://files.test/a.zip",
      filename: "a.zip",
      totalBytes: 0,
    });
    expect(allowed).toBe(false);
    expect(requester).not.toHaveBeenCalled();
    expect((await call("browser_pages")).text).toContain("blocked");
  });

  test("the widget guide always includes core and serves requested modules", async () => {
    const { service } = await setup();
    const { call } = await openSession(service, "s1");
    const guide = await call("widget_guide", { modules: ["chart"] });
    expect(guide.isError).toBe(false);
    expect(guide.text).toMatch(/^# core/);
    expect(guide.text).toContain("# chart");
    expect(guide.text).not.toContain("# diagram");
    expect(guide.text).toContain(".ff-card");
  });
});
