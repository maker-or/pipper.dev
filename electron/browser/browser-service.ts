import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import { McpHttpServer, type McpEndpoint, type McpToolResult } from "../mcp/mcp-http-server.ts";
import { ensureStdioProxyScript } from "../mcp/stdio-proxy.ts";
import type { BrowserConfig } from "../../contracts/acp.ts";
import { DEFAULT_BROWSER_CONFIG, readBrowserConfig, writeBrowserConfig } from "./browser-config.ts";
import type {
  BrowserPage,
  ConsoleEntry,
  DownloadRequest,
  NavigationResult,
  PageHost,
} from "./browser-page.ts";
import {
  BROWSER_TOOLS,
  ToolArgumentError,
  WIDGET_TOOLS,
  optionalBoolean,
  optionalNumber,
  optionalString,
  stringArg,
} from "./browser-tools.ts";
import { buildSnapshot } from "./snapshot.ts";
import { widgetGuide } from "../widgets/widget-guide.ts";
import { lintWidgetSource } from "../widgets/widget-lint.ts";
import type { WidgetStore } from "../widgets/widget-store.ts";
import { WidgetPreviewer } from "../widgets/widget-preview.ts";
import { withTimeout } from "./timing.ts";
import { checkUrl, normalizeUserUrl, type UrlDecision } from "./url-policy.ts";

/**
 * Headless browser pages for ACP agents, exposed as a client-hosted MCP
 * server (same per-session endpoint pattern as SubagentManager).
 *
 * Invariants:
 * - Every page belongs to exactly one session token and lives in that
 *   token's in-memory partition; sessions never share cookies or storage.
 * - Releasing a token (session closed, agent crashed, never bound) closes all
 *   of its pages and clears its partition before the endpoint disappears.
 * - Tool calls for one session run one at a time, so CDP commands from two
 *   calls never interleave on the same page.
 * - Snapshot refs are tied to the document they came from; a ref used after
 *   navigation is an error, never a click on some other element.
 */

export interface BrowserLimits {
  pagesPerSession: number;
  pagesTotal: number;
  idlePageMs: number;
  navigationTimeoutMs: number;
  toolTimeoutMs: number;
  maxPageMemoryBytes: number;
  screenshotMaxWidth: number;
  screenshotMaxBytes: number;
  unboundTokenMs: number;
  sweepIntervalMs: number;
  evalResultMaxChars: number;
  /** Extra time a timed-out call gets before its page is closed as wedged. */
  wedgedPageGraceMs: number;
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  pagesPerSession: 4,
  pagesTotal: 12,
  idlePageMs: 5 * 60_000,
  navigationTimeoutMs: 25_000,
  toolTimeoutMs: 30_000,
  maxPageMemoryBytes: 1024 * 1024 * 1024,
  screenshotMaxWidth: 1280,
  screenshotMaxBytes: 1.5 * 1024 * 1024,
  unboundTokenMs: 60_000,
  sweepIntervalMs: 30_000,
  evalResultMaxChars: 8 * 1024,
  wedgedPageGraceMs: 15_000,
};

export interface BrowserServiceOptions {
  host: PageHost;
  limits?: Partial<BrowserLimits>;
  /** Origins serving Pipper's own UI, which agents may not open. */
  appOrigins?: () => string[];
  /** Overrides the persisted `enabled` setting (tests). */
  isEnabled?: () => boolean;
  /** Where `browser.json` and the stdio shim live; defaults to userData. */
  baseDir?: string;
  /** Parent folder for per-session download folders; defaults to temp. */
  downloadsDir?: string;
  /** Where show_widget saves widgets; without one, widgets can't be shown. */
  widgetStore?: WidgetStore;
  now?: () => number;
}

/** Asks the user in the session's thread; resolves true only on approval. */
/** Lets the service attribute widgets to threads and tell the renderer. */
export interface WidgetHooks {
  resolveThread(sessionId: string): string | null;
  onWidgetUpdated(widget: { widgetId: string; threadId: string | null }): void;
}

/** Hard limit on widget source; a widget this large is a page, not a reply. */
export const MAX_WIDGET_CODE_CHARS = 512 * 1024;
/** Lint rules that make a widget unshowable, not just imperfect. */
const BLOCKING_WIDGET_RULES = new Set(["document-wrapper", "script-origin"]);

