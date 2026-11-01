import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import type { HeaderTone } from "@/lib/workspace-tone";

/** Local git poll; GitHub data rides its own longer cadence in main. */
const POLL_MS = 30_000;

/** Re-read after a status arrives with a GitHub refresh in flight. */
const PR_FOLLOW_UP_MS = 1_500;

/**
 * Why a PR can't be created from this workspace right now, or null when it
 * can. Shared by every surface that offers "Create PR".
 */
export function prBlocker(status: WorkspaceGitStatus): string | null {
  if (status.remoteHost !== "github.com") return "PRs need a GitHub remote";
  if (!status.ghAvailable) return "Install the GitHub CLI (gh) to create PRs";
  if (status.prDataState !== "fresh") return "Refresh GitHub before creating a PR";
  return null;
}

/**
 * Whether the base branch carries work this workspace still needs.
 *
 * A merged workspace is always "behind" its base and has nothing to catch up
 * on: once its own PR lands, the base contains that very work (plus the merge
 * commit), so `behindBase` counts the workspace's own landed changes.
 */
export function hasTeamChanges(status: WorkspaceGitStatus): boolean {
  if (status.behindBase === 0) return false;
  const merged = !status.openPrNumber && status.mergedPrNumber !== null;
  return !merged;
}

/**
 * A workspace's git-state tone, which every shell colors it with:
 * - neutral: no PR yet (fresh worktree or work in progress)
 * - action:  PR open but something blocks merging (dirty tree, draft,
 *            checks running or failing)
 * - ready:   PR open, tree clean, checks green — merge is the next step
 * - merged:  the branch's PR landed — delete the workspace or continue on
 *            a fresh branch
 * - stale:   no PR and nothing of the user's own to save or share, but the
 *            base branch has moved on — catching up is the next step
 */
export function workspaceGitTone(status: WorkspaceGitStatus): HeaderTone {
  if (status.repoState !== "ready") return "neutral";
  const dirtyCount = status.staged + status.unstaged + status.untracked;
  if (!status.openPrNumber) {
    if (status.mergedPrNumber) return "merged";
    // An idle workspace the team has moved past: the only thing to do here
    // is catch up. With unsaved or unpushed work the tone stays neutral and
    // the user's own work comes first.
    const idle = dirtyCount === 0 && status.ahead === 0;
    return idle && hasTeamChanges(status) ? "stale" : "neutral";
  }
  if (status.isDraftPr) return "action";
  if (dirtyCount > 0 || status.ahead > 0) return "action";
  if (status.checksState === "passing") return "ready";
  if (status.checksState === "none" || status.checksState === "unknown") return "ready";
  return "action";
}

/**
 * Git status for one workspace, polled while the window is visible and
 * re-read on demand. Every read carries the workspace it was asked for, and a
 * read that lands after the workspace changed is dropped, so one workspace's
 * status can never paint over another's.
 */
export function useWorkspaceGitStatus(
  projectId: string | null,
  worktreePath: string | null,
): { status: WorkspaceGitStatus | null; refresh: (force?: boolean) => Promise<void> } {
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const keyRef = useRef<string | null>(null);
  const key = projectId && worktreePath ? `${projectId}\u0000${worktreePath}` : null;
  keyRef.current = key;

  const refresh = useCallback(
    async (force = false) => {
      if (!projectId || !worktreePath || !window.omni?.git?.status) return;
      const asked = `${projectId}\u0000${worktreePath}`;
      try {
        const next = await window.omni.git.status({ projectId, path: worktreePath, force });
        if (keyRef.current !== asked) return;
        // The poll usually returns the same picture; keep the old object so
        // nothing re-renders for it.
        setStatus((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch {
        // Keep the last good status through a passing IPC failure.
      }
    },
    [projectId, worktreePath],
  );

  useEffect(() => {
    setStatus(null);
    if (!key) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [key, refresh]);

  useEffect(() => {
    if (!status?.prRefreshing) return;
    const id = setTimeout(() => {
      if (!document.hidden) void refresh();
    }, PR_FOLLOW_UP_MS);
    return () => clearTimeout(id);
  }, [status?.prRefreshing, status?.prUpdatedAt, refresh]);

  return { status, refresh };
}
