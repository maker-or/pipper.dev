import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

describe("MarkdownRenderer list formatting", () => {
  test("renders ordered lists with list-outside and left padding", () => {
    const markdown = "1. First item\n2. Second item";
    const html = renderToStaticMarkup(<MarkdownRenderer>{markdown}</MarkdownRenderer>);

    expect(html).toContain("list-outside");
    expect(html).toContain("list-decimal");
    expect(html).toContain("pl-5");
    expect(html).not.toContain("list-inside");
    expect(html).toContain("[&amp;&gt;p]:inline");
    expect(html).toContain("First item");
    expect(html).toContain("Second item");
  });

  test("renders unordered lists with list-outside and left padding", () => {
    const markdown = "- Apple\n- Banana";
    const html = renderToStaticMarkup(<MarkdownRenderer>{markdown}</MarkdownRenderer>);

    expect(html).toContain("list-outside");
    expect(html).toContain("list-disc");
    expect(html).toContain("pl-5");
    expect(html).not.toContain("list-inside");
  });

  test("handles loose lists with paragraphs inside li correctly", () => {
    const markdown = "1. First paragraph\n\n   Second paragraph\n\n2. Next item";
    const html = renderToStaticMarkup(<MarkdownRenderer>{markdown}</MarkdownRenderer>);

    expect(html).toContain("list-outside");
    expect(html).toContain("[&amp;&gt;p]:inline");
    expect(html).toContain("First paragraph");
    expect(html).toContain("Second paragraph");
  });
});

describe("MarkdownRenderer links", () => {
  test("renders web and file links in the link colour, without a new-window target", () => {
    const html = renderToStaticMarkup(
      <MarkdownRenderer>
        {"See [docs](https://example.com) and [app.ts](src/app.ts:4)."}
      </MarkdownRenderer>,
    );
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="src/app.ts:4"');
    expect(html).toContain("text-link");
    expect(html).not.toContain('target="_blank"');
    // File links read as code.
    expect(html).toMatch(
      /class="[^"]*font-mono[^"]*"[^>]*href="src\/app\.ts:4"|href="src\/app\.ts:4"[^>]*class="[^"]*font-mono/,
    );
  });
});
