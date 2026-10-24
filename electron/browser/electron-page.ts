import { mkdirSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  app,
  BrowserWindow,
  nativeImage,
  session,
  type DownloadItem,
  type WebContents,
} from "electron";
import type {
  AxNode,
  BrowserPage,
  ConsoleEntry,
  NavigationResult,
  NetworkEntry,
  PageEvents,
  PageHost,
  Screenshot,
  ScreenshotOptions,
} from "./browser-page.ts";
import { parseKey } from "./keys.ts";
import { delay, withTimeout } from "./timing.ts";
import type { UrlDecision } from "./url-policy.ts";

/**
 * BrowserPage backed by a hidden BrowserWindow. CDP goes through
 * `webContents.debugger`, so no remote debugging port is ever opened.
 */

const VIEWPORT = { width: 1280, height: 800 };
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 500;
const SETTLE_POLL_MS = 60;

/** Pages by webContents id, so session-level events can find their page. */
const pagesByContents = new Map<number, ElectronBrowserPage>();
/** Hidden agent windows, which must not count as open app windows. */
const agentWindows = new WeakSet<BrowserWindow>();

/** True for the hidden windows that back agent browser pages. */
export function isAgentBrowserWindow(window: BrowserWindow): boolean {
  return agentWindows.has(window);
}
const configuredPartitions = new Set<string>();

function configurePartition(partition: string, checkUrl: (url: string) => UrlDecision): void {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Covers navigations, redirects, popups and subresources in one place.
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !checkUrl(details.url).allowed });
  });
  ses.on("will-download", (_event, item, contents) => {
    const page = pagesByContents.get(contents.id);
    if (!page) {
      item.cancel();
      return;
    }
    page.handleDownload(item);
  });
}

export const electronPageHost: PageHost = {
  async createPage({ partition, checkUrl, events, downloadDir }) {
    configurePartition(partition, checkUrl);
    const page = new ElectronBrowserPage(partition, events, downloadDir);
    await page.attach();
    return page;
  },
  async clearPartition(partition) {
    configuredPartitions.delete(partition);
    const ses = session.fromPartition(partition);
    ses.webRequest.onBeforeRequest(null);
    // Only cookies and cache: clearing DOM storage on an in-memory partition
    // blocks Electron's main thread indefinitely (seen on Electron 42). The
    // partition name is unique per session token and never reused, so
    // leftover DOM storage is unreachable and goes away when Pipper quits.
    await ses.clearStorageData({ storages: ["cookies"] });
    await ses.clearCache();
  },
};

type CdpParams = Record<string, unknown>;

class ElectronBrowserPage implements BrowserPage {
  private readonly window: BrowserWindow;
  private readonly contents: WebContents;
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly networkEntries: Array<NetworkEntry & { requestId: string }> = [];
  private readonly networkById = new Map<string, NetworkEntry & { requestId: string }>();
  private generation = 0;
  private lastStatus: number | null = null;
  private isClosed = false;
  private hasNavigated = false;

  private readonly events: PageEvents;
  private readonly downloadDir: string;

