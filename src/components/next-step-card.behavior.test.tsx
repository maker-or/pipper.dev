import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextStepCard, visibleAsk } from "@/components/next-step-card";
import type { UiRequest } from "@/store/agent-store";
import type { NextStep } from "../../contracts/next-step.ts";

const STEP: NextStep = {
  recap: "The banner shows when no agent is installed. Nothing is committed.",
  ask: "Commit both changes?",
  actions: [
    { label: "Commit changes", message: "Commit both changes." },
    { label: "Preview first", message: "Open the app so I can see the banner first." },
  ],
  blocked: false,
};

/** Opening tags of the card's buttons, in order. */
function buttonTags(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

describe("NextStepCard", () => {
  test("shows the recap, the question and one button per answer", () => {
    const html = renderToStaticMarkup(<NextStepCard step={STEP} threadId="t1" answerable />);
    expect(html).toContain(STEP.recap);
    expect(html).toContain("Commit both changes?");
    expect(html).toContain("Commit changes");
    expect(html).toContain("Preview first");
    expect(buttonTags(html).every((tag) => !tag.includes(' disabled=""'))).toBe(true);
  });

  test("a recap alone draws no question or buttons", () => {
    const html = renderToStaticMarkup(
      <NextStepCard step={{ ...STEP, ask: null, actions: [] }} threadId="t1" answerable />,
    );
    expect(html).toContain(STEP.recap);
    expect(html).not.toContain("next-step-ask");
    expect(buttonTags(html)).toHaveLength(0);
  });

  test("an earlier turn's card can't be answered", () => {
    const html = renderToStaticMarkup(
      <NextStepCard step={STEP} threadId="t1" answerable={false} />,
    );
    const tags = buttonTags(html);
    expect(tags).toHaveLength(2);
    expect(tags.every((tag) => tag.includes(' disabled=""'))).toBe(true);
  });

  test("while a confirm card waits in the thread, only the recap shows", () => {
    const confirm: UiRequest = {
      id: "s1:r1",
      kind: "select",
      title: "Permission required",
      sessionId: "s1",
      threadId: "t1",
      confirm: { title: "Delete workspace x", verb: "delete", impact: [] },
    };
    expect(visibleAsk(STEP, [confirm], "t1")).toBeNull();
    expect(visibleAsk(STEP, [confirm], "t2")).toBe("Commit both changes?");
    expect(visibleAsk(STEP, [{ ...confirm, confirm: undefined }], "t1")).toBe(
      "Commit both changes?",
    );
  });
});
