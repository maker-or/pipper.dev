import { describe, expect, test } from "vitest";
import type { Thread } from "../../contracts/threads.ts";
import { groupRunningAgentsByProject, groupRunningAgentsByWorkspace } from "./running-agents";

const PROJECT_ID = "p1";
const PROJECT_PATH = "/repo";

function thread(patch: Partial<Thread> & Pick<Thread, "id">): Thread {
  return {
    project_id: PROJECT_ID,
    agent_id: "claude-agent-acp",
    agent_session_id: `s-${patch.id}`,
    title: null,
    worktree_path: null,
    created_at: 0,
    last_used_at: 0,
    ...patch,
  };
}

function group(threads: Thread[], running: string[]) {
  return groupRunningAgentsByWorkspace({
    threads,
    runningThreadIds: running,
    projectId: PROJECT_ID,
    projectPath: PROJECT_PATH,
  });
}

describe("groupRunningAgentsByWorkspace", () => {
  test("only running threads contribute", () => {
    const result = group(
      [
        thread({ id: "a", worktree_path: "/wt/one" }),
        thread({ id: "b", worktree_path: "/wt/two" }),
      ],
      ["a"],
    );
    expect(result.get("/wt/one")).toEqual(["claude-agent-acp"]);
    expect(result.has("/wt/two")).toBe(false);
  });

  test("several agents in one workspace are all reported, deduplicated", () => {
    const result = group(
      [
        thread({ id: "a", worktree_path: "/wt/one", agent_id: "claude-agent-acp" }),
        thread({ id: "b", worktree_path: "/wt/one", agent_id: "codex-acp" }),
        thread({ id: "c", worktree_path: "/wt/one", agent_id: "claude-agent-acp" }),
      ],
      ["a", "b", "c"],
    );
    expect(result.get("/wt/one")).toEqual(["claude-agent-acp", "codex-acp"]);
  });

  test("the project root is keyed as null, matching the root card", () => {
    const result = group(
      [
        thread({ id: "a", worktree_path: null }),
        // A thread bound to the project path itself is still the root.
        thread({ id: "b", worktree_path: PROJECT_PATH, agent_id: "cursor-acp" }),
      ],
      ["a", "b"],
    );
    expect(result.get(null)).toEqual(["claude-agent-acp", "cursor-acp"]);
    expect(result.has(PROJECT_PATH)).toBe(false);
  });

  test("another project's running threads never leak in", () => {
    const result = group(
      [thread({ id: "a", project_id: "other", worktree_path: "/wt/one" })],
      ["a"],
    );
    expect(result.size).toBe(0);
  });

  test("nothing running yields an empty map", () => {
    expect(group([thread({ id: "a", worktree_path: "/wt/one" })], []).size).toBe(0);
  });
});

describe("groupRunningAgentsByProject", () => {
  test("groups running agents per project across workspaces, once per agent", () => {
    const threads = [
      thread({ id: "a", worktree_path: "/repo-wt" }),
      thread({ id: "b" }),
      thread({ id: "c", agent_id: "codex" }),
      thread({ id: "d", project_id: "p2" }),
      thread({ id: "idle", project_id: "p3" }),
      thread({ id: "a", worktree_path: "/repo-wt" }),
    ];
    const grouped = groupRunningAgentsByProject({
      threads,
      runningThreadIds: ["a", "b", "c", "d"],
    });
    expect(grouped.get(PROJECT_ID)).toEqual(["claude-agent-acp", "codex"]);
    expect(grouped.get("p2")).toEqual(["claude-agent-acp"]);
    expect(grouped.has("p3")).toBe(false);
  });
});
