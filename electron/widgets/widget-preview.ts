import type { McpContent, McpToolResult } from "../mcp/mcp-http-server.ts";
import type { BrowserPage, PageHost } from "../browser/browser-page.ts";
import type { UrlDecision } from "../browser/url-policy.ts";
import { buildWidgetFrameHtml } from "./widget-frame.ts";
import { lintWidgetSource, type LintFinding } from "./widget-lint.ts";

/**
 * Renders widget code in the real widget frame on a headless page and
 * reports what the agent needs to fix before showing it: screenshots in both
 * themes, measured size, script errors, blocked resources and design checks.
 *
 * One page is shared by all sessions (previews are short and serialized),
 * kept in its own partition and recycled after a number of uses.
 */

export interface WidgetPreviewOptions {
  host: PageHost;
  checkUrl: (url: string) => UrlDecision;
  downloadDir: string;
  navigationTimeoutMs: number;
  screenshotMaxBytes: number;
  /** Longest one render may take before its page is replaced. Defaults to navigationTimeoutMs. */
  renderTimeoutMs?: number;
}

interface FrameState {
  size: { width: number; height: number };
  errors: string[];
  blocked: Array<{ url: string; reason: string }>;
  actions: Array<{ type: string }>;
  lint: LintFinding[];
}

const PARTITION = "pipper-widget-preview";
const RECYCLE_AFTER_USES = 50;
const MAX_CAPTURE_HEIGHT = 4000;
export const DEFAULT_WIDGET_WIDTH = 680;
const MIN_WIDGET_WIDTH = 280;
const MAX_WIDGET_WIDTH = 1200;

export class WidgetPreviewer {
  private readonly options: WidgetPreviewOptions;
  private page: BrowserPage | null = null;
  private uses = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: WidgetPreviewOptions) {
    this.options = options;
  }

  preview(code: string, width = DEFAULT_WIDGET_WIDTH): Promise<McpToolResult> {
    const run = this.queue.then(() => this.renderWithin(code, width));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Previews share one page and one queue, and CDP commands have no timeout
   * of their own: a widget that never yields (`while (true) {}`) would hold
   * the queue for every later preview. Bound each render, and replace the
   * page when one runs over so the next preview starts clean.
   */
  private async renderWithin(code: string, width: number): Promise<McpToolResult> {
    const limitMs = this.options.renderTimeoutMs ?? this.options.navigationTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const rendering = this.render(code, width);
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.page?.close();
        this.page = null;
        reject(
          new Error(
            `The widget did not finish rendering within ${Math.ceil(limitMs / 1000)}s. Check its scripts for loops that never end.`,
          ),
        );
      }, limitMs);
    });
    try {
      return await Promise.race([rendering, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      // The abandoned render fails once its page closes; nobody awaits it.
      rendering.catch(() => undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.page?.close();
    this.page = null;
  }

  private async render(code: string, requestedWidth: number): Promise<McpToolResult> {
    if (this.disposed) throw new Error("Widget previews are shutting down.");
    const width = Math.round(
      Math.min(
        MAX_WIDGET_WIDTH,
        Math.max(MIN_WIDGET_WIDTH, requestedWidth || DEFAULT_WIDGET_WIDTH),
      ),
    );
    const sourceFindings = lintWidgetSource(code);
    const page = await this.freshPage();
    const html = buildWidgetFrameHtml();
    await page.navigate(
      `data:text/html;base64,${Buffer.from(html).toString("base64")}`,
      this.options.navigationTimeoutMs,
    );

    const light = (await page.evaluate(
      `window.__pipperRender(${JSON.stringify(code)}, ${JSON.stringify({ width, theme: "light" })})`,
    )) as FrameState;
    const height = Math.max(1, Math.min(MAX_CAPTURE_HEIGHT, light.size.height));
    const clip = { x: 0, y: 0, width, height };
    const lightShot = await page.screenshot({
      clip,
      maxWidth: width,
      maxBytes: this.options.screenshotMaxBytes,
    });
    const dark = (await page.evaluate(`window.__pipperSetTheme("dark")`)) as FrameState;
    const darkShot = await page.screenshot({
      clip,
      maxWidth: width,
      maxBytes: this.options.screenshotMaxBytes,
    });

    const frameFindings = mergeFindings(light.lint, dark.lint);
    if (light.size.height > MAX_CAPTURE_HEIGHT) {
      frameFindings.push({
        rule: "too-tall",
        message: `Content is ${light.size.height}px tall; screenshots stop at ${MAX_CAPTURE_HEIGHT}px. Keep widgets compact.`,
      });
    }
    const findings = [...sourceFindings, ...frameFindings];
    const errors = unique([...light.errors, ...dark.errors]);
    const blocked = uniqueBy([...light.blocked, ...dark.blocked], (item) => item.url);

    const lines = [`Rendered at ${width}×${light.size.height}px.`];
    lines.push(
      errors.length === 0 ? "Script errors: none" : `Script errors:\n${bullets(errors)}`,
      blocked.length === 0
        ? "Blocked or missing resources: none"
        : `Blocked or missing resources:\n${bullets(blocked.map((b) => `${b.url} (${b.reason})`))}`,
      findings.length === 0
        ? "Design checks: all passed"
        : `Design checks:\n${bullets(findings.map((f) => `[${f.rule}] ${f.message}`))}`,
    );
    const clean = errors.length === 0 && blocked.length === 0 && findings.length === 0;
    lines.push(
      clean
        ? "Clean. Show it with show_widget using the same code."
        : "Fix these and preview again before showing the widget.",
    );

    const content: McpContent[] = [
      { type: "text", text: lines.join("\n\n") },
      { type: "text", text: "Light theme:" },
      { type: "image", data: lightShot.data, mimeType: lightShot.mimeType },
      { type: "text", text: "Dark theme:" },
      { type: "image", data: darkShot.data, mimeType: darkShot.mimeType },
    ];
    return { content };
  }

  private async freshPage(): Promise<BrowserPage> {
    if (this.page && (this.page.closed || this.uses >= RECYCLE_AFTER_USES)) {
      this.page.close();
      this.page = null;
    }
    if (!this.page) {
      this.uses = 0;
      const page = await this.options.host.createPage({
        partition: PARTITION,
        checkUrl: this.options.checkUrl,
        downloadDir: this.options.downloadDir,
        events: {
          onCrash: () => {
            if (this.page === page) this.page = null;
          },
          onPopup: () => undefined,
          onClosed: () => {
            if (this.page === page) this.page = null;
          },
          onDownload: async () => false,
          onDownloadFinished: () => undefined,
        },
      });
      if (this.disposed) {
        page.close();
        throw new Error("Widget previews are shutting down.");
      }
      this.page = page;
    }
    this.uses++;
    return this.page;
  }
}

function mergeFindings(light: LintFinding[], dark: LintFinding[]): LintFinding[] {
  const out = light.map((finding) => ({ ...finding }));
  const seen = new Set(light.map((finding) => finding.message));
  for (const finding of dark) {
    if (seen.has(finding.message)) continue;
    out.push({ ...finding, message: `In dark theme: ${finding.message}` });
  }
  return out;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}
