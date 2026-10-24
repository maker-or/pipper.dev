import { describe, expect, test } from "vitest";
import phosphorFont from "@phosphor-icons/web/regular/Phosphor.woff2?inline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPage, PageEvents, PageHost } from "../browser/browser-page.ts";
import { buildWidgetFrameHtml } from "./widget-frame.ts";
import { parseGuideModules, widgetGuide } from "./widget-guide.ts";
import { lintWidgetSource } from "./widget-lint.ts";
import { WidgetPreviewer } from "./widget-preview.ts";
import { extractThemeTokens } from "./widget-tokens.ts";

const rules = (code: string) => lintWidgetSource(code).map((finding) => finding.rule);

describe("widget source checks", () => {
  test("token-only widgets built from the kit pass", () => {
    const code = `<h2 class="sr-only">Summary</h2>
<div class="ff-row"><div class="ff-card ff-stat" style="color: var(--foreground)">
<span class="ff-stat-value">412</span><a href="#details">Details</a></div></div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>`;
    expect(lintWidgetSource(code)).toEqual([]);
  });

  test("hardcoded colours are reported with their line", () => {
    const findings = lintWidgetSource(
      `<div>\n<p style="color:#333">x</p>\n<rect fill="rgb(1, 2, 3)"/>`,
    );
    expect(findings.map((f) => [f.rule, f.line])).toEqual([
      ["hardcoded-color", 2],
      ["hardcoded-color", 3],
    ]);
  });

  test("banned patterns from the guide are caught", () => {
    expect(rules("<html><body>x</body></html>")).toContain("document-wrapper");
    expect(rules('<div style="position: fixed">')).toContain("fixed-position");
    expect(rules("<script>el.requestFullscreen()</script>")).toContain("fullscreen");
    expect(rules("<script>window.open('x')</script>")).toContain("navigation");
    expect(rules("<script>localStorage.x = 1</script>")).toContain("storage");
    expect(rules('<b style="font-weight: 700">x</b>')).toContain("font-weight");
  });

  test("scripts must come from an allowed CDN at an exact version", () => {
    expect(rules('<script src="https://evil.example/x.js"></script>')).toEqual(["script-origin"]);
    expect(rules('<script src="https://unpkg.com/d3"></script>')).toEqual(["unpinned-script"]);
  });
});

describe("widget frame", () => {
  test("uses the app's own light and dark tokens", () => {
    const css = readFileSync(join(import.meta.dirname, "../../src/index.css"), "utf8");
    const tokens = extractThemeTokens(css);
    expect(tokens).toContain('[data-workspace-theme="light"]');
    expect(tokens).toContain('[data-workspace-theme="dark"]');
    expect(tokens).toContain("--workspace-fill-ready");

    const html = buildWidgetFrameHtml();
    expect(html).toContain(tokens);
    expect(html).toContain(".ff-badge");
    expect(html).toContain("window.pipper");
  });

  test("icons and fonts are self-contained and scripts are limited to the allowlist", () => {
    const html = buildWidgetFrameHtml();
    // Production builds inline this as a data: URL; Vitest serves a path.
    expect(html).toContain(`src: url("${phosphorFont}") format("woff2");`);
    expect(html).not.toContain('url("./Phosphor');
    expect(html).toMatch(/script-src 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/);
    expect(html).not.toMatch(/<link[^>]+https?:/);
  });

  test("a stylesheet without the token blocks is rejected loudly", () => {
    expect(() => extractThemeTokens(":root { --x: 1 }")).toThrow(/token blocks/);
  });
});

describe("widget guide", () => {
  test("splits the agent-facing doc into modules", () => {
    const modules = parseGuideModules(
      "# Title\n## Host contract\n### not-this\nsecret\n## Agent-facing text\n### core\nRules\n### chart\nCharts",
    );
    expect([...modules.keys()]).toEqual(["core", "chart"]);
    expect(modules.get("core")).toBe("Rules");
  });

  test("unknown modules are an error the agent can act on", () => {
    expect(() => widgetGuide(["maps"])).toThrow(/core, chart/);
  });
});

describe("widget preview", () => {
  function fakeHost(state: Record<string, unknown>) {
    const evaluated: string[] = [];
    let created = 0;
    const host: PageHost = {
      async createPage(options: { events: PageEvents }) {
        created++;
        const page: Partial<BrowserPage> = {
          closed: false,
          navigate: async (url) => ({ url, title: "", status: null }),
          evaluate: async (expression) => {
            evaluated.push(expression);
            return state;
          },
          screenshot: async () => ({ data: "cG5n", mimeType: "image/png" }),
          close: () => options.events.onClosed(),
        };
        return page as BrowserPage;
      },
      clearPartition: async () => undefined,
    };
    return { host, evaluated, created: () => created };
  }

  const preview = (state: Record<string, unknown>) => {
    const fake = fakeHost(state);
    const previewer = new WidgetPreviewer({
      host: fake.host,
      checkUrl: () => ({ allowed: true }),
      downloadDir: "/tmp/unused",
      navigationTimeoutMs: 1000,
      screenshotMaxBytes: 1_000_000,
    });
    return { previewer, fake };
  };

  test("a clean widget gets both themes and a go-ahead", async () => {
    const { previewer, fake } = preview({
      size: { width: 680, height: 120 },
      errors: [],
      blocked: [],
      actions: [],
      lint: [],
    });
    const result = await previewer.preview('<div class="ff-card">ok</div>', 360);
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text);
    expect(text[0]).toContain("Rendered at 360×120px");
    expect(text[0]).toContain("Design checks: all passed");
    expect(text[0]).toContain("Clean.");
    expect(text).toContain("Light theme:");
    expect(text).toContain("Dark theme:");
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(fake.evaluated[0]).toContain('"theme":"light"');
    expect(fake.evaluated[1]).toContain('__pipperSetTheme("dark")');
    previewer.dispose();
  });

  test("errors, blocked resources and design problems are all reported", async () => {
    const { previewer } = preview({
      size: { width: 680, height: 5000 },
      errors: ["Uncaught ReferenceError: x is not defined"],
      blocked: [{ url: "https://evil.example/x.js", reason: "blocked by script-src-elem" }],
      actions: [],
      lint: [{ rule: "small-text", message: 'Text "a" is 9px; the minimum is 11px.' }],
    });
    const result = await previewer.preview('<p style="color:#333">a</p>');
    const summary = result.content[0].type === "text" ? result.content[0].text : "";
    expect(summary).toContain("ReferenceError");
    expect(summary).toContain("https://evil.example/x.js");
    expect(summary).toContain("[hardcoded-color]");
    expect(summary).toContain("[small-text]");
    expect(summary).toContain("[too-tall]");
    expect(summary).toContain("Fix these");
    previewer.dispose();
  });

  test("one page is reused across previews", async () => {
    const { previewer, fake } = preview({
      size: { width: 680, height: 10 },
      errors: [],
      blocked: [],
      actions: [],
      lint: [],
    });
    await previewer.preview("<p>a</p>");
    await previewer.preview("<p>b</p>");
    expect(fake.created()).toBe(1);
    previewer.dispose();
  });
});
