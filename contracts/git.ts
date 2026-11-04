/**
 * First-party git state for the advanced workspace UI. One workspace =
 * one worktree, so every query is scoped to a worktree path.
 */

export interface WorkspaceGitFile {
  path: string;
  staged: boolean;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /**
   * Lines added in the working tree (untracked files count all their lines).
   * `null` when git reports no line counts (binary, oversized, or unreadable).
   */
  additions: number | null;
  /** Lines removed in the working tree; `null` when unknown. */
  deletions: number | null;
}

/**
 * Whether git state could be read for a workspace.
 * - `ready`: git answered; every field below is meaningful.
 * - `absent`: there is genuinely no repository at this path. Initializing
 *   one is the legitimate fix, and only here.
 * - `broken`: the path carries repository metadata but git would not answer
 *   — an orphaned worktree admin dir, a moved checkout, or a transient
 *   failure (spawn error, timeout, lock contention). The repository exists,
 *   so never offer to initialize one: it cannot help and would act on the
 *   wrong tree.
 *
 * These were one boolean until a worktree whose admin directory had been
 * pruned reported "not a git repository" and the panel offered to create
 * one inside an existing repo.
 */
export type WorkspaceRepoState = "ready" | "absent" | "broken";

/**
 * Whether a *project root* can host a workspace worktree — read before
 * creating one, when the project root is not yet a workspace.
 *
 * Extends `WorkspaceRepoState` with `unborn`: the repository exists but has
 * no commits, so `git worktree add` has no commit to branch from and every
 * workspace create fails. It is a distinct state because the fix is an
 * initial commit, not an init — folding it into `absent` would offer to
 * initialize a repository that already exists.
 */
export type ProjectRepoState = WorkspaceRepoState | "unborn";

export interface WorkspaceGitStatus {
  repoState: WorkspaceRepoState;
  branch: string | null;
  /** Upstream of the current branch, e.g. "origin/pipper/foo". */
  upstream: string | null;
  /**
   * Commits not yet published. With an upstream this is the usual
   * ahead-of-@{u} count; without one it is the count beyond the base branch
   * (what a first push would publish).
   */
  ahead: number;
  behind: number;
  /**
   * Commits on this branch beyond the base branch (origin default, else
   * main). Distinguishes "pushed, nothing to do yet" from "pushed, ready
   * for a PR" — `ahead` alone reads 0 for both once in sync.
   */
  aheadOfBase: number;
  /**
   * Commits on the base branch this branch does not have yet — "the team
   * has new changes". Measured against the local remote-tracking ref, so it
   * only moves after a fetch; `baseFetchedAt` says how current that is.
   */
  behindBase: number;
  /** Ref the base counts are measured against, e.g. "origin/main". */
  baseBranch: string | null;
  /**
   * Time of the last successful background fetch of the base branch for this
   * workspace, or null when none has completed (no remote, offline, or not
   * yet attempted).
   */
  baseFetchedAt: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Capped file list for the panel (newest/significant first). */
  files: WorkspaceGitFile[];
  truncated: boolean;
  /**
   * Lines the workspace changes against its base branch (merge base to
   * working tree, untracked files included): what a PR from here would
   * carry. Null when there is no base to measure against.
   */
  branchLines: { additions: number; deletions: number } | null;
  /** Remote URL host (github.com, …) when a remote exists. */
  remoteHost: string | null;
  /** "owner/name" of the GitHub origin; null for other hosts or no remote. */
  repository: string | null;
  /** True when the `gh` CLI is available for PR operations. */
  ghAvailable: boolean;
  /** Existing open PR number for the branch, when known. */
  openPrNumber: number | null;
  openPrUrl: string | null;
  /** True when the open PR is a draft. */
  isDraftPr: boolean;
  /**
   * Most recent merged PR for the branch, only reported when no PR is open.
   * Drives the "merged — archive or continue" state.
   */
  mergedPrNumber: number | null;
  mergedPrUrl: string | null;
  /** Aggregate CI state for the open PR. `none` = no check runs reported. */
  checksState: "unknown" | "none" | "pending" | "passing" | "failing";
  /** Per-check detail for the open PR's head commit (deduped by name, latest run). */
  checks: WorkspacePrCheck[];
  /** Rich detail for the open PR, or the merged one when nothing is open. */
  pr: WorkspacePr | null;
  /**
   * Freshness of the GitHub-derived fields above. Local git fields remain
   * live even when this is stale or unavailable.
   */
  prDataState: "fresh" | "stale" | "unavailable";
  /** Time of the last successful GitHub response used by this status. */
  prUpdatedAt: number | null;
  /**
   * A background GitHub refresh is in flight, so a newer answer is coming
   * shortly. GitHub is never awaited by a status read — it answers in ~1s
   * against ~70ms for all local git — so the panel paints local state now and
   * re-reads soon after instead of waiting for its next poll.
   */
  prRefreshing: boolean;
}

export type WorkspacePrCheckState = "pending" | "passing" | "failing" | "skipped";

export interface WorkspacePrCheck {
  name: string;
  state: WorkspacePrCheckState;
  /** Run length when the check has both timestamps. */
  durationMs: number | null;
  url: string | null;
}

export interface WorkspacePrDeployment {
  environment: string;
  state: "pending" | "success" | "failure" | "inactive";
  url: string | null;
}

export interface WorkspacePrComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  /** Full body, capped; the panel shows a one-line preview. */
  body: string;
  url: string | null;
  createdAt: string;
  /** Set for inline review comments. */
  path: string | null;
  line: number | null;
}

/** What the panel shows for a filed (draft or ready) or merged PR. */
export interface WorkspacePr {
  number: number;
  url: string;
  title: string;
  body: string;
  isDraft: boolean;
  state: "open" | "merged";
  /** PR line totals; null when GitHub didn't report them (older snapshots). */
  additions: number | null;
  deletions: number | null;
  deployments: WorkspacePrDeployment[];
  /** Issue comments then review-thread openers, oldest first, capped. */
  comments: WorkspacePrComment[];
}

export interface WorkspaceGitActionResult {
  ok: boolean;
  message: string;
  /** PR URL for create-pr. */
  url?: string | null;
}
