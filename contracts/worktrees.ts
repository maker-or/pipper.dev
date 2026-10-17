/**
 * A git worktree ("workspace") nested under a project — an isolated working
 * directory on its own branch, sharing the project's git history.
 *
 * Git owns identity via path/branch, so there is deliberately no `id`: a
 * worktree is the shape of a parsed `git worktree list --porcelain` entry.
 */
export interface Worktree {
  /** Absolute path to the worktree's working directory. */
  path: string;
  /** Short branch ref checked out in the worktree, or null when detached. */
  branch: string | null;
  /** HEAD commit SHA. */
  head: string;
  /** True when this entry is the project's configured root checkout. */
  isProjectRoot?: boolean;
  /**
   * The checkout is gone: git reports the entry as prunable, or its directory
   * no longer exists. Git keeps listing such entries until
   * `git worktree prune`, so `listWorktrees` drops them — nothing can run
   * there. Only the raw porcelain parse ever reports this as true.
   */
  missing?: boolean;
  /** Git-derived label for this workspace (the default branch for the root). */
  workspaceName?: string;
  /**
   * Worktree directory creation time (ms). `git worktree list` emits readdir
   * order (effectively arbitrary), so UIs sort newest-first on this instead.
   * Absent for the project root and when the filesystem reports nothing.
   */
  createdAtMs?: number;
}

/**
 * A local Git branch (`refs/heads/*`) selectable in the title bar. Phase 1 is
 * local-only; remote branches are a later addition (they'd need checking out as
 * a tracking branch on selection, which `switchWorktreeBranch` doesn't do yet).
 */
export interface GitBranch {
  /** Display name, e.g. `feature/titlebar`. */
  name: string;
  /** The worktree currently holding this branch, if Git reports one. */
  worktreePath: string | null;
}

export interface CreateWorktreeInput {
  projectId: string;
  /** Human label; used to derive the on-disk dir name and default branch. */
  name: string;
}

/**
 * Newest-first for linked worktrees (project root always pins top).
 * `git worktree list` emits readdir order, so creation order must come from
 * `createdAtMs`; entries without it keep git's relative order at the end.
 */
export function orderWorktreesForDisplay(worktrees: Worktree[]): Worktree[] {
  const root = worktrees.filter((item) => item.isProjectRoot);
  const rest = worktrees
    .filter((item) => !item.isProjectRoot)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = a.item.createdAtMs ?? -1;
      const bt = b.item.createdAtMs ?? -1;
      if (at !== bt) return bt - at;
      return a.index - b.index;
    })
    .map(({ item }) => item);
  return [...root, ...rest];
}

/**
 * How a new workspace is set up after its Git checkout exists:
 * `prepared` installs dependencies in the background, `source-only` leaves
 * that to the user. Desktop and remote creation share this policy.
 */
export type WorkspaceSetupPolicy = "source-only" | "prepared";

/**
 * Who is waiting on a new workspace: `foreground` for the desktop user, who
 * gets progress notifications; `background` for remote/phone tasks, whose
 * setup must not interrupt the desktop UI.
 */
export type WorkspaceActivation = "foreground" | "background";

/**
 * Progress of the background setup that follows a worktree create (the
 * project's setup script, or else the automatic dependency install),
 * broadcast to the renderer for toasts. `skipped` means there was nothing to
 * run (no script and no Node dependency manifest, or the policy is
 * source-only) or the workspace went away first.
 */
export interface WorktreeSetupProgress {
  projectId: string;
  worktreePath: string;
  workspaceName: string;
  policy?: WorkspaceSetupPolicy;
  activation?: WorkspaceActivation;
  status: "installing" | "installed" | "failed" | "skipped";
  /** `script`: the project's setup script; `install`: automatic install. */
  source?: "script" | "install";
  /** Package manager used (bun/pnpm/yarn/npm) when installing. */
  manager?: string;
  /** Failure detail (last lines of install output). */
  message?: string;
}