export type BrowserPermissionRequester = (request: {
  sessionId: string;
  title: string;
  detail: Record<string, unknown>;
}) => Promise<boolean>;

interface PageRecord {
  id: string;
  page: BrowserPage;
  lastUsed: number;
  refs: Map<string, number> | null;
  refGeneration: number;
}

interface SessionRecord {
  token: string;
  sessionId: string | null;
  partition: string;
  pages: Map<string, PageRecord>;
  currentPageId: string | null;
  nextPageNumber: number;
  /** Things that happened between calls (crashes, popups, idle closes). */
  notices: string[];
  queue: Promise<unknown>;
  unboundTimer: ReturnType<typeof setTimeout> | null;
  released: boolean;
}

const CONSOLE_RANK: Record<ConsoleEntry["level"], number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** Prefix of show_widget results; `src/lib/inline-widgets.ts` matches it. */
export const WIDGET_MARKER = "pipper-widget:";
export const WIDGET_UPDATED_MARKER = "pipper-widget-updated:";

export class BrowserService {
  private readonly host: PageHost;
  private readonly limits: BrowserLimits;
  private config: BrowserConfig = { ...DEFAULT_BROWSER_CONFIG };
  private requestPermission: BrowserPermissionRequester | null = null;
  private readonly downloadsDir: string | undefined;
  private readonly widgetStore: WidgetStore | null;
  private widgetHooks: WidgetHooks | null = null;
  private readonly appOrigins: () => string[];
  private readonly isEnabled: () => boolean;
  private readonly baseDir: string | undefined;
  private readonly now: () => number;
  private readonly server = new McpHttpServer({ name: "pipper-browser", version: "1.0.0" });
  private readonly sessions = new Map<string, SessionRecord>();
  private started: Promise<string> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private previewer: WidgetPreviewer | null = null;
  private disposed = false;

