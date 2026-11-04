import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertCreatable,
  buildContent,
  extractTextContent,
  titleFromText,
} from "@/lib/composer-tokens";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/**
 * Draft creation behavior is exercised at the pure-logic + store boundary so
 * we don't remount the full AgentPanel (Electron IPC heavy). The panel's
 * handleDraftSend is a thin orchestration of these steps.
 */
describe("draft thread creation behavior", () => {
  beforeEach(() => {
    useWorkspaceViewStore.setState({
      mode: "agent",
      activeTerminalId: null,
      requestedThreadId: "old-thread",
      draft: null,
    });
  });

  test("beginDraft does not create a thread id and clears selection request", () => {
    useWorkspaceViewStore.getState().beginDraft({
      projectId: "p1",
      previousActiveProjectId: "p1",
    });
    const { draft, requestedThreadId, mode } = useWorkspaceViewStore.getState();
    expect(mode).toBe("agent");
    expect(requestedThreadId).toBeNull();
    expect(draft?.projectId).toBe("p1");
    expect(draft?.agentId).toBeNull();
  });

  test("smart @ cascade matches draft and live policies", async () => {
    const {
      resolveDefaultMentionKind,
      buildContent: bc,
      blankContent: blank,
    } = await import("@/lib/composer-tokens");
    expect(resolveDefaultMentionKind({ mode: "draft", content: blank() })).toBe("project");
    // Model-first: after project, next @ is model (not agent).
    expect(
      resolveDefaultMentionKind({
        mode: "draft",
        content: bc([{ kind: "project", id: "p", label: "P" }], ""),
      }),
    ).toBe("model");
    expect(resolveDefaultMentionKind({ mode: "live", content: blank() })).toBe("file");
    expect(
      resolveDefaultMentionKind({
        mode: "live",
        content: bc([{ kind: "model", id: "m", label: "M" }], "x"),
      }),
    ).toBe("file");
  });

  test("send payload requires project, agent, and text — model optional", () => {
    const incomplete = buildContent([{ kind: "project", id: "p1", label: "Omni" }], "hello");
    expect(assertCreatable(incomplete).ok).toBe(false);

    // Model-first: agent is inferred from model.agentId without an @agent chip.
    const ready = buildContent(
      [
        { kind: "project", id: "p1", label: "Omni" },
        { kind: "model", id: "sonnet", label: "Sonnet", agentId: "claude" },
      ],
      "  fix the bug  ",
    );
    const check = assertCreatable(ready);
    expect(check).toEqual({
      ok: true,
      projectId: "p1",
      agentId: "claude",
      modelId: "sonnet",
      text: "fix the bug",
    });
    // Soft default agent works when no model chip is present.
    expect(
      assertCreatable(buildContent([{ kind: "project", id: "p1", label: "Omni" }], "hi"), {
        defaultAgentId: "opencode-acp",
      }),
    ).toMatchObject({ ok: true, agentId: "opencode-acp" });
    // Control chips must not leak into the first user message.
    expect(extractTextContent(ready)).toBe("fix the bug");
    expect(extractTextContent(ready).includes("@")).toBe(false);
  });

  test("an untouched draft with a soft-default agent closes without asking", () => {
    useWorkspaceViewStore.getState().beginDraft({ projectId: "p1" });
    useWorkspaceViewStore.getState().setDraftAgent("claude", { markDirty: false });
    expect(useWorkspaceViewStore.getState().draft?.agentId).toBe("claude");
    expect(useWorkspaceViewStore.getState().draft?.dirty).toBe(false);
    // Picking an agent is an edit.
    useWorkspaceViewStore.getState().setDraftAgent("codex");
    expect(useWorkspaceViewStore.getState().draft?.dirty).toBe(true);
  });

  test("title is derived from first message text", () => {
    expect(titleFromText("Ship draft UX")).toBe("Ship draft UX");
  });

  test("endDraft clears draft after successful create handshake shape", () => {
    useWorkspaceViewStore.getState().beginDraft({ projectId: "p1" });
    useWorkspaceViewStore.getState().setDraftAgent("claude");
    expect(useWorkspaceViewStore.getState().draft).not.toBeNull();
    useWorkspaceViewStore.getState().endDraft();
    expect(useWorkspaceViewStore.getState().draft).toBeNull();
  });

  test("createThread is invoked with model as the sixth argument shape", async () => {
    const createThread = vi.fn(async () => ({ id: "t-new" }));
    // Mirrors agent-store.createThread forwarding.
    await createThread("p1", titleFromText("hi"), null, "claude", "/repo", "sonnet");
    expect(createThread).toHaveBeenCalledWith("p1", "hi", null, "claude", "/repo", "sonnet");
    expect(createThread).toHaveBeenCalledTimes(1);
  });

  test("empty workspace with auto-draft provides project -> model -> file mention cascade", async () => {
    const {
      resolveDefaultMentionKind,
      buildContent: bc,
      blankContent: blank,
    } = await import("@/lib/composer-tokens");

    // When all tabs close and auto-draft initializes without a project:
    useWorkspaceViewStore.getState().beginDraft();
    expect(useWorkspaceViewStore.getState().draft).not.toBeNull();
    expect(resolveDefaultMentionKind({ mode: "draft", content: blank() })).toBe("project");

    // When auto-draft initializes with an active project:
    useWorkspaceViewStore.getState().beginDraft({ projectId: "p1" });
    const contentWithProject = bc([{ kind: "project", id: "p1", label: "Omni" }], "");
    // First @ targets model:
    expect(resolveDefaultMentionKind({ mode: "draft", content: contentWithProject })).toBe("model");

    // After picking model, next @ targets file:
    const contentWithModel = bc(
      [
        { kind: "project", id: "p1", label: "Omni" },
        { kind: "model", id: "sonnet", label: "Sonnet" },
      ],
      "",
    );
    expect(resolveDefaultMentionKind({ mode: "draft", content: contentWithModel })).toBe("file");
  });
});
