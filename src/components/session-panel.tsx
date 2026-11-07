import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { GithubLogo, X } from "@phosphor-icons/react";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import type { Project } from "../../contracts/projects.ts";
import { BranchSwitcher, WorktreeSwitcher } from "@/components/session-workspace-switchers";
import { agentLogoKey, ProviderLogo } from "@/components/provider-logos";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { useWorkspaceActions } from "@/components/workspace-actions";
import { WorkspacePrDetail } from "@/components/workspace-pr-detail";
import {
  ChangesSourceMenu,
  WorkspaceChangesList,
  WorkspaceFilesTab,
  WorkspaceTabBar,
  useWorkspaceChanges,
  type ChangesSource,
  type WorkspacePanelTab,
} from "@/components/workspace-tabs";
import { taskInFlight, taskStatusText } from "@/lib/agent-task-tree";
import { errorToast } from "@/lib/error-toast";
import { selectThread } from "@/lib/thread-actions";
import { cn } from "@/lib/utils";
import { prBlocker, useWorkspaceGitStatus, workspaceGitTone } from "@/lib/workspace-git-status";
import type { HeaderTone } from "@/lib/workspace-tone";
import { WorkspaceStateSurface } from "@/components/workspace-state";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { useAgentStore } from "@/store/agent-store";
import { useDismissedSubthreadsStore } from "@/store/dismissed-subthreads-store";
import { useDiffStore } from "@/store/diff-store";
import { useProjectStore } from "@/store/project-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

function formatCount(value: number): string {
  return value.toLocaleString();
}

function LineTotals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-500">+{formatCount(additions)}</span>{" "}
      <span className="text-red-400">−{formatCount(deletions)}</span>
    </span>
  );
}

function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
      {title ? <h3 className="pb-1 text-[13px] font-medium text-foreground">{title}</h3> : null}
      {children}
    </section>
  );
}

