import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  ArrowUpRight,
  CheckCircle,
  DotsThreeVertical,
  GitBranch,
  GitCommit,
  GitPullRequest,
  WarningCircle,
} from "@phosphor-icons/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type { Project } from "../../contracts/projects.ts";
import type { WorkspaceGitStatus, WorkspacePrComment } from "../../contracts/git.ts";
import { Button } from "@/components/ui/button";
import { Dropdown } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { useAgentStore } from "@/store/agent-store";
import { useDiffStore } from "@/store/diff-store";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  buildCommitPrompt,
  buildGetLatestPrompt,
  buildPrCommentsPrompt,
  sendWorkspaceAgentPrompt,
} from "@/lib/workspace-agent-prompt";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { WorkspacePrDetail, type PrStatusItem } from "@/components/workspace-pr-detail";
import { openFilePreview } from "@/lib/file-preview-actions";
import { SplitButton, type SplitMenuItem } from "@/components/workspace-split-button";

/**
 * Local git poll. Only reads the worktree (subprocesses, no network and no
 * API quota), but each tick spawns ~10 git processes, and the panel re-reads
 * immediately after every action anyway — so a slower tick costs nothing the
 * user notices. GitHub data rides its own, much longer cadence
 * (`PR_REFRESH_INTERVAL_MS` in electron/git-workspace.ts).
 */
const POLL_MS = 30_000;

/**
 * Follow-up read after a status arrives with a GitHub refresh in flight, so
 * PR data lands about a second after the workspace paints rather than on the
 * next poll.
 */
const PR_FOLLOW_UP_MS = 1_500;

/**
 * Last known status per workspace, so switching back to one paints instantly
 * instead of showing "Reading git state…" while git is re-read.
 *
 * Bounded and keyed by project + worktree: a workspace's controls must never
 * render against another workspace's state, and an unbounded map would keep
 * every workspace ever visited alive for the session. Insertion order makes
 * this an LRU — re-inserting on write moves an entry to the end.
 */
const STATUS_CACHE_LIMIT = 12;
const statusCache = new Map<string, WorkspaceGitStatus>();

function statusCacheKey(projectId: string, worktreePath: string): string {
  return `${projectId}\u0000${worktreePath}`;
}

function readCachedStatus(projectId: string | null, worktreePath: string | null) {
  if (!projectId || !worktreePath) return null;
  return statusCache.get(statusCacheKey(projectId, worktreePath)) ?? null;
}

function writeCachedStatus(
  projectId: string | null,
  worktreePath: string | null,
  status: WorkspaceGitStatus,
): void {
  if (!projectId || !worktreePath) return;
  // Only a good read is worth remembering. A degraded snapshot (`broken` /
  // `absent`) is usually a passing hiccup (spawn failure, timeout, an index
  // lock held by the agent mid-commit), and the panel re-fetches on every
  // poll anyway — caching it would re-paint "couldn't read git state" on every
  // return to this workspace until a clean read lands, making a healthy
  // checkout look dead.
  if (status.repoState !== "ready") return;
  const key = statusCacheKey(projectId, worktreePath);
  statusCache.delete(key);
  statusCache.set(key, status);
  while (statusCache.size > STATUS_CACHE_LIMIT) {
    const oldest = statusCache.keys().next().value;
    if (oldest === undefined) break;
    statusCache.delete(oldest);
  }
}

function notify(kind: "ok" | "error", title: string, description?: string) {
  toast({
    icon:
      kind === "ok" ? (
        <CheckCircle className="size-5 text-emerald-500" weight="fill" />
      ) : (
        <WarningCircle className="size-5 text-destructive" weight="fill" />
      ),
    title,
    description,
  });
}

/** Human title for action toasts. */
function actionLabel(kind: string): string {
  switch (kind) {
    case "commit":
      return "Commit handed to agent";
    case "commitPush":
      return "Commit and push handed to agent";
    case "getLatest":
      return "Catching up handed to agent";
    case "push":
      return "Pushed";
    case "pr":
      return "Pull request created";
    case "mergePr":
      return "Pull request merged";
    case "merge":
      return "Merged";
    case "ready":
      return "Ready for review";
    case "continue":
      return "New branch started";
    case "init":
      return "Repository initialized";
    default:
      return "Done";
  }
}

/**
 * Header tone is git truth:
 * - neutral: no PR yet (fresh worktree or work in progress)
 * - action:  PR open but something blocks merging (dirty tree, draft,
 *            checks running or failing)
 * - ready:   PR open, tree clean, checks green — merge is the next step
 * - merged:  the branch's PR landed — delete the workspace or continue on
 *            a fresh branch
 * - stale:   no PR and nothing of the user's own to save or share, but the
 *            base branch has moved on — catching up is the next step
 */
import type { HeaderTone } from "@/lib/workspace-tone";
import { WorkspaceStateAction, WorkspaceStateSurface } from "@/components/workspace-state";

// Re-exported so existing consumers keep importing the tone vocabulary from
// this component; the source of truth is `@/lib/workspace-tone`.
export {
  type HeaderTone,
  HEADER_TONE_GRADIENT,
  HEADER_TONE_COLOR,
  toneInsetShadow,
  toneWash,
} from "@/lib/workspace-tone";

