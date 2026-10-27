import { describe, expect, test } from "vitest";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { nestThreads, taskStatusText } from "./agent-task-tree";

function task(
  childThreadId: string,
  parentThreadId: string,
  extra: Partial<AgentTaskSnapshot> = {},
) {
  return {
    taskId: `task-${childThreadId}`,
    parentThreadId,
    childThreadId,
    projectId: "p",
    agentId: "codex",
    title: childThreadId,
    status: "running",
    outcome: null,
    waitingForPermission: false,
    workspaceMode: "shared",
    workspacePath: "/repo",
    branch: null,
    depth: 1,
    turns: 0,
    createdAt: 1,
    updatedAt: 1,
    reportPreview: null,
    nextStep: null,
    error: null,
    ...extra,
  } satisfies AgentTaskSnapshot;
}

const threads = (...ids: string[]) => ids.map((id) => ({ id }));
const shape = (rows: ReturnType<typeof nestThreads>) =>
  rows.map((r) => `${r.depth}:${r.thread.id}`);

describe("nestThreads", () => {
  test("task threads follow the thread that started them, deepest last", () => {
    const rows = nestThreads(threads("child-b", "other", "parent", "child-a", "grandchild"), [
      task("child-a", "parent"),
      task("child-b", "parent"),
      task("grandchild", "child-a", { depth: 2 }),
    ]);
    expect(shape(rows)).toEqual(["0:other", "0:parent", "1:child-b", "1:child-a", "2:grandchild"]);
    expect(rows.find((r) => r.thread.id === "child-a")!.task?.taskId).toBe("task-child-a");
  });

  test("a task whose parent isn't listed stays a top-level row", () => {
    expect(shape(nestThreads(threads("child", "x"), [task("child", "missing")]))).toEqual([
      "0:child",
      "0:x",
    ]);
  });

  test("a cycle in task data still lists every thread once", () => {
    const rows = nestThreads(threads("a", "b"), [task("a", "b"), task("b", "a")]);
    expect(rows.map((r) => r.thread.id).sort()).toEqual(["a", "b"]);
  });
});

describe("taskStatusText", () => {
  test("says what the task needs, not just its lifecycle state", () => {
    expect(taskStatusText(task("a", "p", { waitingForPermission: true }))).toBe("Needs permission");
    expect(taskStatusText(task("a", "p", { status: "idle", outcome: "needs_input" }))).toBe(
      "Has a question",
    );
    expect(taskStatusText(task("a", "p", { status: "idle", outcome: "done" }))).toBe("Done");
    expect(taskStatusText(task("a", "p", { status: "timed_out" }))).toBe("Timed out");
  });
});
