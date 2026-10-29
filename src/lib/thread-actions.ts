import type { Project } from "../../contracts/projects.ts";
import type { Thread } from "../../contracts/threads.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { useAgentStore } from "@/store/agent-store";
import { useProjectStore } from "@/store/project-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/** Benchmark runs drive thread switches from Playwright. Never block on a draft confirm. */
export function confirmDiscardDraft(): boolean {
  if (typeof window !== "undefined" && window.omni?.benchmark?.enabled) return true;
  return window.confirm("Discard the new thread draft?");
}

/**
 * Switch the active agent thread and make the agent view the visible mode.
 *
 * Callable from anywhere (header tab strip, orchestration flow) — it reads
 * live store state via `getState()` rather than closing over React state, so
 * there is a single implementation of the optimistic-switch handshake:
 * `requestedThreadId` is set immediately, then cleared by the header once the
 * agent snapshot catches up (see `GlobalTabBar`).
 */
export async function selectThread(
  id: string,
  options: { activateView?: boolean } = {},
): Promise<void> {
  const view = useWorkspaceViewStore.getState();
  if (options.activateView ?? true) view.showAgent();
  const agent = useAgentStore.getState();
  // The displayed snapshot stays on the old thread while another activation
  // is pending. Clicking it again must supersede that activation in main.
  if (id === agent.snapshot?.threadId && agent.pendingThreadTarget == null) {
    view.requestThread(null);
    return;
  }
  view.requestThread(id);
  try {
    await useAgentStore.getState().switchThread(id);
  } catch (err) {
    // Clear the optimistic requestedThreadId only if it still matches the current request
    const currentRequestedId = useWorkspaceViewStore.getState().requestedThreadId;
    if (currentRequestedId === id) {
      view.requestThread(null);
    }
    throw err;
  }
}

/**
 * Bring a finished background thread on screen. Threads can live in another
 * project or workspace than the one being viewed; the advanced tab strip only
 * shows the active workspace's tabs, so the project and workspace are
 * switched first or the thread would be selected but invisible.
 */
export async function openThreadAnywhere(thread: Thread, projects?: Project[]): Promise<void> {
  projects ??= await window.omni.projects.list();
  const project = projects.find((item) => item.id === thread.project_id);
  if (project && project.id !== useProjectStore.getState().activeProject?.id) {
    await window.omni.projects.setActive(project.id);
  }
  if (project) {
    const worktrees = useWorktreeStore.getState();
    const current = normalizeWorkspacePath(
      worktrees.selectedWorktreePathByProject[project.id],
      project.path,
    );
    const target = normalizeWorkspacePath(thread.worktree_path, project.path);
    if (target !== current) {
      await worktrees.switchWorktree(project.id, target ?? project.path);
    }
  }
  await selectThread(thread.id);
}
