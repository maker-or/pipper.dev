import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadProposalCardView } from "@/components/thread-proposal-card";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("ThreadProposalCardView", () => {
  const render = (overrides: Partial<Parameters<typeof ThreadProposalCardView>[0]> = {}) =>
    renderToStaticMarkup(
      <ThreadProposalCardView
        title="Fix billing tests"
        agentName="Codex"
        provider="codex-acp"
        model="gpt-5.5"
        task="Make the billing suite pass."
        state="open"
        busy={null}
        onStart={noop}
        onDismiss={noop}
        {...overrides}
      />,
    );

  test("an open proposal names the thread, agent and model, shows the brief, and offers Start and Dismiss", () => {
    const html = render();
    expect(text(html)).toContain("Proposed thread · Codex · gpt-5.5");
    expect(html).toContain("Make the billing suite pass.");
    expect(text(html)).toContain("Start");
    expect(text(html)).toContain("Dismiss");
  });

  test("a dismissed or expired proposal stays as a record without buttons", () => {
    for (const state of ["dismissed", "expired"] as const) {
      const html = render({ state });
      expect(text(html)).toContain(state === "dismissed" ? "· Dismissed" : "· Expired");
      expect(text(html)).not.toContain("Start");
      expect(html).not.toContain("Make the billing suite pass.");
    }
  });

  test("while one answer is in flight, both buttons are disabled", () => {
    expect(render({ busy: "start" }).match(/disabled=""/g)).toHaveLength(2);
  });
});
