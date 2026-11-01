import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { useAgentStore } from "@/store/agent-store";
import { useUiModeStore, workspaceFollowsThread } from "@/store/ui-mode-store";
import { useWorktreeStore } from "@/store/worktree-store";

/**
 * The worktree a new draft for `project` starts in (null for the project
 * root). Where the workspace follows the displayed thread (basic and hybrid),
 * a draft opened from that thread starts where the thread runs, so "new
 * thread" lands beside the work on screen. Otherwise, and for any other
 * project, it is the project's selected worktree.
 */
export function newDraftWorktreePath(
  project: { id: string; path: string | null | undefined } | null,
): string | null {
  if (!project) return null;
  const thread = useAgentStore.getState().state;
  if (
    workspaceFollowsThread(useUiModeStore.getState().mode) &&
    thread?.threadId &&
    thread.projectId === project.id &&
    thread.cwd
  ) {
    return normalizeWorkspacePath(thread.cwd, project.path ?? null);
  }
  return normalizeWorkspacePath(
    useWorktreeStore.getState().selectedWorktreePathByProject[project.id],
    project.path ?? null,
  );
}
