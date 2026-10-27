import type { UrlDecision } from "./url-policy.ts";

/**
 * One headless page owned by an agent session. BrowserService only talks to
 * pages through this interface, so its session, limit and ref logic can be
 * tested without Electron; `electron-page.ts` is the real implementation.
 */

/** Subset of a CDP `Accessibility.AXNode` that snapshots read. */
export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface ConsoleEntry {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  failed?: string;
}

export interface NavigationResult {
  url: string;
  title: string;
  status: number | null;
}

export interface Screenshot {
  data: string;
  mimeType: "image/png" | "image/jpeg";
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  backendNodeId?: number;
  /** Page-coordinate rectangle, in CSS pixels. */
  clip?: { x: number; y: number; width: number; height: number };
  maxWidth: number;
  maxBytes: number;
}

export interface BrowserPage {
  readonly closed: boolean;
  navigate(url: string, timeoutMs: number): Promise<NavigationResult>;
  history(action: "back" | "forward" | "reload", timeoutMs: number): Promise<NavigationResult>;
  current(): NavigationResult;
  accessibilityTree(): Promise<AxNode[]>;
  click(backendNodeId: number, timeoutMs: number): Promise<void>;
  type(backendNodeId: number, text: string, options: { clear: boolean }): Promise<void>;
  press(key: string, timeoutMs: number): Promise<void>;
  scroll(
    delta: { x: number; y: number },
    backendNodeId?: number,
  ): Promise<{ x: number; y: number }>;
  screenshot(options: ScreenshotOptions): Promise<Screenshot>;
  evaluate(expression: string): Promise<unknown>;
  /** Entries since the previous drain, oldest first. */
  drainConsole(): ConsoleEntry[];
  drainNetwork(): NetworkEntry[];
  /** Renderer working set, or null when the process can't be found. */
  memoryBytes(): number | null;
  /**
   * Bumped on every cross-document navigation. Snapshot refs record the
   * generation they were taken in and go stale when it changes.
   */
  documentGeneration(): number;
  close(): void;
}

export interface PageEvents {
  /** The renderer process died; the page is unusable. */
  onCrash(reason: string): void;
  /** The page tried to open a window; the host decides whether to open it. */
  onPopup(url: string): void;
  /** The page closed itself (window.close) or was destroyed. */
  onClosed(): void;
  /**
   * The page started a download. It stays paused until this resolves; true
   * lets it continue into the session's download directory.
   */
  onDownload(request: DownloadRequest): Promise<boolean>;
  /** An allowed download finished, failed or was cancelled. */
  onDownloadFinished(result: DownloadResult): void;
}

export interface DownloadRequest {
  url: string;
  filename: string;
  /** Size in bytes, or 0 when the server didn't say. */
  totalBytes: number;
}

export interface DownloadResult {
  url: string;
  path: string;
  state: "completed" | "cancelled" | "interrupted";
}

export interface PageHost {
  createPage(options: {
    partition: string;
    checkUrl: (url: string) => UrlDecision;
    events: PageEvents;
    /** Where allowed downloads are saved; created on first download. */
    downloadDir: string;
  }): Promise<BrowserPage>;
  /** Drop cookies, storage and cache for a partition no page uses any more. */
  clearPartition(partition: string): Promise<void>;
}
