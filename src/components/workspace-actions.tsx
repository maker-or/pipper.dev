import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import type { WorkspaceGitStatus, WorkspacePrComment } from "../../contracts/git.ts";
import { toast } from "@/components/ui/toast";
import {
  buildCommitPrompt,
  buildGetLatestPrompt,
  buildPrCommentsPrompt,
  sendWorkspaceAgentPrompt,
} from "@/lib/workspace-agent-prompt";
import type { PrStatusItem } from "@/components/workspace-pr-detail";
import { WorkspaceStateAction } from "@/components/workspace-state";
import {
  WorkspacePairedAction,
  type PairedActionButton,
} from "@/components/workspace-paired-action";
import { hasTeamChanges, prBlocker, workspaceGitTone } from "@/lib/workspace-git-status";
import type { HeaderTone } from "@/lib/workspace-tone";

/** Git work currently delegated to this workspace's agent thread. */
export type AgentTask = "commitPush" | "getLatest";

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
 * The PR as the companion button: its number, opening it on GitHub. Null when
 * the branch has no PR.
 */
function prCompanion(status: WorkspaceGitStatus): PairedActionButton | null {
  const number = status.openPrNumber ?? status.mergedPrNumber;
  const url = status.openPrUrl ?? status.mergedPrUrl;
  if (!number || !url) return null;
  return {
    label: number,
    title: `Open pull request #${number} on GitHub`,
    ariaLabel: `Open pull request #${number} on GitHub`,
    onClick: () => void window.omni.shell.openExternal(url),
  };
}

export interface WorkspaceActions {
  /** The git action running right now, e.g. "push" or "mergePr". */
  action: string | null;
  /** Git work handed to the workspace's agent thread, until its turn ends. */
  agentTask: AgentTask | null;
  busy: boolean;
  error: string | null;
  notice: string | null;
  /** Runs a git action with toasts; resolves `true` only when it succeeded. */
  runAction: (
    kind: string,
    fn: () => Promise<{ message: string; url?: string | null }>,
  ) => Promise<boolean>;
  /** Push if needed, then open the PR. Resolves `true` when it was created. */
  createPr: (input: { title: string }) => Promise<boolean>;
  delegateGetLatest: () => void;
  addCommentsToChat: (comments: WorkspacePrComment[]) => void;
  /** What blocks the PR, each with the button that clears it. */
  prStatusItems: PrStatusItem[];
  /**
   * The header's control: the one next step for this git state, joined with
   * the PR link into one pill. The PR link alone when there is no step.
   */
  quickAction: ReactNode;
}

/**
 * The git actions every shell offers for one workspace: commit and push
 * through the agent, push, create, merge and ready a PR, catch up with the
 * base, continue after a merge. Results are dropped once the workspace
 * changes, so a late action can never report into another workspace.
 */
