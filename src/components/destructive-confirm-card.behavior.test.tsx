import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentQuestionCard } from "@/components/agent-question";
import type { UiRequest } from "@/store/agent-store";

const REQUEST: UiRequest = {
  id: "s1:r1",
  requestId: "r1",
  kind: "select",
  title: "Permission required",
  message: "Delete workspace feature-auth",
  options: ["Delete", "Don't allow"],
  optionIds: ["confirm", "deny"],
  sessionId: "s1",
  threadId: "t1",
  confirm: {
    title: "Delete workspace feature-auth",
    verb: "delete",
    impact: ["3 threads, including “Fix billing”", "uncommitted changes in 4 files"],
  },
};

describe("destructive confirmation card", () => {
  test("shows the action, a red hold button and a plain decline, without the impact list", () => {
    const html = renderToStaticMarkup(<AgentQuestionCard request={REQUEST} />);

    expect(html).toContain('data-pipper-id="destructive-confirm-card"');
    expect(html).toContain("Delete workspace feature-auth");
    expect(html).not.toContain("uncommitted changes in 4 files");
    expect(html).toContain("Hold to delete");
    expect(html).toContain('aria-label="Hold to delete workspace feature-auth"');
    expect(html).toContain("Don&#x27;t allow");
    // The hold button carries its fill layer; a plain choice card would not.
    expect(html).toContain("data-button-fill");
  });

  test("a permission without a confirmation keeps the plain choice card", () => {
    const html = renderToStaticMarkup(
      <AgentQuestionCard request={{ ...REQUEST, confirm: undefined }} />,
    );
    expect(html).not.toContain("destructive-confirm-card");
  });
});
