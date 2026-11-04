import { describe, expect, test } from "vitest";
import type { Thread } from "../../contracts/threads.ts";
import { visibleProjectThreadTabs } from "./thread-tab-state";

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
