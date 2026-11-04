import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadLinkCardView } from "@/components/thread-link-card";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("ThreadLinkCardView", () => {
  const render = (overrides: Partial<Parameters<typeof ThreadLinkCardView>[0]> = {}) =>
    renderToStaticMarkup(
      <ThreadLinkCardView
        title="Explore what this project is"
        agentName="Claude"
        provider="claude-agent-acp"
        running={false}
        missing={false}
        onOpen={noop}
        {...overrides}
      />,
    );

  test("names the thread and its agent, and opens it", () => {
    const html = render();
    expect(html).toContain("Explore what this project is");
    expect(html).toContain("New thread · Claude");
    expect(html).toContain('aria-label="Open Explore what this project is"');
    expect(html).not.toContain('disabled=""');
  });

  test("shimmers while the thread works", () => {
    expect(render({ running: true })).toContain("subthread-orb-working");
    expect(text(render({ running: true }))).toContain("· Working");
    expect(render()).not.toContain("subthread-orb-working");
  });

  test("a deleted thread stays as a record but can't be opened", () => {
    const html = render({ missing: true });
    expect(text(html)).toContain("New thread · Claude · Deleted");
    expect(html).toContain('disabled=""');
  });
});