function headerTone(status: WorkspaceGitStatus, dirtyCount: number): HeaderTone {
  if (!status.openPrNumber) {
    if (status.mergedPrNumber) return "merged";
    // An idle workspace the team has moved past: the only thing to do here
    // is catch up. With unsaved or unpushed work the header stays neutral
    // and the primary button (save/share) keeps the user's own work first.
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

/** Plain-language name for the base branch a workspace branched from. */
function baseBranchLabel(status: WorkspaceGitStatus): string {
  return status.baseBranch?.replace(/^origin\//, "") ?? "main";
}

/** Why PR creation is unavailable, or null when it is possible. */
function prBlocker(status: WorkspaceGitStatus): string | null {
  if (status.remoteHost !== "github.com") return "PRs need a GitHub remote";
  if (!status.ghAvailable) return "Install the GitHub CLI (gh) to create PRs";
  if (status.prDataState !== "fresh") return "Refresh GitHub before creating a PR";
  return null;
}

/** Git work currently delegated to this workspace's agent thread. */
type AgentTask = "commit" | "commitPush" | "getLatest";

// Loaded when the Files tab first opens, keeping the tree out of the panel's chunk.
const ProjectFileTree = lazy(() =>
  import("@/components/project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);

type PanelTab = "check" | "changes" | "files";

/** Where the Changes tab reads its file list from. */
type ChangesSource = "turn" | "git";

interface FileChange {
  path: string;
  /** null when the line count is unknown (e.g. a binary file). */
  additions: number | null;
  deletions: number | null;
}

/** Split a path into its directory prefix and file name for display. */
function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

/** `#123 ↗` pill linking to the open (or just-merged) PR. */
function prPill(status: WorkspaceGitStatus, tone: HeaderTone) {
  const number = status.openPrNumber ?? status.mergedPrNumber;
  const url = status.openPrUrl ?? status.mergedPrUrl;
  if (!number || !url) return null;
  return (
    <WorkspaceStateAction
      tone={tone}
      appearance="tag"
      onClick={() => void window.omni.shell.openExternal(url)}
      title="Open pull request on GitHub"
      className="overflow-hidden rounded-full gap-0 px-0"
    >
      <span className="px-2.5">#{number}</span>
      <span
        className="flex h-full items-center px-1.5"
        style={{ backgroundColor: "var(--workspace-state-tag-arrow-fill)" }}
      >
        <ArrowUpRight size={13} />
      </span>
    </WorkspaceStateAction>
  );
}

export function WorkspaceControlPanel({
  project,
  worktreePath,
  workspaceName,
  onContinued,
  onToneChange,
  onDelete,
}: {
  project: Project | null;
  worktreePath: string | null;
  workspaceName: string | null;
  /** Parked by the user: catch-up prompts stay quiet until it is restored. */
  /** Fired after "Continue" moved the worktree onto a new branch. */
  onContinued?: () => Promise<void> | void;
  /** Reports the current header tone so the shell can tint the active
   *  workspace card with the matching gradient. */
  onToneChange?: (tone: HeaderTone) => void;
  /** Delete the selected workspace. Absent for the project root. */
  onDelete?: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [showPrForm, setShowPrForm] = useState(false);
  const [prDraft, setPrDraft] = useState(false);
  const [pickedTab, setPickedTab] = useState<PanelTab | null>(null);
  const [changesSource, setChangesSource] = useState<ChangesSource>("git");
  const [changesMenuOpen, setChangesMenuOpen] = useState(false);
  const changesMenuButtonRef = useRef<HTMLButtonElement>(null);
  const changesMenuRef = useRef<HTMLDivElement>(null);
  /** Consecutive `broken` reads while a good status is on screen. */
  const brokenReadsRef = useRef(0);
  /** Agent turn we handed a commit to; cleared when that turn settles. */
  const [agentTask, setAgentTask] = useState<AgentTask | null>(null);
  const diffFiles = useDiffStore((state) => state.files);
  const diffOrder = useDiffStore((state) => state.order);
  const diffThreadId = useDiffStore((state) => state.threadId);
  const openDiff = useDiffStore((state) => state.open);
  const setDiffActivePath = useDiffStore((state) => state.setActivePath);
  const agentThreadId = useAgentStore((state) => state.state?.threadId ?? null);
  const agentProjectId = useAgentStore((state) => state.state?.projectId ?? null);
  const agentCwd = useAgentStore((state) => state.state?.cwd ?? null);
  /**
   * Bumped on every workspace switch. Every async result (status poll, the
   * agent's commit turn) captures the generation it started under and is
   * dropped if the panel has since moved on — so a slow poll or a late turn
   * from workspace A can never paint over workspace B, including A → B → A.
   */
  const generationRef = useRef(0);
  /** Mirrors `status` so refresh can decide without re-subscribing. */
  const statusRef = useRef<WorkspaceGitStatus | null>(null);

  /**
   * Set the status, keeping the previous object when the payload is
   * identical — the 15s poll usually returns the same picture, and swapping
   * objects would re-render the whole panel (and re-fire the tone effect)
   * for nothing.
   */
  const applyStatus = useCallback(
    (next: WorkspaceGitStatus | null) => {
      setStatus((prev) => {
        const value = next && prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
        statusRef.current = value;
        return value;
      });
      if (next) writeCachedStatus(project?.id ?? null, worktreePath, next);
    },
    [project?.id, worktreePath],
  );

  const statusRequestRef = useRef(0);
  const forcedRefreshesRef = useRef(0);
  const forcedGenerationRef = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      // Polls must not replace the authoritative post-action read with cached PR data.
      if (
        !force &&
        forcedGenerationRef.current === generationRef.current &&
        forcedRefreshesRef.current > 0
      )
        return;
      if (!project || !worktreePath) {
        applyStatus(null);
        return;
      }
      if (!window.omni?.git?.status) {
        // Preload predates the git bridge (needs app restart, not just HMR).
        applyStatus(null);
        setError("Git bridge missing — restart the app (bun run dev) to load it.");
        return;
      }
      const generation = generationRef.current;
      const request = ++statusRequestRef.current;
      if (force) {
        if (forcedGenerationRef.current !== generation) forcedRefreshesRef.current = 0;
        forcedGenerationRef.current = generation;
        forcedRefreshesRef.current += 1;
      }
      const stale = () =>
        generation !== generationRef.current || request !== statusRequestRef.current;
      // The loading placeholder only shows before the first read; background
      // polls refresh silently instead of flashing state twice per tick.
      if (!statusRef.current) setLoading(true);
      setError(null);
      try {
        const next = await window.omni.git.status({
          projectId: project.id,
          path: worktreePath,
          force,
        });
        if (stale()) return;
        // A `broken` read can be a passing hiccup (spawn failure, timeout, an
        // index lock held by the agent mid-commit). Replacing a working panel
        // with an error on the first one makes routine git activity look like
        // a dead workspace, so absorb a single blip and act on the second.
        if (next.repoState === "broken" && statusRef.current?.repoState === "ready") {
          brokenReadsRef.current += 1;
          if (brokenReadsRef.current < 2) return;
        } else {
          brokenReadsRef.current = 0;
        }
        applyStatus(next);
      } catch (err) {
        if (stale()) return;
        // Preserve last-known-good state during transient IPC/main-process
        // failures. A workspace switch clears status before starting its own
        // generation, so this can never retain data from another workspace.
        setError(err instanceof Error ? err.message : "Git status failed.");
      } finally {
        if (force && forcedGenerationRef.current === generation) forcedRefreshesRef.current -= 1;
        if (!stale()) setLoading(false);
      }
    },
    [project, worktreePath, applyStatus],
  );

  useEffect(() => {
    generationRef.current += 1;
    statusRequestRef.current += 1;
    brokenReadsRef.current = 0;
    // Paint this workspace's last known status immediately when we have one:
    // a cold read is ~70ms of git but the panel would otherwise blank out on
    // every switch. Keyed by project + worktree, so this can only ever show
    // the selected workspace's own state, never the previous one's.
    // Otherwise drop the previous workspace's status: until the fresh read
    // lands, its PR/branch controls would otherwise stay rendered and
    // interactive while every handler already targets the new worktree.
    applyStatus(readCachedStatus(project?.id ?? null, worktreePath));
    setError(null);
    setNotice(null);
    setAgentTask(null);
    setAction(null);
    setShowPrForm(false);
    setPrDraft(false);
    setPickedTab(null);
    setChangesMenuOpen(false);
    setPrTitle(workspaceName ?? "");
    void refresh();
  }, [refresh, workspaceName, applyStatus, project?.id, worktreePath]);

  // A status that arrived with a GitHub refresh in flight has a newer answer
  // moments away; re-read once rather than leaving the PR section empty until
  // the next poll.
  useEffect(() => {
    if (!status?.prRefreshing) return;
    const id = setTimeout(() => {
      if (!document.hidden) void refresh();
    }, PR_FOLLOW_UP_MS);
    return () => clearTimeout(id);
  }, [status?.prRefreshing, status?.prUpdatedAt, refresh]);

  useEffect(() => {
    if (!project || !worktreePath) return;
    // Poll only while visible — a hidden window spawning git/gh process trees
    // every 15s is pure overhead — and re-read immediately on reveal so the
    // panel is never staler than it was when hidden.
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
  }, [project, worktreePath, refresh]);

  useEffect(() => {
    if (!changesMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        changesMenuButtonRef.current?.contains(target) ||
        changesMenuRef.current?.contains(target)
      )
        return;
      setChangesMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setChangesMenuOpen(false);
      changesMenuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [changesMenuOpen]);

  /** Runs a git action with toasts; resolves `true` only when it succeeded. */
  const runAction = useCallback(
    async (
      kind: string,
      fn: () => Promise<{ message: string; url?: string | null }>,
    ): Promise<boolean> => {
      if (!project || !worktreePath) return false;
      const generation = generationRef.current;
      setAction(kind);
      setError(null);
      setNotice(null);
      try {
        const result = await fn();
        if (generation !== generationRef.current) return true;
        setNotice(result.message);
        notify("ok", actionLabel(kind), result.message);
        // Opening the browser is a courtesy, not part of the action: the PR
        // exists whether or not the OS could open it.
        if (result.url && window.omni?.shell?.openExternal) {
          void window.omni.shell.openExternal(result.url).catch(() => {});
        }
        return true;
      } catch (err) {
        if (generation !== generationRef.current) return false;
        const message = err instanceof Error ? err.message : `${kind} failed.`;
        setError(message);
        notify("error", `${actionLabel(kind)} failed`, message);
        return false;
      } finally {
        if (generation === generationRef.current) {
          await refresh(true);
          if (generation === generationRef.current) setAction(null);
        }
      }
    },
    [project, worktreePath, refresh],
  );

  const dirtyCount = (status?.staged ?? 0) + (status?.unstaged ?? 0) + (status?.untracked ?? 0);
  // A repository can only be created for the project itself; a worktree
  // always belongs to one already.
  const isProjectRoot = normalizeWorkspacePath(worktreePath, project?.path ?? null) === null;
  const unpushed = status?.ahead ?? 0;
  const behind = status ? hasTeamChanges(status) : false;
  const busy = action !== null || agentTask !== null;
  const tone: HeaderTone =
    status?.repoState === "ready" ? headerTone(status, dirtyCount) : "neutral";
  // Default tab follows what the tone is about: merge/check state → Check,
  // local work → Changes.
  const tab: PanelTab =
    pickedTab ?? (tone === "ready" || tone === "merged" || dirtyCount === 0 ? "check" : "changes");

  // Keep the shell's active-card gradient in lockstep with this header.
  useEffect(() => {
    onToneChange?.(tone);
  }, [tone, onToneChange]);

  // Agent changes come from the diff store's active-thread projection. That
  // projection is swapped after paint (DiffIngestor effect) and the active
  // thread itself follows a workspace switch asynchronously — only trust it
  // when the projection is for the active thread AND that thread runs in this
  // panel's worktree; otherwise a switch would briefly show (and let the user
  // open) the previous workspace's files under the new workspace's header.
  const turnDiffReady =
    diffThreadId !== null &&
    diffThreadId === agentThreadId &&
    agentProjectId === (project?.id ?? null) &&
    normalizeWorkspacePath(agentCwd, project?.path ?? null) ===
      normalizeWorkspacePath(worktreePath, project?.path ?? null);
  // Key the recount on each file's content version so streaming edits don't
  // re-parse unchanged files on every render.
  const turnSignature = diffOrder
    .map((path) => `${path}:${diffFiles[path]?.updatedAt ?? 0}`)
    .join("|");
  const turnChanges = useMemo<FileChange[]>(() => {
    return diffOrder.map((path) => {
      const entry = diffFiles[path];
      if (!entry) return { path, additions: null, deletions: null };
      try {
        const parsed = parseDiffFromFile(
          { name: path, contents: entry.oldText },
          { name: path, contents: entry.newText },
        );
        return {
          path,
          additions: parsed.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
          deletions: parsed.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
        };
      } catch {
        return { path, additions: null, deletions: null };
      }
    });
    // turnSignature encodes diffOrder + per-file updatedAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnSignature]);
  const changes: FileChange[] =
    changesSource === "turn"
      ? turnDiffReady
        ? turnChanges
        : []
      : (status?.files ?? []).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        }));
  const totalAdditions = changes.reduce((total, file) => total + (file.additions ?? 0), 0);
  const totalDeletions = changes.reduce((total, file) => total + (file.deletions ?? 0), 0);
  // Hide the aggregate when no file reports line counts (all binary/unknown).
  const hasLineStats = changes.some((file) => file.additions !== null || file.deletions !== null);

  const openPrForm = (draft: boolean) => {
    setPrDraft(draft);
    setPickedTab("changes");
    setShowPrForm(true);
  };

  /**
   * Commit via the workspace's agent, not a raw `git commit`: hooks
   * (format/lint/test) differ per repo and only the agent can fix what they
   * reject. The prompt lands in this workspace's thread; git state is
   * re-read once the agent's turn ends.
   */
  /**
   * Hand a git task to this workspace's agent thread. Merging, conflict
   * resolution and commits all run there rather than as raw git calls: the
   * repo's hooks and the conflicted case need judgement the panel can't
   * apply, and the user can watch it happen in the thread.
   */
  const delegateToAgent = (input: {
    kind: AgentTask;
    title: string;
    message: string;
    pending: string;
  }) => {
    if (!project || !worktreePath || busy) return;
    const { kind } = input;
    setShowPrForm(false);
    setError(null);
    setNotice(null);
    setAgentTask(kind);
    const generation = generationRef.current;
    // A workspace switch already reset the panel; don't clobber its state.
    const stale = () => generation !== generationRef.current;
    const settle = async () => {
      if (stale()) return;
      await refresh(true);
      if (stale()) return;
      setAgentTask(null);
      setNotice(null);
    };
    void sendWorkspaceAgentPrompt({
      project,
      worktreePath,
      title: input.title,
      message: input.message,
    })
      .then(({ turn }) => {
        if (stale()) return;
        setNotice(input.pending);
        notify(
          "ok",
          actionLabel(kind),
          "Watch the thread for progress; the panel updates when it finishes.",
        );
        turn.then(settle, (err) => {
          if (stale()) return;
          const message = err instanceof Error ? err.message : "The agent did not finish.";
          setError(message);
          notify("error", `${actionLabel(kind)} failed`, message);
          settle();
        });
      })
      .catch((err) => {
        if (stale()) return;
        const message = err instanceof Error ? err.message : "Could not reach the agent.";
        setError(message);
        notify("error", `${actionLabel(kind)} failed`, message);
        setAgentTask(null);
      });
  };

  const delegateCommit = (push: boolean) => {
    if (!status || dirtyCount === 0) return;
    delegateToAgent({
      kind: push ? "commitPush" : "commit",
      title: workspaceName ? `${workspaceName}: commit` : "Commit",
      message: buildCommitPrompt({
        branch: status.branch,
        push,
        files: status.files.map((file) => file.path),
        truncated: status.truncated,
      }),
      pending: push ? "Agent is committing and pushing…" : "Agent is committing…",
    });
  };

  const delegateGetLatest = () => {
    if (!status) return;
    delegateToAgent({
      kind: "getLatest",
      title: workspaceName ? `${workspaceName}: get latest` : "Get latest",
      message: buildGetLatestPrompt({
        branch: status.branch,
        baseBranch: status.baseBranch,
        behindBase: status.behindBase,
        files: status.files.map((file) => file.path),
      }),
      pending: "Agent is catching this workspace up…",
    });
  };

  const runPush = () => {
    if (!project || !worktreePath || !status || busy) return;
    void runAction("push", () =>
      window.omni.git.push({ projectId: project.id, path: worktreePath }),
    );
  };

  const runMergePr = () => {
    if (
      !project ||
      !worktreePath ||
      !status?.openPrNumber ||
      status.prDataState !== "fresh" ||
      busy
    )
      return;
    if (
      !window.confirm(`Merge PR #${status.openPrNumber} on GitHub? The workspace branch is kept.`)
    )
      return;
    void runAction("mergePr", () =>
      window.omni.git.mergePr({ projectId: project.id, path: worktreePath }),
    );
  };

  const runLocalMerge = () => {
    if (!project || !worktreePath || !status?.branch || busy) return;
    if (
      !window.confirm(
        `Merge "${status.branch}" into the base branch in the project root? This does not open a PR.`,
      )
    )
      return;
    void runAction("merge", () =>
      window.omni.git.merge({ projectId: project.id, path: worktreePath }),
    );
  };

  const runMarkReady = () => {
    if (
      !project ||
      !worktreePath ||
      !status?.openPrNumber ||
      status.prDataState !== "fresh" ||
      busy
    )
      return;
    void runAction("ready", () =>
      window.omni.git.markPrReady({ projectId: project.id, path: worktreePath }),
    );
  };

  const addCommentsToChat = (comments: WorkspacePrComment[]) => {
    if (!project || !worktreePath || !status?.pr || comments.length === 0) return;
    void sendWorkspaceAgentPrompt({
      project,
      worktreePath,
      title: workspaceName ? `${workspaceName}: review comments` : "Review comments",
      message: buildPrCommentsPrompt({ prNumber: status.pr.number, comments }),
    })
      .then(() =>
        notify(
          "ok",
          comments.length === 1
            ? "Comment added to chat"
            : `${comments.length} comments added to chat`,
        ),
      )
      .catch((err) =>
        notify(
          "error",
          "Could not add to chat",
          err instanceof Error ? err.message : "Could not reach the agent.",
        ),
      );
  };

  /** Git-status checklist under the PR: each blocker with the button that clears it. */
  const prStatusItems = (status: WorkspaceGitStatus): PrStatusItem[] => {
    if (!status.pr) return [];
    if (status.pr.state === "merged") return [{ key: "merged", label: "Merged", done: true }];
    const items: PrStatusItem[] = [];
    if (status.isDraftPr) {
      items.push({
        key: "draft",
        label: "PR is in draft",
        action: {
          label: action === "ready" ? "Marking…" : "Ready for review",
          onClick: runMarkReady,
          disabled: busy || status.prDataState !== "fresh",
        },
      });
    }
    if (dirtyCount > 0) {
      items.push({
        key: "dirty",
        label: `${dirtyCount} uncommitted change${dirtyCount === 1 ? "" : "s"}`,
        action: {
          label: agentTask ? "Agent working…" : "Commit and push",
          onClick: () => delegateCommit(true),
          disabled: busy,
        },
      });
    } else if (unpushed > 0) {
      items.push({
        key: "unpushed",
        label: `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`,
        action: {
          label: action === "push" ? "Pushing…" : "Push",
          onClick: runPush,
          disabled: busy,
        },
      });
    }
    if (status.behind > 0) {
      items.push({
        key: "behind",
        label: `Someone pushed ${status.behind} ${status.behind === 1 ? "change" : "changes"} to this branch that you don’t have yet`,
      });
    }
    if (status.checksState === "pending") items.push({ key: "checks", label: "Checks running" });
    if (status.checksState === "failing") {
      const failing = status.checks.filter((check) => check.state === "failing").length;
      items.push({
        key: "checks",
        label: `${failing} check${failing === 1 ? "" : "s"} failing`,
      });
    }
    if (items.length === 0) {
      items.push({
        key: "ready",
        label: "Ready to merge",
        done: true,
        action: {
          label: action === "mergePr" ? "Merging…" : "Merge",
          onClick: runMergePr,
          disabled: busy || status.prDataState !== "fresh",
        },
      });
    }
    return items;
  };

  const runDelete = () => {
    if (!onDelete || busy) return;
    void runAction("delete", async () => {
      await onDelete();
      return { message: "Workspace deleted." };
    });
  };

  const runContinue = () => {
    if (!project || !worktreePath || busy) return;
    void runAction("continue", async () => {
      const worktree = await window.omni.worktrees.continue({
        projectId: project.id,
        path: worktreePath,
      });
      await onContinued?.();
      return { message: `Continuing on ${worktree.branch ?? "a new branch"}.` };
    });
  };

  /**
   * "Commit and push" when there is local work, "Push" when commits are
   * waiting, otherwise disabled. Shared by the no-PR and PR-open states.
   */
  const commitPushPrimary = (status: WorkspaceGitStatus) =>
    agentTask
      ? {
          label: "Agent working…",
          title: "The agent is committing in this workspace's thread",
          disabled: true,
          onPrimary: () => {},
        }
      : dirtyCount > 0
        ? {
            label: "Commit and push",
            title: "Ask the agent to commit and push this workspace branch",
            disabled: busy,
            onPrimary: () => delegateCommit(true),
          }
        : unpushed > 0
          ? {
              label: action === "push" ? "Pushing…" : "Push",
              title: status.upstream
                ? `Push ${unpushed} commit${unpushed === 1 ? "" : "s"}`
                : "Publish this branch",
              disabled: busy,
              onPrimary: runPush,
            }
          : {
              label: "Commit and push",
              title: "Nothing to commit or push",
              disabled: true,
              onPrimary: () => {},
            };

  /** Primary slot when the base has moved and catching up is the next step. */
  const getLatestPrimary = {
    label: agentTask === "getLatest" ? "Getting latest…" : "Get latest",
    title: "Ask the agent to bring this workspace up to date with the base branch",
    disabled: busy,
    onPrimary: delegateGetLatest,
  };

  const getLatestMenuItem: SplitMenuItem = {
    label: "Get latest",
    icon: <ArrowsClockwise size={14} />,
    disabled: busy,
    title: "Ask the agent to bring this workspace up to date with the base branch",
    onSelect: delegateGetLatest,
  };

  const commitMenuItem: SplitMenuItem = {
    label: "Commit",
    icon: <GitCommit size={14} />,
    disabled: dirtyCount === 0 || busy,
    title: dirtyCount === 0 ? "Nothing to commit" : "Ask the agent to commit without pushing",
    onSelect: () => delegateCommit(false),
  };

  const renderStateAction = (status: WorkspaceGitStatus) => {
    if (!status.openPrNumber) {
      // Fresh worktree, nothing happened yet: no action button. It appears
      // once there is anything to act on — dirty files, unpushed commits, or
      // a pushed branch that still needs a PR.
      if (dirtyCount === 0 && unpushed === 0 && status.aheadOfBase === 0 && !behind) return null;
      const blocker = prBlocker(status);
      // Pushed and clean: the next step is the PR, so it takes the primary slot
      // (and drops out of the menu — no point listing it twice).
      const prIsPrimary = dirtyCount === 0 && unpushed === 0 && !behind && !agentTask;
      const primary = behind
        ? getLatestPrimary
        : prIsPrimary
          ? {
              label: action === "pr" ? "Creating…" : "Create a PR",
              title: blocker ?? "Open a pull request for this branch",
              disabled: busy || blocker !== null,
              onPrimary: () => openPrForm(false),
            }
          : commitPushPrimary(status);
      const localMergeBlocked =
        dirtyCount > 0
          ? "Commit your changes first"
          : status.aheadOfBase === 0
            ? "No commits to merge"
            : null;
      return (
        <SplitButton
          tone={tone}
          {...primary}
          menuDisabled={busy}
          items={[
            ...(behind ? [] : [getLatestMenuItem]),
            commitMenuItem,
            ...(prIsPrimary
              ? []
              : [
                  {
                    label: "Create PR",
                    icon: <GitPullRequest size={14} />,
                    disabled: blocker !== null,
                    title: blocker ?? "Open a pull request for this branch",
                    onSelect: () => openPrForm(false),
                  },
                ]),
            {
              label: "Create draft PR",
              icon: <GitPullRequest size={14} />,
              disabled: blocker !== null,
              title: blocker ?? "Open a draft pull request for this branch",
              onSelect: () => openPrForm(true),
            },
            {
              label: "Merge locally",
              icon: <GitBranch size={14} />,
              disabled: busy || localMergeBlocked !== null,
              title:
                localMergeBlocked ??
                "Merge this branch into the base branch in the project root (no PR)",
              onSelect: runLocalMerge,
            },
          ]}
        />
      );
    }
    if (tone === "ready") {
      return (
        <WorkspaceStateAction
          tone="ready"
          disabled={busy || status.prDataState !== "fresh"}
          title={
            status.prDataState === "fresh"
              ? "Merge this pull request on GitHub"
              : "Refresh GitHub before merging"
          }
          onClick={runMergePr}
        >
          {action === "mergePr" ? "Merging…" : "Merge"}
        </WorkspaceStateAction>
      );
    }
    // Draft with nothing left to push: the next step is flipping the flag.
    if (status.isDraftPr && dirtyCount === 0 && unpushed === 0) {
      return (
        <WorkspaceStateAction
          tone="action"
          disabled={busy || status.prDataState !== "fresh"}
          title={
            status.prDataState === "fresh"
              ? "Mark this draft pull request ready for review"
              : "Refresh GitHub before changing the pull request"
          }
          onClick={runMarkReady}
        >
          {action === "ready" ? "Marking…" : "Ready for review"}
        </WorkspaceStateAction>
      );
    }
    // PR open but blocked: keep the commit/push control in reach; the Check
    // tab explains what is blocking (checks, draft).
    const readyItem: SplitMenuItem[] = status.isDraftPr
      ? [
          {
            label: "Ready for review",
            icon: <GitPullRequest size={14} />,
            disabled: busy || status.prDataState !== "fresh",
            title:
              status.prDataState === "fresh"
                ? "Mark this draft pull request ready for review"
                : "Refresh GitHub before changing the pull request",
            onSelect: runMarkReady,
          },
        ]
      : [];
    return (
      <SplitButton
        tone={tone}
        {...commitPushPrimary(status)}
        menuDisabled={busy}
        items={[...(behind ? [getLatestMenuItem] : []), commitMenuItem, ...readyItem]}
      />
    );
  };

  /** Merged state: the work landed — continue on a new branch, or delete. */
  const renderMergedActions = () => (
    <div className="flex shrink-0 items-center gap-1">
      <WorkspaceStateAction
        tone="merged"
        appearance="secondary"
        disabled={busy}
        title="Start a new branch off the latest base in this same workspace"
        onClick={runContinue}
      >
        {action === "continue" ? "Starting…" : "Continue"}
      </WorkspaceStateAction>
      <WorkspaceStateAction
        tone="merged"
        disabled={busy || !onDelete}
        title={
          onDelete
            ? "Delete this workspace, its branch checkout and its chats"
            : "The project root cannot be deleted"
        }
        onClick={runDelete}
      >
        {action === "delete" ? "Deleting…" : "Delete"}
      </WorkspaceStateAction>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {!project || !worktreePath ? (
        <div className="flex h-12 shrink-0 items-center px-4 text-xs font-semibold text-foreground">
          Workflow
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // The file tree scrolls itself; everything else scrolls the panel.
          (tab === "files" && status) || (project && !worktreePath)
            ? "overflow-hidden"
            : "overflow-y-auto pb-4",
        )}
      >
        {!project ? (
          <p className="px-4 text-xs leading-5 text-muted-foreground">
            Select a workspace to see its git state.
          </p>
        ) : !worktreePath ? (
          // The project root has no workspace card or git panel, but its
          // files must still be browsable.
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <p className="px-4 text-xs leading-5 text-muted-foreground">
              Select a workspace to see its git state. Project files:
            </p>
            <div className="min-h-0 flex-1" data-pipper-id="workspace-files">
              <Suspense fallback={null}>
                <ProjectFileTree projectId={project.id} worktreePath={null} />
              </Suspense>
            </div>
          </div>
        ) : !status ? (
          <div className="flex flex-col gap-2 px-4 pt-3">
            <p className="text-xs leading-5 text-muted-foreground">
              {loading ? "Reading git state…" : "Git state unavailable."}
            </p>
            {error && (
              <p className="text-[11px] leading-4 text-destructive" role="alert">
                {error}
              </p>
            )}
            {!loading && (
              <Button type="button" size="sm" variant="ghost" onClick={() => void refresh(true)}>
                Retry
              </Button>
            )}
          </div>
        ) : status.repoState === "broken" ? (
          // The repository exists but git would not answer for this path.
          // Initializing one here would act on the wrong tree and cannot fix
          // it, so the only offer is a retry.
          <div className="flex flex-col gap-2 px-4 pt-3">
            <p className="text-xs leading-5 text-muted-foreground">
              Couldn’t read this workspace’s git state. The folder may have been moved or removed
              outside Pipper.
            </p>
            {error ? (
              <p className="text-[11px] leading-4 text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void refresh(true)}
            >
              {loading ? "Checking…" : "Try again"}
            </Button>
          </div>
        ) : status.repoState === "absent" && !isProjectRoot ? (
          // `absent` in a worktree is not reachable through normal use, but a
          // worktree is never the place to create a repository.
          <p className="px-4 pt-3 text-xs leading-5 text-muted-foreground">
            Couldn’t read this workspace’s git state.
          </p>
        ) : status.repoState === "absent" ? (
          <div className="flex flex-col gap-2 px-4 pt-3">
            <p className="text-xs leading-5 text-muted-foreground">
              This project isn’t using git yet.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void runAction("init", async () => {
                  const user = await window.omni.launch.getUser().catch(() => null);
                  // Identity comes from the signed-in account; stored as
                  // repo-local config so global git identity is never touched.
                  return window.omni.git.init({
                    projectId: project.id,
                    name: user?.name,
                    email: user?.email,
                  });
                })
              }
            >
              {action === "init" ? "Initializing…" : "Initialize git repo"}
            </Button>
          </div>
        ) : (
          <>
            {/* Shared state surface: the header and selected card use the same roles. */}
            <WorkspaceStateSurface
              tone={tone}
              variant="header"
              className="sticky top-0 z-20 shrink-0 rounded-none rounded-tr-[16px] px-4 pb-8 pt-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                {prPill(status, tone)}
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {tone === "merged" ? renderMergedActions() : renderStateAction(status)}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-4 text-[13px] font-medium leading-5">
                {(["check", "changes", "files"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setPickedTab(value);
                      if (value !== "changes") setChangesMenuOpen(false);
                    }}
                    className={cn(
                      "capitalize transition-colors",
                      tab === value
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {value === "check" ? "Check" : value === "changes" ? "Changes" : "Files"}
                  </button>
                ))}
                {tab === "changes" ? (
                  <div className="relative ml-auto">
                    <button
                      ref={changesMenuButtonRef}
                      type="button"
                      aria-label="Choose which changes to show"
                      aria-haspopup="menu"
                      aria-expanded={changesMenuOpen}
                      title={
                        changesSource === "turn"
                          ? "Showing agent changes"
                          : "Showing uncommitted changes"
                      }
                      data-pipper-id="changes-source-menu-toggle"
                      onClick={() => setChangesMenuOpen((open) => !open)}
                      className={cn(
                        "grid size-7 place-items-center rounded-md outline-none transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring",
                        changesMenuOpen
                          ? "bg-active text-foreground"
                          : "text-muted-foreground hover:bg-hover hover:text-foreground",
                      )}
                    >
                      <DotsThreeVertical size={16} weight="bold" />
                    </button>
                    {changesMenuOpen ? (
                      <div
                        ref={changesMenuRef}
                        className="absolute right-0 top-full z-[200] mt-2 text-left"
                        data-pipper-id="changes-source-menu"
                      >
                        <Dropdown
                          checkedIndex={changesSource === "turn" ? 0 : 1}
                          className="w-64"
                          aria-label="Changes source"
                        >
                          <MenuItem
                            index={0}
                            label="Agent changes"
                            description="Files edited across this agent thread"
                            secondaryLabel={`${turnDiffReady ? turnChanges.length : 0} files`}
                            checked={changesSource === "turn"}
                            onSelect={() => {
                              setChangesSource("turn");
                              setChangesMenuOpen(false);
                            }}
                          />
                          <MenuItem
                            index={1}
                            label="Uncommitted changes"
                            description="Current changes reported by local git"
                            secondaryLabel={`${status.files.length} files`}
                            checked={changesSource === "git"}
                            onSelect={() => {
                              setChangesSource("git");
                              setChangesMenuOpen(false);
                            }}
                          />
                        </Dropdown>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </WorkspaceStateSurface>

            <div
              className={cn("flex flex-col gap-3 px-4 pt-3", tab === "files" && "min-h-0 flex-1")}
            >
              {hasTeamChanges(status) ? (
                <WorkspaceStateSurface
                  tone="stale"
                  variant="notice"
                  active={false}
                  className="flex items-center gap-2 rounded-md px-2.5 py-2"
                  role="status"
                  data-pipper-id="workspace-behind-base"
                >
                  <p className="min-w-0 flex-1 text-[11px] leading-4">
                    The team has {status.behindBase} new{" "}
                    {status.behindBase === 1 ? "change" : "changes"} on {baseBranchLabel(status)}{" "}
                    that this workspace doesn’t have yet.
                  </p>
                  <WorkspaceStateAction
                    tone="stale"
                    disabled={busy}
                    onClick={delegateGetLatest}
                    title="Ask the agent to bring this workspace up to date with the base branch"
                    className="h-6 px-2.5 text-[11px]"
                  >
                    {agentTask === "getLatest" ? "Getting…" : "Get latest"}
                  </WorkspaceStateAction>
                </WorkspaceStateSurface>
              ) : null}
              {status.prDataState === "stale" ? (
                <WorkspaceStateSurface
                  tone="action"
                  variant="notice"
                  active={false}
                  className="rounded-md px-2.5 py-2 text-[11px] leading-4"
                  role="status"
                >
                  Couldn’t refresh GitHub — showing cached data
                  {status.prUpdatedAt
                    ? ` from ${new Date(status.prUpdatedAt).toLocaleString()}`
                    : ""}
                  .
                </WorkspaceStateSurface>
              ) : status.prDataState === "unavailable" &&
                status.remoteHost === "github.com" &&
                status.ghAvailable ? (
                <WorkspaceStateSurface
                  tone="action"
                  variant="notice"
                  active={false}
                  className="rounded-md px-2.5 py-2 text-[11px] leading-4"
                  role="status"
                >
                  GitHub data is unavailable. Local git state is still current.
                </WorkspaceStateSurface>
              ) : null}
              {error ? (
                <p className="text-[11px] leading-4 text-destructive" role="alert">
                  Refresh failed: {error}. Showing the previous state.
                </p>
              ) : null}
              {tab === "files" ? (
                <div className="-mx-4 min-h-0 flex-1" data-pipper-id="workspace-files">
                  <Suspense fallback={null}>
                    <ProjectFileTree
                      projectId={project.id}
                      worktreePath={normalizeWorkspacePath(worktreePath, project.path)}
                    />
                  </Suspense>
                </div>
              ) : tab === "check" ? (
                <div className="flex flex-col gap-3">
                  {status.pr ? (
                    <WorkspacePrDetail
                      status={status}
                      items={prStatusItems(status)}
                      onAddComments={status.pr.state === "open" ? addCommentsToChat : undefined}
                    />
                  ) : status.openPrNumber ? (
                    <p className="text-xs leading-5 text-muted-foreground">
                      Could not load details for PR #{status.openPrNumber}.
                    </p>
                  ) : (
                    <p className="text-xs leading-5 text-muted-foreground">
                      No pull request for this branch yet.
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-foreground">
                      {changes.length} {changes.length === 1 ? "file" : "files"} changed
                    </span>
                    {hasLineStats ? (
                      <span className="flex items-center gap-1.5 tabular-nums">
                        <span className="text-emerald-500">+{totalAdditions}</span>
                        <span className="text-red-400">-{totalDeletions}</span>
                      </span>
                    ) : null}
                  </div>

                  {changes.length === 0 ? (
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {changesSource === "turn"
                        ? "No changes from this session yet."
                        : "Working tree is clean."}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {changes.map((file) => {
                        const { dir, name } = splitPath(file.path);
                        const rowClass =
                          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors duration-80 hover:bg-hover";
                        const rowContent = (
                          <>
                            <span className="flex min-w-0 flex-1 items-baseline gap-2">
                              <span className="shrink-0 font-medium text-foreground">{name}</span>
                              {dir ? (
                                <span className="truncate text-muted-foreground">{dir}</span>
                              ) : null}
                            </span>
                            {file.additions !== null ? (
                              <span className="shrink-0 tabular-nums text-emerald-500">
                                +{file.additions}
                              </span>
                            ) : null}
                            {file.deletions !== null ? (
                              <span className="shrink-0 tabular-nums text-red-400">
                                -{file.deletions}
                              </span>
                            ) : null}
                          </>
                        );
                        return (
                          <li key={file.path}>
                            {changesSource === "turn" ? (
                              <button
                                type="button"
                                title={file.path}
                                className={rowClass}
                                onClick={() => {
                                  setDiffActivePath(file.path);
                                  openDiff();
                                }}
                              >
                                {rowContent}
                              </button>
                            ) : (
                              <button
                                type="button"
                                title={file.path}
                                className={rowClass}
                                onClick={() =>
                                  openFilePreview({
                                    projectId: project.id,
                                    worktreePath: normalizeWorkspacePath(
                                      worktreePath,
                                      project.path,
                                    ),
                                    path: file.path,
                                  })
                                }
                              >
                                {rowContent}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {changesSource === "git" && status.truncated ? (
                    <p className="text-[10px] text-muted-foreground/70">File list truncated.</p>
                  ) : null}
                  {showPrForm ? (
                    <>
                      {dirtyCount > 0 ? (
                        <p className="text-[11px] leading-4 text-amber-500">
                          Uncommitted changes are not included — commit first to add them.
                        </p>
                      ) : null}
                      <input
                        value={prTitle}
                        onChange={(event) => setPrTitle(event.target.value)}
                        placeholder="PR title"
                        disabled={busy}
                        className="h-8 rounded-md border border-border bg-surface-2 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/50"
                      />
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setShowPrForm(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          className="flex-1"
                          disabled={busy || prBlocker(status) !== null}
                          onClick={() =>
                            // A PR covers the whole branch: push any local commits
                            // first so all of them land in the PR.
                            void runAction("pr", async () => {
                              if (!status.upstream || status.ahead > 0) {
                                await window.omni.git.push({
                                  projectId: project.id,
                                  path: worktreePath,
                                });
                              }
                              return window.omni.git.createPr({
                                projectId: project.id,
                                path: worktreePath,
                                title:
                                  prTitle.trim() || status.branch || workspaceName || "Workspace",
                                draft: prDraft,
                              });
                            }).then((created) => {
                              // Keep the title/draft choice on failure so a
                              // retry does not start from scratch.
                              if (created) setShowPrForm(false);
                            })
                          }
                        >
                          {action === "pr"
                            ? "Creating…"
                            : prDraft
                              ? "Create draft PR"
                              : "Create PR"}
                        </Button>
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {error && (
                <p className="text-[11px] leading-4 text-destructive" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="text-[11px] leading-4 text-emerald-500" role="status">
                  {notice}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