export function useWorkspaceActions({
  project,
  worktreePath,
  workspaceName,
  status,
  refresh,
  onOpenPrForm,
  onContinued,
  onDelete,
  showDelete = true,
}: {
  project: Project | null;
  worktreePath: string | null;
  /** Names threads started for git work and seeds PR titles. */
  workspaceName: string | null;
  status: WorkspaceGitStatus | null;
  refresh: (force?: boolean) => Promise<void>;
  /** Ask for a PR title; the caller creates it with `createPr`. */
  onOpenPrForm: () => void;
  /** Fired after "Continue" moved the worktree onto a new branch. */
  onContinued?: () => Promise<void> | void;
  /** Delete the workspace. Absent for the project root. */
  onDelete?: () => Promise<void> | void;
  /** Offer Delete after a merge; shown disabled when `onDelete` is absent. */
  showDelete?: boolean;
}): WorkspaceActions {
  const [action, setAction] = useState<string | null>(null);
  const [agentTask, setAgentTask] = useState<AgentTask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Bumped on every workspace switch. Every async result captures the
   * generation it started under and is dropped if the workspace has since
   * changed, including A → B → A.
   */
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setAction(null);
    setAgentTask(null);
    setError(null);
    setNotice(null);
  }, [project?.id, worktreePath]);

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
  const unpushed = status?.ahead ?? 0;
  const behind = status ? hasTeamChanges(status) : false;
  const busy = action !== null || agentTask !== null;
  const tone: HeaderTone = status?.repoState === "ready" ? workspaceGitTone(status) : "neutral";

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
    setError(null);
    setNotice(null);
    setAgentTask(kind);
    const generation = generationRef.current;
    // A workspace switch already reset the actions; don't clobber them.
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

  const delegateCommitPush = () => {
    if (!status || dirtyCount === 0) return;
    delegateToAgent({
      kind: "commitPush",
      title: workspaceName ? `${workspaceName}: commit` : "Commit",
      message: buildCommitPrompt({
        branch: status.branch,
        push: true,
        files: status.files.map((file) => file.path),
        truncated: status.truncated,
      }),
      pending: "Agent is committing and pushing…",
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

  const createPr = (input: { title: string }) => {
    if (!project || !worktreePath || !status) return Promise.resolve(false);
    // A PR covers the whole branch: push any local commits first so all of
    // them land in the PR.
    return runAction("pr", async () => {
      if (!status.upstream || status.ahead > 0) {
        await window.omni.git.push({ projectId: project.id, path: worktreePath });
      }
      return window.omni.git.createPr({
        projectId: project.id,
        path: worktreePath,
        title: input.title.trim() || status.branch || workspaceName || "Workspace",
      });
    });
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
  const buildPrStatusItems = (status: WorkspaceGitStatus): PrStatusItem[] => {
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
          onClick: delegateCommitPush,
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
            onPrimary: delegateCommitPush,
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

  /** One next step, beside the PR button. */
  const paired = (
    primary: { label: string; title: string; disabled: boolean; onPrimary: () => void },
    pr: PairedActionButton | null,
    pairTone: HeaderTone = tone,
  ) => (
    <WorkspacePairedAction
      tone={pairTone}
      primary={{
        label: primary.label,
        title: primary.title,
        disabled: primary.disabled,
        onClick: primary.onPrimary,
      }}
      secondary={pr}
    />
  );

  const renderStateAction = (status: WorkspaceGitStatus) => {
    const pr = prCompanion(status);
    if (!status.openPrNumber) {
      // Fresh worktree, nothing happened yet: no action button. It appears
      // once there is anything to act on — dirty files, unpushed commits, or
      // a pushed branch that still needs a PR.
      if (dirtyCount === 0 && unpushed === 0 && status.aheadOfBase === 0 && !behind) return null;
      const blocker = prBlocker(status);
      // Pushed and clean: the next step is the PR.
      const prIsPrimary = dirtyCount === 0 && unpushed === 0 && !behind && !agentTask;
      const primary = behind
        ? getLatestPrimary
        : prIsPrimary
          ? {
              label: action === "pr" ? "Creating…" : "Create a PR",
              title: blocker ?? "Open a pull request for this branch",
              disabled: busy || blocker !== null,
              onPrimary: onOpenPrForm,
            }
          : commitPushPrimary(status);
      return paired(primary, pr);
    }
    if (tone === "ready") {
      return paired(
        {
          label: action === "mergePr" ? "Merging…" : "Merge",
          title:
            status.prDataState === "fresh"
              ? "Merge this pull request on GitHub"
              : "Refresh GitHub before merging",
          disabled: busy || status.prDataState !== "fresh",
          onPrimary: runMergePr,
        },
        pr,
        "ready",
      );
    }
    // Draft with nothing left to push: the next step is flipping the flag.
    if (status.isDraftPr && dirtyCount === 0 && unpushed === 0) {
      return paired(
        {
          label: action === "ready" ? "Marking…" : "Ready for review",
          title:
            status.prDataState === "fresh"
              ? "Mark this draft pull request ready for review"
              : "Refresh GitHub before changing the pull request",
          disabled: busy || status.prDataState !== "fresh",
          onPrimary: runMarkReady,
        },
        pr,
        "action",
      );
    }
    // PR open but blocked: local work comes first; with none, catching up
    // with the base is the step. The Check section explains the rest
    // (checks, draft).
    const hasLocalWork = dirtyCount > 0 || unpushed > 0 || agentTask !== null;
    return paired(!hasLocalWork && behind ? getLatestPrimary : commitPushPrimary(status), pr);
  };

  /** Merged state: the work landed — continue on a new branch, or delete. */
  const renderMergedActions = (status: WorkspaceGitStatus) => (
    <div className="flex shrink-0 items-center gap-1">
      {paired(
        {
          label: action === "continue" ? "Starting…" : "Continue",
          title: "Start a new branch off the latest base in this same workspace",
          disabled: busy,
          onPrimary: runContinue,
        },
        prCompanion(status),
        "merged",
      )}
      {showDelete ? (
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
      ) : null}
    </div>
  );

  const ready = status?.repoState === "ready" ? status : null;

  return {
    action,
    agentTask,
    busy,
    error,
    notice,
    runAction,
    createPr,
    delegateGetLatest,
    addCommentsToChat,
    prStatusItems: ready ? buildPrStatusItems(ready) : [],
    quickAction: ready
      ? tone === "merged"
        ? renderMergedActions(ready)
        : renderStateAction(ready)
      : null,
  };
}
