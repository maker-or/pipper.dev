import { GitBranch } from "@phosphor-icons/react";
import type { Worktree } from "../../contracts/worktrees.ts";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/**
 * Point the hybrid shell's thread at a worktree. A draft binds the worktree it
 * will be created in; a live thread moves there (between turns, when one is
 * running). Shared by the composer's picker and the session panel.
 */
export async function pickThreadWorktree(
  worktree: Worktree,
  target: { draft: boolean; threadId: string | null },
): Promise<void> {
  if (target.draft) {
    useWorkspaceViewStore
      .getState()
      .setDraftWorktree(worktree.isProjectRoot ? null : worktree.path);
    return;
  }
  if (!target.threadId) return;
  try {
    const result = await window.omni.threads.move({
      threadId: target.threadId,
      workspace: worktree.path,
    });
    if (result.status === "unchanged") return;
    const leftBehind = result.leftBehind.length;
    toast({
      icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
      title:
        result.status === "after_turn"
          ? `Moves to ${result.workspace} after this turn`
          : `Moved to ${result.workspace}`,
      description:
        leftBehind > 0
          ? `${leftBehind} uncommitted ${leftBehind === 1 ? "file stays" : "files stay"} in the previous worktree.`
          : undefined,
    });
  } catch (err) {
    toast(errorToast(err instanceof Error ? err.message : "Could not move the thread."));
  }
}
