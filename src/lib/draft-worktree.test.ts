import { beforeEach, describe, expect, test } from "vitest";
import { useAgentStore } from "@/store/agent-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { newDraftWorktreePath } from "./draft-worktree";

const project = { id: "p1", path: "/repo" };

function showThread(projectId: string, cwd: string) {
  useAgentStore.setState((current) => ({
    state: { ...current.state, threadId: "t1", projectId, cwd } as never,
  }));
}

describe("newDraftWorktreePath", () => {
  beforeEach(() => {
    useAgentStore.setState({ state: null } as never);
    useWorktreeStore.setState({ selectedWorktreePathByProject: { p1: "/repo/.wt/other" } });
  });

  test("starts the draft where the open thread runs", () => {
    showThread("p1", "/repo");
    expect(newDraftWorktreePath(project)).toBeNull();
    showThread("p1", "/repo/.wt/feature");
    expect(newDraftWorktreePath(project)).toBe("/repo/.wt/feature");
  });

  test("a draft for another project uses that project's selected worktree", () => {
    showThread("p2", "/elsewhere");
    expect(newDraftWorktreePath(project)).toBe("/repo/.wt/other");
  });
});