function Row({
  icon,
  children,
  trailing,
  title,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  title?: string;
  /** Makes the row a button. */
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 truncate text-foreground">{children}</div>
      {trailing ? <div className="shrink-0 text-muted-foreground">{trailing}</div> : null}
    </>
  );
  if (!onClick) {
    return (
      <div className="flex min-h-7 items-center gap-2.5 text-[13px]" title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      // Same footprint as the switcher rows above it.
      className="-mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] outline-none transition-colors duration-80 focus-visible:ring-1 focus-visible:ring-ring"
    >
      {content}
    </button>
  );
}

/** Opens a GitHub repository ("owner/name") in the browser. */
function openRepository(repository: string) {
  window.omni.shell
    .openExternal(`https://github.com/${repository}`)
    .catch((err) =>
      toast(errorToast(err instanceof Error ? err.message : "Could not open the repository.")),
    );
}

export interface SessionWorkspace {
  draft: boolean;
  project: Project | null;
  cwd: string | null;
  threadId: string | null;
  isStreaming: boolean;
  status: WorkspaceGitStatus | null;
  refresh: (force?: boolean) => Promise<void>;
  /** Git-state tone of the workspace, which colors the header and project card. */
  tone: HeaderTone;
}

/**
 * The workspace the hybrid shell's displayed thread (or draft) runs in, and
 * its live git status. Owned by the shell, so the git-state tone keeps
 * coloring the project card and composer while the panel is collapsed.
 */
export function useSessionWorkspace(projects: Project[]): SessionWorkspace {
  const draft = useWorkspaceViewStore((state) => state.draft);
  const activeProject = useProjectStore((state) => state.activeProject);
  const threadProjectId = useAgentStore((state) => state.state?.projectId ?? null);
  const threadCwd = useAgentStore((state) => state.state?.cwd ?? null);
  const threadId = useAgentStore((state) => state.state?.threadId ?? null);
  const isStreaming = useAgentStore((state) => state.state?.isStreaming ?? false);
  const editedFileCount = useDiffStore((state) => state.order.length);

  // The panel is thread-specific: a draft has no thread, so no session yet.
  const projectId = draft ? null : threadProjectId;
  const project = useMemo(
    () =>
      projects.find((item) => item.id === projectId) ??
      (activeProject?.id === projectId ? activeProject : null),
    [projects, projectId, activeProject],
  );
  const cwd = draft ? null : threadCwd;
  const { status, refresh } = useWorkspaceGitStatus(project?.id ?? null, cwd);

  // The agent's work moves the workspace: re-read when a turn ends and when
  // it edits another file, rather than waiting for the poll.
  useEffect(() => {
    if (!isStreaming) void refresh();
  }, [isStreaming, refresh]);
  useEffect(() => {
    if (editedFileCount === 0) return;
    const id = setTimeout(() => void refresh(), 750);
    return () => clearTimeout(id);
  }, [editedFileCount, refresh]);

  return {
    draft: draft !== null,
    project,
    cwd,
    threadId,
    isStreaming,
    status,
    refresh,
    tone: status ? workspaceGitTone(status) : "neutral",
  };
}

/**
 * One subthread: its agent and title, opening its thread on click. A finished
 * one dims and stays until closed; its close button shows on hover or focus.
 */
function SubthreadRow({
  task,
  agents,
  onDismiss,
}: {
  task: AgentTaskSnapshot;
  agents: AcpAgentDescriptor[];
  onDismiss: (taskId: string) => void;
}) {
  const agent = agents.find((item) => item.id === task.agentId);
  const agentName = agent?.displayName ?? task.agentId;
  const childThreadId = task.childThreadId;
  const status = taskStatusText(task);
  // Running, starting or waiting on the user: still in flight.
  const finished = !taskInFlight(task);
  return (
    <div className="group/subthread -mx-1.5 flex min-h-8 items-center gap-1 rounded-md pr-1 transition-colors duration-80 hover:bg-hover">
      <button
        type="button"
        disabled={!childThreadId}
        onClick={() => childThreadId && void selectThread(childThreadId)}
        title={`${task.title} · ${agentName} · ${status}`}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md pl-1.5 text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none"
      >
        <span className="grid size-4 shrink-0 place-items-center text-foreground">
          <ProviderLogo provider={agentLogoKey(agent, task.agentId)} label={agentName} size={16} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            finished ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {task.title}
        </span>
      </button>
      {finished ? (
        <button
          type="button"
          onClick={() => onDismiss(task.taskId)}
          aria-label={`Close ${task.title}`}
          title="Close"
          // Always laid out, so the title keeps its width when it shows.
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] duration-80 hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover/subthread:opacity-100 group-focus-within/subthread:opacity-100"
        >
          <X size={12} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The subthreads a thread started, oldest first. Each drops in as it starts;
 * a finished one stays until the user closes it. Nothing when none are left.
 */
export function SessionSubthreads({
  tasks,
  agents,
  threadId,
  dismissedIds,
  onDismiss,
}: {
  tasks: AgentTaskSnapshot[];
  agents: AcpAgentDescriptor[];
  threadId: string | null;
  dismissedIds: readonly string[];
  onDismiss: (taskId: string) => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const subthreads = useMemo(() => {
    if (!threadId) return [];
    const dismissed = new Set(dismissedIds);
    return tasks
      .filter((task) => task.parentThreadId === threadId && !dismissed.has(task.taskId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [tasks, threadId, dismissedIds]);
  if (subthreads.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-0.5 border-t border-border px-4 py-3"
      aria-label="Subthreads"
      data-pipper-id="session-subthreads"
    >
      <h3 className="pb-0.5 text-[12px] font-medium text-muted-foreground">Subthreads</h3>
      <ul className="flex flex-col">
        <AnimatePresence initial={false}>
          {subthreads.map((task) => (
            <motion.li
              key={task.taskId}
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0.12 }
                  : { type: "spring", duration: 0.32, bounce: 0.15 }
              }
              className="overflow-hidden"
            >
              <SubthreadRow task={task} agents={agents} onDismiss={onDismiss} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

/** Title for the PR the header's action is about to open. */
function PrForm({
  initialTitle,
  creating,
  blocker,
  dirty,
  onCancel,
  onCreate,
}: {
  initialTitle: string;
  creating: boolean;
  blocker: string | null;
  dirty: boolean;
  onCancel: () => void;
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  return (
    <Section title="New PR">
      {dirty ? (
        <p className="text-[12px] text-amber-500">
          Uncommitted changes are not included — commit first to add them.
        </p>
      ) : null}
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !creating && blocker === null) onCreate(title);
          if (event.key === "Escape") onCancel();
        }}
        placeholder="PR title"
        aria-label="PR title"
        disabled={creating}
        autoFocus
        className="h-8 rounded-md bg-transparent px-2 text-[13px] text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-ring"
      />
      <div className="mt-1 flex gap-1.5">
        <Button type="button" size="sm" variant="ghost" disabled={creating} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          className="flex-1"
          disabled={creating || blocker !== null}
          title={blocker ?? undefined}
          onClick={() => onCreate(title)}
        >
          {creating ? "Creating…" : "Create PR"}
        </Button>
      </div>
    </Section>
  );
}

/**
 * The shell's right-hand session panel: a git-state header with the PR, the one next step and where the
 * thread runs, then Check (the PR and the subthreads the thread started),
 * Changes and Files. Every value comes from state Pipper already keeps; a
 * section with nothing to show is left out.
 */
export function SessionPanel({ session }: { session: SessionWorkspace }) {
  const { draft, project, cwd, threadId, isStreaming, status, refresh, tone } = session;
  const threadTitle = useAgentStore((state) => state.state?.title ?? null);
  const agentTasks = useAgentStore((state) => state.agentTasks);
  const agents = useAgentRegistryStore((state) => state.agents);
  const dismissedSubthreads = useDismissedSubthreadsStore((state) => state.taskIds);
  const dismissSubthread = useDismissedSubthreadsStore((state) => state.dismiss);
  const [prFormOpen, setPrFormOpen] = useState(false);
  const [tab, setTab] = useState<WorkspacePanelTab>("check");
  const [changesSource, setChangesSource] = useState<ChangesSource>("git");

  const git = status?.repoState === "ready" ? status : null;
  const workspaceName = threadTitle?.trim() || git?.branch || null;
  const openPrForm = useCallback(() => {
    setPrFormOpen(true);
    // The form sits under the changes it would carry.
    setTab("changes");
  }, []);
  const actions = useWorkspaceActions({
    project,
    worktreePath: cwd,
    workspaceName,
    status: git,
    refresh,
    onOpenPrForm: openPrForm,
    onContinued: () => refresh(true),
    // Deleting the workspace would take this thread, and the panel, with it.
    showDelete: false,
  });
  const { changes, turnCount } = useWorkspaceChanges(project, cwd, git, changesSource);

  // A PR form and a picked tab belong to the workspace they were opened for.
  useEffect(() => {
    setPrFormOpen(false);
    setTab("check");
  }, [project?.id, cwd]);

  if (!project || !cwd) {
    return (
      <p className="px-4 py-3 text-[13px] text-muted-foreground/70">
        Open a thread to see its session.
      </p>
    );
  }

  const dirty = git ? git.staged + git.unstaged + git.untracked : 0;
  // A branch with nothing against its base has no totals to show.
  const branchLines =
    git?.branchLines && (git.branchLines.additions > 0 || git.branchLines.deletions > 0)
      ? git.branchLines
      : null;
  const hasPr = git != null && (git.openPrNumber ?? git.mergedPrNumber) != null;
  // The base branch itself (usually the project folder on main) never gets a
  // PR, and committing straight to it isn't a step to offer at a glance: the
  // header and Check are about branch work.
  const onBase =
    git?.branch != null && git.baseBranch?.replace(/^origin\//, "") === git.branch && !hasPr;
  const quickAction = onBase ? null : actions.quickAction;

  return (
    <div className="flex h-full flex-col" data-pipper-id="session-panel">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          // The file tree scrolls itself; everything else scrolls the panel.
          tab === "files"
            ? "overflow-hidden"
            : "overflow-y-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        <WorkspaceStateSurface
          tone={tone}
          variant="header"
          className="flex shrink-0 flex-col gap-3 rounded-none px-4 pb-5 pt-4"
          data-pipper-id="session-panel-header"
        >
          {/* The next step and the PR, joined into one pill. */}
          {quickAction ? <div className="flex min-h-7 items-center">{quickAction}</div> : null}
          <div className="flex flex-col gap-0.5">
            <WorktreeSwitcher project={project} cwd={cwd} draft={draft} threadId={threadId} />
            {git ? (
              <BranchSwitcher
                project={project}
                cwd={cwd}
                branch={git.branch}
                draft={draft}
                threadId={threadId}
                busy={!draft && isStreaming}
                onSwitched={() => void refresh()}
              />
            ) : null}
            {git?.repository ? (
              <Row
                icon={<GithubLogo size={16} weight="duotone" />}
                title={`Open ${git.repository} on GitHub`}
                onClick={() => git.repository && openRepository(git.repository)}
                trailing={
                  branchLines ? (
                    <LineTotals
                      additions={branchLines.additions}
                      deletions={branchLines.deletions}
                    />
                  ) : undefined
                }
              >
                {git.repository}
              </Row>
            ) : null}
          </div>
        </WorkspaceStateSurface>

        {/* Three sections, each set off by a divider: the git state (the only
            one tinted), the subthreads, and the tabs with their content. */}
        <SessionSubthreads
          tasks={agentTasks}
          agents={agents}
          threadId={threadId}
          dismissedIds={dismissedSubthreads}
          onDismiss={dismissSubthread}
        />
        <div className="border-t border-border px-4 py-3">
          <WorkspaceTabBar
            tab={tab}
            onTabChange={setTab}
            trailing={
              tab === "changes" && git ? (
                <ChangesSourceMenu
                  source={changesSource}
                  onSourceChange={setChangesSource}
                  turnCount={turnCount}
                  gitCount={git.files.length}
                />
              ) : null
            }
          />
        </div>

        {actions.error || actions.notice ? (
          <p
            className={cn(
              "border-b border-border px-4 py-2 text-[12px]",
              actions.error ? "text-destructive" : "text-emerald-500",
            )}
            role={actions.error ? "alert" : "status"}
          >
            {actions.error ?? actions.notice}
          </p>
        ) : null}

        {tab === "files" ? (
          <WorkspaceFilesTab project={project} worktreePath={cwd} />
        ) : tab === "changes" ? (
          <>
            <div className="flex flex-col gap-2 px-4 py-3">
              {git ? (
                <WorkspaceChangesList
                  project={project}
                  worktreePath={cwd}
                  status={git}
                  source={changesSource}
                  changes={changes}
                />
              ) : (
                <p className="text-[12px] text-muted-foreground">
                  This folder isn’t a git repository.
                </p>
              )}
            </div>
            {prFormOpen && git ? (
              <PrForm
                initialTitle={threadTitle?.trim() || git.branch || ""}
                creating={actions.action === "pr"}
                blocker={prBlocker(git)}
                dirty={dirty > 0}
                onCancel={() => setPrFormOpen(false)}
                onCreate={(title) =>
                  void actions.createPr({ title }).then((created) => {
                    // Keep the title on failure so a retry does not start over.
                    if (created) setPrFormOpen(false);
                  })
                }
              />
            ) : null}
          </>
        ) : (
          <>
            {git && !onBase ? (
              <Section>
                {git.pr ? (
                  <WorkspacePrDetail
                    status={git}
                    items={actions.prStatusItems}
                    onAddComments={git.pr.state === "open" ? actions.addCommentsToChat : undefined}
                  />
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    {git.openPrNumber
                      ? `Could not load details for PR #${git.openPrNumber}.`
                      : "No pull request for this branch yet."}
                  </p>
                )}
              </Section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