  constructor(options: BrowserServiceOptions) {
    this.host = options.host;
    this.limits = { ...DEFAULT_BROWSER_LIMITS, ...options.limits };
    this.appOrigins = options.appOrigins ?? (() => []);
    this.isEnabled = options.isEnabled ?? (() => this.config.enabled);
    this.baseDir = options.baseDir;
    this.downloadsDir = options.downloadsDir;
    this.widgetStore = options.widgetStore ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Load persisted settings. Safe to skip in tests; defaults apply. */
  async init(): Promise<void> {
    this.applyConfig(await readBrowserConfig(this.baseDir));
  }

  getConfig(): BrowserConfig {
    return { ...this.config };
  }

  async setConfig(partial: Partial<BrowserConfig>): Promise<BrowserConfig> {
    this.applyConfig(await writeBrowserConfig(partial, this.baseDir));
    return this.getConfig();
  }

  setWidgetHooks(hooks: WidgetHooks | null): void {
    this.widgetHooks = hooks;
  }

  /** Wire download approvals to the thread's permission prompt. */
  setPermissionRequester(requester: BrowserPermissionRequester | null): void {
    this.requestPermission = requester;
  }

  /**
   * Append the browser MCP server to a session's server list with a fresh
   * endpoint token. Callers must bindSession() once the ACP session id is
   * known; a token that is never bound is released automatically.
   */
  async attachMcpServers(
    baseServers: Array<Record<string, unknown>>,
    caps: AgentCapabilities,
  ): Promise<{ servers: Array<Record<string, unknown>>; token: string | null }> {
    if (this.disposed || !this.isEnabled()) return { servers: baseServers, token: null };

    const shimPath = await this.ensureStarted();
    const token = randomUUID();
    const record: SessionRecord = {
      token,
      sessionId: null,
      partition: `pipper-browser-${token}`,
      pages: new Map(),
      currentPageId: null,
      nextPageNumber: 1,
      notices: [],
      queue: Promise.resolve(),
      unboundTimer: null,
      released: false,
    };
    record.unboundTimer = setTimeout(() => {
      if (record.sessionId === null) void this.releaseToken(token);
    }, this.limits.unboundTokenMs);
    record.unboundTimer.unref?.();
    this.sessions.set(token, record);
    this.server.register(token, this.endpointFor(token));

    const url = this.server.urlFor(token);
    const entry: Record<string, unknown> = caps.mcpCapabilities?.http
      ? { type: "http", name: "pipper-browser", url, headers: [] }
      : {
          type: "stdio",
          name: "pipper-browser",
          command: process.execPath,
          args: [shimPath, url],
          env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }],
        };
    return { servers: [...baseServers, entry], token };
  }

  bindSession(token: string, sessionId: string): void {
    const record = this.sessions.get(token);
    if (!record) return;
    record.sessionId = sessionId;
    if (record.unboundTimer) clearTimeout(record.unboundTimer);
    record.unboundTimer = null;
  }

  /** Release the endpoint and pages owned by an ACP session after it closes. */
  releaseSessionMcp(sessionId: string): void {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) void this.releaseToken(record.token);
    }
  }

  /** Release an endpoint created for a session that was never established. */
  releaseTokenForSession(token: string): void {
    void this.releaseToken(token);
  }

  endpointCount(): number {
    return this.sessions.size;
  }

  pageCount(): number {
    let count = 0;
    for (const record of this.sessions.values()) count += record.pages.size;
    return count;
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const record of this.sessions.values()) {
      record.released = true;
      if (record.unboundTimer) clearTimeout(record.unboundTimer);
      for (const entry of record.pages.values()) entry.page.close();
      record.pages.clear();
    }
    this.sessions.clear();
    this.previewer?.dispose();
    this.previewer = null;
    this.server.close();
    this.started = null;
  }

  // ---------------------------------------------------------------------------

  private applyConfig(config: BrowserConfig): void {
    const wasEnabled = this.isEnabled();
    this.config = config;
    this.limits.pagesPerSession = config.pagesPerSession;
    this.limits.idlePageMs = config.idleMinutes * 60_000;
    if (wasEnabled && !this.isEnabled()) {
      for (const record of this.sessions.values()) {
        for (const id of record.pages.keys()) {
          record.notices.push(`Page ${id} was closed because browser tools were turned off.`);
          this.closePage(record, id);
        }
      }
    }
  }

  private requireWidgetStore(): WidgetStore {
    if (!this.widgetStore) throw new Error("Widgets can't be shown in this client.");
    return this.widgetStore;
  }

  private widgetCode(args: Record<string, unknown>): string {
    const code = stringArg(args, "widget_code");
    if (code.length > MAX_WIDGET_CODE_CHARS) {
      throw new ToolArgumentError(
        `widget_code is ${Math.round(code.length / 1024)} KB; keep widgets under ${MAX_WIDGET_CODE_CHARS / 1024} KB.`,
      );
    }
    const blocking = lintWidgetSource(code).filter((finding) =>
      BLOCKING_WIDGET_RULES.has(finding.rule),
    );
    if (blocking.length > 0) {
      throw new ToolArgumentError(
        `This widget can't be shown:\n${blocking.map((finding) => `- ${finding.message}`).join("\n")}\nFix it and check with preview_widget.`,
      );
    }
    return code;
  }

  private showWidget(record: SessionRecord, args: Record<string, unknown>): McpToolResult {
    const store = this.requireWidgetStore();
    const title = stringArg(args, "title");
    if (!/^[a-z0-9_]{3,60}$/.test(title)) {
      throw new ToolArgumentError('"title" must be 3–60 characters of a-z, 0-9 and _.');
    }
    const summary = stringArg(args, "summary").trim().slice(0, 280);
    const code = this.widgetCode(args);
    const now = this.now();
    const id = `wdg_${randomUUID().replace(/-/g, "")}`;
    store.insert({
      id,
      threadId: record.sessionId
        ? (this.widgetHooks?.resolveThread(record.sessionId) ?? null)
        : null,
      sessionId: record.sessionId,
      title,
      summary,
      code,
      createdAt: now,
      updatedAt: now,
    });
    // The marker leads the result so it survives into the tool call's
    // output preview, which is how the thread finds the widget to render.
    return textResult(
      `${WIDGET_MARKER}${id}\nThe widget is now visible in the thread. Don't describe or repeat ` +
        `its contents in text. To change it, call update_widget with widget_id "${id}".`,
    );
  }

  private updateWidget(record: SessionRecord, args: Record<string, unknown>): McpToolResult {
    const store = this.requireWidgetStore();
    const id = stringArg(args, "widget_id").trim();
    const existing = store.get(id);
    const threadId = record.sessionId
      ? (this.widgetHooks?.resolveThread(record.sessionId) ?? null)
      : null;
    const sameOwner =
      existing &&
      ((existing.sessionId !== null && existing.sessionId === record.sessionId) ||
        (existing.threadId !== null && existing.threadId === threadId));
    if (!existing || !sameOwner) {
      throw new ToolArgumentError(`No widget ${id} in this thread. Use show_widget to create one.`);
    }
    const code = this.widgetCode(args);
    const summary = optionalString(args, "summary")?.trim().slice(0, 280) || undefined;
    store.update(id, { code, summary, updatedAt: this.now() });
    this.widgetHooks?.onWidgetUpdated({ widgetId: id, threadId: existing.threadId });
    return textResult(
      `${WIDGET_UPDATED_MARKER}${id}\nUpdated in place; the user sees the new version.`,
    );
  }

  private widgetPreviewer(): WidgetPreviewer {
    this.previewer ??= new WidgetPreviewer({
      host: this.host,
      checkUrl: (url) => checkUrl(url, { appOrigins: this.appOrigins() }),
      downloadDir: join(this.downloadsRoot(), "widget-preview"),
      navigationTimeoutMs: this.limits.navigationTimeoutMs,
      screenshotMaxBytes: this.limits.screenshotMaxBytes,
    });
    return this.previewer;
  }

  private downloadsRoot(): string {
    return this.downloadsDir ?? join(app.getPath("temp"), "pipper-browser-downloads");
  }

  private downloadDirFor(record: SessionRecord): string {
    return join(this.downloadsRoot(), record.token);
  }

  private async approveDownload(record: SessionRecord, request: DownloadRequest): Promise<boolean> {
    const describe = `${request.filename} from ${hostOf(request.url)}`;
    if (record.released) return false;
    if (this.config.downloads === "block") {
      record.notices.push(`Download of ${describe} was blocked (downloads are off in Settings).`);
      return false;
    }
    if (!this.requestPermission || !record.sessionId) {
      record.notices.push(`Download of ${describe} was blocked: nobody can approve it.`);
      return false;
    }
    let allowed = false;
    try {
      allowed = await this.requestPermission({
        sessionId: record.sessionId,
        title: `Download ${describe}?`,
        detail: { url: request.url, filename: request.filename, bytes: request.totalBytes },
      });
    } catch {
      allowed = false;
    }
    if (!allowed) record.notices.push(`Download of ${describe} was declined.`);
    return allowed && !record.released;
  }

  private async releaseToken(token: string): Promise<void> {
    const record = this.sessions.get(token);
    if (!record) return;
    record.released = true;
    if (record.unboundTimer) clearTimeout(record.unboundTimer);
    this.sessions.delete(token);
    this.server.unregister(token);
    const hadPages = record.pages.size > 0;
    for (const entry of record.pages.values()) entry.page.close();
    record.pages.clear();
    this.stopSweepIfIdle();
    if (hadPages) {
      try {
        await this.host.clearPartition(record.partition);
      } catch {
        // in-memory partitions disappear with the process anyway
      }
    }
    // Pipper's own per-session temp folder; nothing outside it is touched.
    await rm(this.downloadDirFor(record), { recursive: true, force: true }).catch(() => undefined);
  }

  private ensureStarted(): Promise<string> {
    if (!this.started) {
      this.started = (async () => {
        await this.server.start();
        const shimPath = join(this.baseDir ?? app.getPath("userData"), "browser-stdio-proxy.mjs");
        return ensureStdioProxyScript(shimPath);
      })();
      this.started.catch(() => {
        this.started = null;
      });
    }
    return this.started;
  }

  private endpointFor(token: string): McpEndpoint {
    return {
      listTools: () => [...BROWSER_TOOLS, ...WIDGET_TOOLS],
      callTool: (name, args) => this.callTool(token, name, args),
    };
  }

  private callTool(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const record = this.sessions.get(token);
    if (!record) return Promise.resolve(errorResult("This browser session has ended."));
    const started = record.queue.then(() => this.runTool(record, name, args));
    // The next call waits for this call's real work, not just its reply: a
    // timed-out call keeps driving CDP until it settles or its page is closed.
    record.queue = started.then(
      (run) => run.settled,
      () => undefined,
    );
    return started.then((run) => run.result);
  }

  private async runTool(
    record: SessionRecord,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: McpToolResult; settled: Promise<void> }> {
    if (record.released) {
      return { result: errorResult("This browser session has ended."), settled: Promise.resolve() };
    }
    if (!this.isEnabled()) {
      return {
        result: errorResult("Browser tools are turned off in Pipper's Settings."),
        settled: Promise.resolve(),
      };
    }
    this.enforceMemoryLimits(record);
    const pageId = typeof args.page_id === "string" ? args.page_id : record.currentPageId;
    const work = this.dispatch(record, name, args);
    const settled = this.boundSettle(record, work, pageId);
    let result: McpToolResult;
    try {
      result = await withTimeout(
        work,
        this.limits.toolTimeoutMs,
        `${name} timed out after ${Math.round(this.limits.toolTimeoutMs / 1000)}s`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = errorResult(message);
    }
    return { result: withNotices(record, result), settled };
  }

  /**
   * Resolve when `work` settles. If it is still running a grace period after
   * the tool timeout, the page it was driving is treated as wedged and closed,
   * which fails its pending CDP commands and frees the session's queue.
   */
  private async boundSettle(
    record: SessionRecord,
    work: Promise<unknown>,
    pageId: string | null,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        this.limits.toolTimeoutMs + this.limits.wedgedPageGraceMs,
      );
      timer.unref?.();
    });
    const finished = work.then(
      () => true as const,
      () => true as const,
    );
    const outcome = await Promise.race([finished, deadline]);
    if (timer) clearTimeout(timer);
    if (outcome) return;
    if (pageId && record.pages.has(pageId)) {
      record.notices.push(`Page ${pageId} stopped responding and was closed.`);
      this.closePage(record, pageId);
    }
  }

  private async dispatch(
    record: SessionRecord,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    switch (name) {
      case "browser_open": {
        const url = normalizeUserUrl(stringArg(args, "url"));
        this.assertAllowed(url);
        const entry =
          optionalBoolean(args, "new_page") || !this.currentPage(record)
            ? await this.openPage(record)
            : this.requirePage(record, undefined);
        const result = await entry.page.navigate(url, this.limits.navigationTimeoutMs);
        return textResult(describeNavigation(entry.id, result));
      }
      case "browser_snapshot": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const snapshot = buildSnapshot(await entry.page.accessibilityTree(), {
          interactiveOnly: optionalBoolean(args, "interactive_only") ?? false,
        });
        entry.refs = snapshot.refs;
        entry.refGeneration = entry.page.documentGeneration();
        const { url, title } = entry.page.current();
        return textResult(
          `Page ${entry.id}: ${title || "(untitled)"}\nURL: ${url}\n\n${snapshot.text}`,
        );
      }
      case "browser_click": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const before = entry.page.current().url;
        await entry.page.click(this.resolveRef(entry, args), this.limits.navigationTimeoutMs);
        const after = entry.page.current();
        return textResult(
          after.url !== before ? `Clicked; navigated to ${after.url} (${after.title})` : "Clicked",
        );
      }
      case "browser_type": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const backendNodeId = this.resolveRef(entry, args);
        const text = typeof args.text === "string" ? args.text : stringArg(args, "text");
        await entry.page.type(backendNodeId, text, {
          clear: optionalBoolean(args, "clear") ?? true,
        });
        if (optionalBoolean(args, "submit")) {
          await entry.page.press("Enter", this.limits.navigationTimeoutMs);
          return textResult(`Typed ${text.length} characters and pressed Enter`);
        }
        return textResult(`Typed ${text.length} characters`);
      }
      case "browser_press": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const key = stringArg(args, "key");
        await entry.page.press(key, this.limits.navigationTimeoutMs);
        return textResult(`Pressed ${key}`);
      }
      case "browser_scroll": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const backendNodeId = args.ref === undefined ? undefined : this.resolveRef(entry, args);
        const position = await entry.page.scroll(
          { x: optionalNumber(args, "x") ?? 0, y: optionalNumber(args, "y") ?? 600 },
          backendNodeId,
        );
        return textResult(`Scrolled to x=${position.x}, y=${position.y}`);
      }
      case "browser_screenshot": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const backendNodeId = args.ref === undefined ? undefined : this.resolveRef(entry, args);
        const shot = await entry.page.screenshot({
          fullPage: optionalBoolean(args, "full_page") ?? false,
          backendNodeId,
          maxWidth: this.limits.screenshotMaxWidth,
          maxBytes: this.limits.screenshotMaxBytes,
        });
        return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
      }
      case "browser_console": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const level = optionalString(args, "level") ?? "all";
        const min = level === "error" ? 3 : level === "warning" ? 2 : 0;
        const lines = entry.page
          .drainConsole()
          .filter((item) => CONSOLE_RANK[item.level] >= min)
          .map((item) => {
            const where = item.source
              ? ` (${shorten(item.source, 120)}${item.line ? `:${item.line}` : ""})`
              : "";
            return `[${item.level}] ${item.message}${where}`;
          });
        return textResult(lines.length > 0 ? lines.join("\n") : "No console messages");
      }
      case "browser_network": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const failedOnly = optionalBoolean(args, "failed_only") ?? false;
        const lines = entry.page
          .drainNetwork()
          .filter((item) => !failedOnly || item.failed || (item.status ?? 0) >= 400)
          .map(
            (item) =>
              `${item.method} ${item.status ?? "---"} ${item.resourceType} ${shorten(item.url, 200)}${item.failed ? ` (failed: ${item.failed})` : ""}`,
          );
        return textResult(lines.length > 0 ? lines.join("\n") : "No requests");
      }
      case "browser_eval": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const value = await entry.page.evaluate(stringArg(args, "expression"));
        let text: string;
        try {
          text = JSON.stringify(value, null, 2) ?? "undefined";
        } catch {
          text = String(value);
        }
        const max = this.limits.evalResultMaxChars;
        return textResult(text.length > max ? `${text.slice(0, max)}\n… truncated` : text);
      }
      case "browser_back":
      case "browser_forward":
      case "browser_reload": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        const action = name.slice("browser_".length) as "back" | "forward" | "reload";
        const result = await entry.page.history(action, this.limits.navigationTimeoutMs);
        return textResult(describeNavigation(entry.id, result));
      }
      case "browser_pages": {
        if (record.pages.size === 0) return textResult("No open pages");
        const lines = [...record.pages.values()].map((entry) => {
          const { url, title } = entry.page.current();
          const marker = entry.id === record.currentPageId ? " (current)" : "";
          return `${entry.id}${marker}: ${title || "(untitled)"} ${url}`;
        });
        return textResult(lines.join("\n"));
      }
      case "browser_close": {
        const entry = this.requirePage(record, optionalString(args, "page_id"));
        this.closePage(record, entry.id);
        return textResult(`Closed ${entry.id}`);
      }
      case "widget_guide": {
        const modules = Array.isArray(args.modules)
          ? args.modules.filter((item): item is string => typeof item === "string")
          : [];
        return textResult(widgetGuide(modules));
      }
      case "preview_widget": {
        const code = stringArg(args, "widget_code");
        return this.widgetPreviewer().preview(code, optionalNumber(args, "width"));
      }
      case "show_widget":
        return this.showWidget(record, args);
      case "update_widget":
        return this.updateWidget(record, args);
      default:
        throw new ToolArgumentError(`Unknown browser tool: ${name}`);
    }
  }

  private assertAllowed(url: string): void {
    const decision: UrlDecision = checkUrl(url, { appOrigins: this.appOrigins() });
    if (!decision.allowed) throw new Error(decision.reason);
  }

  private currentPage(record: SessionRecord): PageRecord | null {
    return record.currentPageId ? (record.pages.get(record.currentPageId) ?? null) : null;
  }

  private requirePage(record: SessionRecord, pageId: string | undefined): PageRecord {
    const entry = pageId ? record.pages.get(pageId) : this.currentPage(record);
    if (!entry) {
      throw new ToolArgumentError(
        pageId
          ? `No page ${pageId}. Call browser_pages to see open pages.`
          : "No page is open. Call browser_open first.",
      );
    }
    entry.lastUsed = this.now();
    record.currentPageId = entry.id;
    return entry;
  }

  private resolveRef(entry: PageRecord, args: Record<string, unknown>): number {
    const ref = stringArg(args, "ref").replace(/^@/, "");
    if (!entry.refs) throw new ToolArgumentError("Take a browser_snapshot first to get refs.");
    if (entry.refGeneration !== entry.page.documentGeneration()) {
      throw new ToolArgumentError(
        `Ref ${ref} is from a previous page; take a new browser_snapshot.`,
      );
    }
    const backendNodeId = entry.refs.get(ref);
    if (backendNodeId == null) {
      throw new ToolArgumentError(`No element ${ref} in the latest snapshot.`);
    }
    return backendNodeId;
  }

  private async openPage(record: SessionRecord): Promise<PageRecord> {
    if (record.pages.size >= this.limits.pagesPerSession) {
      throw new Error(
        `This session already has ${this.limits.pagesPerSession} pages open. Close one with browser_close.`,
      );
    }
    if (this.pageCount() >= this.limits.pagesTotal) {
      throw new Error(
        `Pipper's browser is at its limit of ${this.limits.pagesTotal} pages across all sessions. Close a page and try again.`,
      );
    }
    const id = `p${record.nextPageNumber++}`;
    const appOrigins = this.appOrigins();
    const page = await this.host.createPage({
      partition: record.partition,
      downloadDir: this.downloadDirFor(record),
      checkUrl: (url) => checkUrl(url, { appOrigins }),
      events: {
        onCrash: (reason) => {
          if (!record.pages.has(id)) return;
          record.notices.push(`Page ${id} crashed (${reason}) and was closed.`);
          this.closePage(record, id);
        },
        onPopup: (url) => void this.openPopup(record, id, url),
        onDownload: (request) => this.approveDownload(record, request),
        onDownloadFinished: (result) => {
          record.notices.push(
            result.state === "completed"
              ? `Downloaded ${result.url} to ${result.path}`
              : `Download of ${result.url} ${result.state === "cancelled" ? "was cancelled" : "failed"}.`,
          );
        },
        onClosed: () => {
          if (record.pages.delete(id)) {
            if (record.currentPageId === id) record.currentPageId = null;
            this.stopSweepIfIdle();
          }
        },
      },
    });
    if (record.released) {
      page.close();
      throw new Error("This browser session has ended.");
    }
    const entry: PageRecord = { id, page, lastUsed: this.now(), refs: null, refGeneration: -1 };
    record.pages.set(id, entry);
    record.currentPageId = id;
    this.startSweep();
    return entry;
  }

  private async openPopup(record: SessionRecord, openerId: string, url: string): Promise<void> {
    if (record.released) return;
    const decision = checkUrl(url, { appOrigins: this.appOrigins() });
    if (!decision.allowed) {
      record.notices.push(`Page ${openerId} tried to open ${url}; blocked: ${decision.reason}.`);
      return;
    }
    try {
      const entry = await this.openPage(record);
      record.notices.push(`Page ${openerId} opened ${url} as ${entry.id}; it is now current.`);
      await entry.page.navigate(url, this.limits.navigationTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.notices.push(`Page ${openerId} tried to open ${url}: ${message}`);
    }
  }

  private closePage(record: SessionRecord, id: string): void {
    const entry = record.pages.get(id);
    if (!entry) return;
    record.pages.delete(id);
    if (record.currentPageId === id) {
      const remaining = [...record.pages.keys()];
      record.currentPageId = remaining.at(-1) ?? null;
    }
    entry.page.close();
    this.stopSweepIfIdle();
  }

  private enforceMemoryLimits(record: SessionRecord): void {
    for (const entry of record.pages.values()) {
      const bytes = entry.page.memoryBytes();
      if (bytes != null && bytes > this.limits.maxPageMemoryBytes) {
        record.notices.push(
          `Page ${entry.id} used ${Math.round(bytes / 1024 / 1024)} MB and was closed.`,
        );
        this.closePage(record, entry.id);
      }
    }
  }

  private sweep(): void {
    const cutoff = this.now() - this.limits.idlePageMs;
    for (const record of this.sessions.values()) {
      for (const entry of record.pages.values()) {
        if (entry.lastUsed < cutoff) {
          record.notices.push(`Page ${entry.id} was idle and was closed.`);
          this.closePage(record, entry.id);
        }
      }
      this.enforceMemoryLimits(record);
    }
  }

  private startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.limits.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private stopSweepIfIdle(): void {
    if (this.sweepTimer && this.pageCount() === 0) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Test hook: run the idle and memory sweep now. */
  sweepNow(): void {
    this.sweep();
  }
}

function describeNavigation(pageId: string, result: NavigationResult): string {
  const status = result.status == null ? "" : `\nStatus: ${result.status}`;
  return `Page ${pageId}: ${result.title || "(untitled)"}\nURL: ${result.url}${status}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function withNotices(record: SessionRecord, result: McpToolResult): McpToolResult {
  if (record.notices.length === 0) return result;
  const notices = record.notices.splice(0).map((notice) => `Note: ${notice}`);
  return { ...result, content: [...result.content, { type: "text", text: notices.join("\n") }] };
}
