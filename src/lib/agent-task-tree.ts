import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";

export interface NestedThread<T extends { id: string }> {
  thread: T;
  /** 0 for a top-level thread, 1 for a task it started, and so on. */
  depth: number;
  /** The task this thread runs, when it is one. */
  task: AgentTaskSnapshot | null;
}

/**
 * Order threads so each task thread follows the thread that started it.
 * Order among siblings is kept from the input. A task whose parent is not in
 * the list (another page, or deleted) stays where it was, at its own depth 0.
 */
export function nestThreads<T extends { id: string }>(
  threads: T[],
  tasks: AgentTaskSnapshot[],
): NestedThread<T>[] {
  const taskByChild = new Map<string, AgentTaskSnapshot>();
  for (const task of tasks) if (task.childThreadId) taskByChild.set(task.childThreadId, task);
  const present = new Set(threads.map((thread) => thread.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parentId = taskByChild.get(thread.id)?.parentThreadId;
    if (parentId && parentId !== thread.id && present.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(thread);
      children.set(parentId, siblings);
    } else {
      roots.push(thread);
    }
  }
  const out: NestedThread<T>[] = [];
  const visited = new Set<string>();
  const visit = (thread: T, depth: number) => {
    // A corrupt cycle must never loop the renderer.
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    out.push({ thread, depth, task: taskByChild.get(thread.id) ?? null });
    for (const child of children.get(thread.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Threads only reachable through a cycle still appear once.
  for (const thread of threads) if (!visited.has(thread.id)) visit(thread, 0);
  return out;
}

const STATUS_TEXT: Record<AgentTaskSnapshot["status"], string> = {
  starting: "Starting",
  running: "Working",
  idle: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  timed_out: "Timed out",
  interrupted: "Interrupted",
};

/** Short status for a task thread's row, e.g. "Working" or "Has a question". */
export function taskStatusText(task: AgentTaskSnapshot): string {
  if (task.status === "running" && task.waitingForPermission) return "Needs permission";
  if (task.status === "idle" && task.outcome === "needs_input") return "Has a question";
  if (task.status === "idle" && task.outcome === "blocked") return "Blocked";
  return STATUS_TEXT[task.status];
}

/** Whether a task is still in flight: starting, working, or waiting on the user. */
export function taskInFlight(task: AgentTaskSnapshot): boolean {
  if (task.status === "starting" || task.status === "running") return true;
  return task.status === "idle" && task.outcome === "needs_input";
}

/** The task waits on the user: a permission prompt, or a question it ended on. */
export function taskNeedsUser(task: AgentTaskSnapshot): boolean {
  return (
    (task.status === "running" && task.waitingForPermission) ||
    (task.status === "idle" && task.outcome === "needs_input")
  );
}

/**
 * Threads with a subthread, at any depth, waiting on the user, so a tab can
 * show it even when the waiting thread has no tab of its own.
 */
export function threadsNeedingUser(tasks: AgentTaskSnapshot[]): Set<string> {
  const parentOf = new Map<string, string>();
  for (const task of tasks)
    if (task.childThreadId) parentOf.set(task.childThreadId, task.parentThreadId);
  const out = new Set<string>();
  for (const task of tasks) {
    if (!taskNeedsUser(task)) continue;
    // A corrupt cycle must never loop the renderer.
    for (
      let id: string | undefined = task.parentThreadId;
      id && !out.has(id);
      id = parentOf.get(id)
    ) {
      out.add(id);
    }
  }
  return out;
}