  constructor(partition: string, events: PageEvents, downloadDir: string) {
    this.events = events;
    this.downloadDir = downloadDir;
    this.window = new BrowserWindow({
      show: false,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    agentWindows.add(this.window);
    this.contents = this.window.webContents;
    pagesByContents.set(this.contents.id, this);

    this.contents.setWindowOpenHandler(({ url }) => {
      this.events.onPopup(url);
      return { action: "deny" };
    });
    this.contents.on("console-message", (event) => {
      // Electron's own dev-mode security warnings aren't the page's output.
      if (event.sourceId.startsWith("node:electron/")) return;
      this.pushConsole({
        level: event.level,
        message: event.message,
        source: event.sourceId || undefined,
        line: event.lineNumber || undefined,
      });
    });
    this.contents.on("did-navigate", (_event, _url, httpResponseCode) => {
      this.generation++;
      this.lastStatus = httpResponseCode > 0 ? httpResponseCode : null;
    });
    this.contents.on("render-process-gone", (_event, details) => {
      this.events.onCrash(details.reason);
    });
    this.window.on("closed", () => {
      this.isClosed = true;
      pagesByContents.delete(this.contents.id);
      this.events.onClosed();
    });
  }

  get closed(): boolean {
    return this.isClosed || this.window.isDestroyed();
  }

  async attach(): Promise<void> {
    // A window that has never loaded has no renderer yet, and CDP commands
    // sent to it wait forever. Give it a document first.
    await this.contents.loadURL("about:blank");
    this.contents.debugger.attach("1.3");
    this.contents.debugger.on("message", (_event, method, params) =>
      this.onCdpEvent(method, params as CdpParams),
    );
    await this.cdp("Page.enable");
    await this.cdp("DOM.enable");
    await this.cdp("Network.enable");
    await this.cdp("Accessibility.enable");
  }

  async navigate(url: string, timeoutMs: number): Promise<NavigationResult> {
    this.lastStatus = null;
    const first = !this.hasNavigated;
    await withTimeout(
      this.contents.loadURL(url).catch((error: unknown) => {
        throw new Error(describeLoadError(error, url));
      }),
      timeoutMs,
      `Navigation to ${url} timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    if (first) {
      // Drop the internal about:blank so browser_back can't land on it.
      this.hasNavigated = true;
      this.contents.navigationHistory.clear();
    }
    return this.current();
  }

  async history(
    action: "back" | "forward" | "reload",
    timeoutMs: number,
  ): Promise<NavigationResult> {
    const history = this.contents.navigationHistory;
    if (action === "back") {
      if (!history.canGoBack()) throw new Error("No earlier page in this tab's history");
      history.goBack();
    } else if (action === "forward") {
      if (!history.canGoForward()) throw new Error("No later page in this tab's history");
      history.goForward();
    } else {
      this.contents.reload();
    }
    await this.settle(timeoutMs);
    return this.current();
  }

  current(): NavigationResult {
    return {
      url: this.contents.getURL(),
      title: this.contents.getTitle(),
      status: this.lastStatus,
    };
  }

  async accessibilityTree(): Promise<AxNode[]> {
    const result = (await this.cdp("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
    return result.nodes ?? [];
  }

  async click(backendNodeId: number, timeoutMs: number): Promise<void> {
    const point = await this.centerOf(backendNodeId);
    await this.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none" });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
    await this.settle(timeoutMs);
  }

  async type(backendNodeId: number, text: string, options: { clear: boolean }): Promise<void> {
    await this.cdp("DOM.focus", { backendNodeId });
    if (options.clear) {
      // Select instead of assigning `value`, so frameworks that track input
      // events (React controlled inputs) see a normal replacement.
      await this.callOn(
        backendNodeId,
        `function () {
          if (typeof this.select === "function") this.select();
          else if (this.isContentEditable) document.execCommand("selectAll");
        }`,
      );
    }
    await this.cdp("Input.insertText", { text });
  }

  async press(key: string, timeoutMs: number): Promise<void> {
    const parsed = parseKey(key);
    const base = {
      modifiers: parsed.modifiers,
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.keyCode,
    };
    await this.cdp("Input.dispatchKeyEvent", {
      type: parsed.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}),
    });
    await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.settle(timeoutMs);
  }

  async scroll(
    delta: { x: number; y: number },
    backendNodeId?: number,
  ): Promise<{ x: number; y: number }> {
    if (backendNodeId != null) {
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } else {
      await this.evaluate(`window.scrollBy(${Number(delta.x) || 0}, ${Number(delta.y) || 0})`);
    }
    const position = (await this.evaluate("[window.scrollX, window.scrollY]")) as number[];
    return { x: Math.round(position[0] ?? 0), y: Math.round(position[1] ?? 0) };
  }

  async screenshot(options: ScreenshotOptions): Promise<Screenshot> {
    const params: CdpParams = { format: "png", captureBeyondViewport: Boolean(options.fullPage) };
    if (options.clip) {
      params.clip = { ...options.clip, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (options.backendNodeId != null) {
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: options.backendNodeId });
      const box = await this.boxOf(options.backendNodeId);
      const metrics = (await this.cdp("Page.getLayoutMetrics")) as {
        cssLayoutViewport?: { pageX: number; pageY: number };
      };
      const scroll = metrics.cssLayoutViewport ?? { pageX: 0, pageY: 0 };
      params.clip = {
        x: box.x + scroll.pageX,
        y: box.y + scroll.pageY,
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
        scale: 1,
      };
      params.captureBeyondViewport = true;
    }
    const result = (await this.cdp("Page.captureScreenshot", params)) as { data: string };
    let image = nativeImage.createFromBuffer(Buffer.from(result.data, "base64"));
    if (image.getSize().width > options.maxWidth) {
      image = image.resize({ width: options.maxWidth, quality: "good" });
    }
    const png = image.toPNG();
    if (png.length <= options.maxBytes)
      return { data: png.toString("base64"), mimeType: "image/png" };
    return { data: image.toJPEG(70).toString("base64"), mimeType: "image/jpeg" };
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description ?? details.text ?? "evaluation failed");
    }
    return result.result?.value ?? result.result?.description ?? null;
  }

  drainConsole(): ConsoleEntry[] {
    return this.consoleEntries.splice(0);
  }

  drainNetwork(): NetworkEntry[] {
    const drained = this.networkEntries.splice(0);
    for (const entry of drained) this.networkById.delete(entry.requestId);
    return drained.map(({ requestId: _requestId, ...entry }) => entry);
  }

  memoryBytes(): number | null {
    if (this.closed) return null;
    const pid = this.contents.getOSProcessId();
    const metric = app.getAppMetrics().find((candidate) => candidate.pid === pid);
    return metric ? metric.memory.workingSetSize * 1024 : null;
  }

  documentGeneration(): number {
    return this.generation;
  }

  close(): void {
    if (this.window.isDestroyed()) return;
    try {
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
    } catch {
      // the renderer may already be gone
    }
    this.window.destroy();
  }

  /**
   * Called synchronously from `will-download`. The save path must be set
   * before the handler returns (or Electron shows a save dialog), so the
   * item is pointed at the session's folder and paused until approved.
   */
  handleDownload(item: DownloadItem): void {
    const url = item.getURL();
    const path = uniqueDownloadPath(this.downloadDir, item.getFilename());
    item.setSavePath(path);
    item.pause();
    let approved = false;
    item.once("done", (_event, state) => {
      if (approved) this.events.onDownloadFinished({ url, path, state });
    });
    void this.events
      .onDownload({ url, filename: basename(path), totalBytes: item.getTotalBytes() })
      .then(
        (allowed) => allowed,
        () => false,
      )
      .then((allowed) => {
        if (item.getState() !== "progressing") return;
        if (!allowed) {
          item.cancel();
          return;
        }
        approved = true;
        item.resume();
      });
  }

  private pushConsole(entry: ConsoleEntry): void {
    this.consoleEntries.push(entry);
    if (this.consoleEntries.length > MAX_CONSOLE_ENTRIES) this.consoleEntries.shift();
  }

  private onCdpEvent(method: string, params: CdpParams): void {
    if (method === "Network.requestWillBeSent") {
      const request = params.request as { url?: string; method?: string } | undefined;
      const entry = {
        requestId: String(params.requestId),
        method: request?.method ?? "GET",
        url: request?.url ?? "",
        resourceType: String(params.type ?? "Other"),
        status: null,
      };
      this.networkEntries.push(entry);
      this.networkById.set(entry.requestId, entry);
      if (this.networkEntries.length > MAX_NETWORK_ENTRIES) {
        const dropped = this.networkEntries.shift();
        if (dropped) this.networkById.delete(dropped.requestId);
      }
    } else if (method === "Network.responseReceived") {
      const entry = this.networkById.get(String(params.requestId));
      const response = params.response as { status?: number } | undefined;
      if (entry && typeof response?.status === "number") entry.status = response.status;
    } else if (method === "Network.loadingFailed") {
      const entry = this.networkById.get(String(params.requestId));
      if (entry) {
        entry.failed = String(params.blockedReason ?? params.errorText ?? "failed");
      }
    }
  }

  private async cdp(method: string, params?: CdpParams): Promise<unknown> {
    if (this.closed) throw new Error("This page was closed; open it again with browser_open");
    return this.contents.debugger.sendCommand(method, params);
  }

  private async callOn(backendNodeId: number, functionDeclaration: string): Promise<void> {
    const resolved = (await this.cdp("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) return;
    await this.cdp("Runtime.callFunctionOn", { objectId, functionDeclaration });
  }

  private async boxOf(
    backendNodeId: number,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const result = (await this.cdp("DOM.getBoxModel", { backendNodeId })) as {
      model?: { border: number[] };
    };
    const quad = result.model?.border;
    if (!quad || quad.length < 8) throw new Error("Element has no visible box");
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const box = await this.boxOf(backendNodeId);
    if (box.width === 0 || box.height === 0) throw new Error("Element is not visible");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Give an action a moment to start a navigation, then wait for it to finish. */
  private async settle(timeoutMs: number): Promise<void> {
    await delay(SETTLE_POLL_MS);
    if (this.closed || !this.contents.isLoading()) return;
    await withTimeout(
      new Promise<void>((resolve) => this.contents.once("did-stop-loading", () => resolve())),
      timeoutMs,
      `Page was still loading after ${Math.round(timeoutMs / 1000)}s`,
    );
  }
}

function describeLoadError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ERR_BLOCKED_BY_CLIENT")) return `${url} is blocked for agent browsing`;
  if (message.includes("ERR_ABORTED")) return `Loading ${url} was aborted (download or redirect)`;
  return `Couldn't load ${url}: ${message}`;
}

/** A safe, non-clobbering path for `filename` inside `dir` (created if needed). */
function uniqueDownloadPath(dir: string, filename: string): string {
  mkdirSync(dir, { recursive: true });
  const safe =
    Array.from(basename(filename), (char) =>
      char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? "_" : char,
    )
      .join("")
      .trim() || "download";
  const ext = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = join(dir, safe);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}
