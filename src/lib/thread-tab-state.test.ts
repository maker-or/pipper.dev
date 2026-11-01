import { describe, expect, test } from "vitest";
import type { Thread } from "../../contracts/threads.ts";
import { visibleProjectThreadTabs, visibleWorkspaceThreadTabs } from "./thread-tab-state";

function thread(id: string, workspace: string | null, projectId = "project"): Thread {
  return {
    id,
    project_id: projectId,
    worktree_path: workspace,
    agent_id: "agent",
    agent_session_id: `session-${id}`,
    title: id,
    created_at: 0,
    last_used_at: 0,
  };
}

describe("workspace thread tab selection", () => {
  const threads = [
    thread("main", null),
    thread("a", "/workspace-a"),
    thread("b", "/workspace-a"),
    thread("c", "/workspace-b"),
    thread("other-project", "/workspace-a", "other"),
  ];

  test("keeps the displayed thread selectable between snapshot and workspace sync", () => {
    // Main publishes B's snapshot before persisting the workspace selection.
    const beforeSync = visibleWorkspaceThreadTabs(threads, "project", null, "b", null);
    expect(beforeSync.map((item) => item.id)).toEqual(["main", "b"]);
    expect(beforeSync.some((item) => item.id === "b")).toBe(true);

    const afterSync = visibleWorkspaceThreadTabs(threads, "project", "/workspace-a", "b", null);
    expect(afterSync.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("keeps the latest requested tab while the displayed snapshot is still older", () => {
    const pending = visibleWorkspaceThreadTabs(threads, "project", null, "b", "c");
    expect(pending.map((item) => item.id)).toEqual(["main", "b", "c"]);

    const settled = visibleWorkspaceThreadTabs(threads, "project", "/workspace-b", "c", null);
    expect(settled.map((item) => item.id)).toEqual(["c"]);
  });

  test("does not leak displayed or requested tabs from another project", () => {
    expect(
      visibleWorkspaceThreadTabs(threads, "project", null, "other-project", "other-project").map(
        (item) => item.id,
      ),
    ).toEqual(["main"]);
    expect(visibleWorkspaceThreadTabs(threads, null, null, "b", "c")).toEqual([]);
  });
});

describe("project thread tab selection", () => {
  const threads = [
    thread("main", null),
    thread("a", "/workspace-a"),
    thread("other-project", "/workspace-a", "other"),
  ];

  test("shows every workspace's tabs for the selected project", () => {
    const visible = visibleProjectThreadTabs(threads, "project", null, null);
    expect(visible.map((item) => item.id)).toEqual(["main", "a"]);
  });

  test("keeps another project's displayed thread while the project mirror catches up", () => {
    const visible = visibleProjectThreadTabs(threads, "project", "other-project", null);
    expect(visible.map((item) => item.id)).toEqual(["main", "a", "other-project"]);
  });

  test("shows nothing without a project", () => {
    expect(visibleProjectThreadTabs(threads, null, "main", null)).toEqual([]);
  });
});
