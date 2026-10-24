import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CaretDown,
  DotsThree,
  FolderPlus,
  GitBranch,
  Plus,
  SidebarSimple,
  Trash,
} from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import type { ProjectRepoState } from "../../contracts/git.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import { orderWorktreesForDisplay } from "../../contracts/worktrees.ts";
import { AgentView } from "@/components/agent-view";
import { DiffIngestor } from "@/components/diff-ingestor";
import { GlobalTabBar } from "@/components/global-tab-bar";
import { ThreadCompletionDock } from "@/components/thread-completion-dock";
import { WorkspaceControlPanel, type HeaderTone } from "@/components/workspace-control-panel";
import { Toaster } from "@/components/ui/toaster";
import { Sidebar, SidebarFooter, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Elevated } from "@/lib/elevated";
import { WorkspaceStateSurface } from "@/components/workspace-state";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { getAllTerminalSessions, useTerminalStore } from "@/store/terminal-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { cn } from "@/lib/utils";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { ProviderLogo } from "@/components/provider-logos";
import { useRunningAgentsByWorkspace } from "@/lib/running-agents";
import { WorkspaceToneProvider } from "@/lib/workspace-tone-context";
import { WorkspaceSetupBadge, WorkspaceSetupFailures } from "@/components/workspace-setup-feedback";
import {
  startWorkspaceSetupWatcher,
  useWorkspaceSetupStore,
  type WorkspaceSetupEntry,
} from "@/store/workspace-setup-store";

// Loaded on first terminal so xterm/WASM stay out of the startup chunk; App.tsx
// lazy-loads the same module, and a static import here defeated that split.
const TerminalSession = lazy(() =>
  import("@/components/terminal-session").then((m) => ({ default: m.TerminalSession })),
);

/** Workspaces shown for a project before the "Load more" affordance appears. */
const WORKSPACE_PAGE_SIZE = 6;

/** A small, stable set of heights so the card grid reads as an organic
 *  masonry rather than a uniform table — picked by workspace path. */
const CARD_HEIGHTS = [128, 168, 144, 188, 132, 160, 116, 176];

/** Agent marks shown on a card before collapsing the rest into "+N". */
const MAX_RUNNING_AGENT_MARKS = 4;

const EMPTY_AGENT_IDS: string[] = [];

function cardHeight(path: string, selected: boolean): number {
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  const base = CARD_HEIGHTS[hash % CARD_HEIGHTS.length];
  return selected ? base + 24 : base;
}

function WorkspaceNameDialog({
  project,
  isCreating,
  error,
  repoState,
  isInitializing,
  onCancel,
  onSubmit,
  onInitialize,
  onRetryRepoState,
}: {
  project: Project;
  isCreating: boolean;
  error: string | null;
  /** null while the project's repo state is still being read. */
  repoState: ProjectRepoState | null;
  isInitializing: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
  onInitialize: () => void;
  onRetryRepoState: () => void;
}) {
  const [name, setName] = useState("");
  // Both mean "a workspace cannot branch yet": no repository, or one with no
  // commits. The fix differs by wording only — the action behind both buttons
  // is `git:init`, which initializes and/or makes the initial commit.
  const needsRepoSetup = repoState === "absent" || repoState === "unborn";
  const initLabel = repoState === "unborn" ? "Create initial commit" : "Initialize git repository";
  const initBusyLabel = repoState === "unborn" ? "Committing…" : "Initializing…";

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4">
      <Elevated
        offset={4}
        data-pipper-id="workspace-name-dialog"
        className="w-full max-w-sm rounded-xl border border-border"
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (repoState === "ready" && name.trim()) onSubmit(name.trim());
          }}
        >
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="text-base font-semibold text-foreground">New workspace</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              Create an isolated workspace in {project.name}.
            </p>
          </div>
          {repoState === null ? (
            <p className="text-xs leading-5 text-muted-foreground">Checking git setup…</p>
          ) : repoState === "broken" ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Couldn’t read this project’s git state. The folder may have been moved or removed
              outside Pipper.
            </p>
          ) : needsRepoSetup ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs leading-5 text-muted-foreground">
                {repoState === "absent"
                  ? "This project isn’t using git yet. Workspaces are git worktrees, so Pipper needs to create a repository first."
                  : "This project’s repository has no commits yet. Workspaces branch from a commit, so Pipper needs an initial commit first."}
              </p>
              <p className="text-[11px] leading-4 text-muted-foreground/70">
                {repoState === "absent"
                  ? "Initializing creates the repository and commits this project’s files so the new workspace starts from them."
                  : "This project’s files will be included in the initial commit."}
              </p>
            </div>
          ) : (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Workspace name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Fix login redirect"
                className="h-9 rounded-md border border-border bg-surface-2 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/50 focus:ring-1 focus:ring-ring"
              />
            </label>
          )}
          {error && (
            <p className="mt-3 text-xs leading-5 text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            {repoState === "broken" ? (
              <Button type="button" variant="ghost" size="sm" onClick={onRetryRepoState}>
                Try again
              </Button>
            ) : needsRepoSetup ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={isInitializing}
                onClick={onInitialize}
              >
                {isInitializing ? initBusyLabel : initLabel}
              </Button>
            ) : repoState === "ready" ? (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!name.trim() || isCreating}
              >
                Create workspace
              </Button>
            ) : null}
          </div>
        </form>
      </Elevated>
    </div>
  );
}

/** Horizontal, scrollable project switcher pinned above the workspace grid. */
function ProjectTabs({
  projects,
  activeProjectId,
  onSelect,
}: {
  projects: Project[];
  activeProjectId: string | undefined;
  onSelect: (project: Project) => void;
}) {
  if (projects.length === 0) {
    return <p className="px-2 py-1.5 text-[13px] text-muted-foreground/70">No projects yet</p>;
  }
  return (
    <div
      role="tablist"
      aria-label="Projects"
      className="flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {projects.map((project) => {
        const active = project.id === activeProjectId;
        return (
          <button
            key={project.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active ? "true" : undefined}
            onClick={() => onSelect(project)}
            className={cn(
              "relative shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[15px] leading-none outline-none transition-colors duration-80",
              "focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "font-medium text-foreground"
                : "text-muted-foreground/60 hover:text-foreground",
            )}
          >
            {project.name}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-2.5 -bottom-0.5 h-0.5 rounded-full bg-foreground/70"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A single workspace rendered as a card in the grid. */
/**
 * Agent marks for the threads currently mid-turn in a workspace — the only
 * signal that work is happening somewhere other than the workspace on screen.
 * One mark per distinct agent, capped so a busy workspace cannot push the
 * name out of the way.
 */
function RunningAgents({ agentIds }: { agentIds: string[] }) {
  if (agentIds.length === 0) return null;
  const shown = agentIds.slice(0, MAX_RUNNING_AGENT_MARKS);
  const overflow = agentIds.length - shown.length;
  const label =
    agentIds.length === 1 ? "1 agent running here" : `${agentIds.length} agents running here`;
  return (
    <span
      className="mt-auto flex items-center gap-1 pt-2"
      title={label}
      aria-label={label}
      data-pipper-id="workspace-running-agents"
    >
      {shown.map((agentId) => (
        <ProviderLogo key={agentId} provider={agentId} size={13} className="opacity-90" />
      ))}
      {overflow > 0 ? (
        <span className="text-[10px] font-semibold tabular-nums opacity-70">+{overflow}</span>
      ) : null}
    </span>
  );
}

function WorkspaceCard({
  worktree,
  selected,
  tone = "neutral",
  runningAgentIds = EMPTY_AGENT_IDS,
  setup,
  onSelect,
  onDelete,
}: {
  worktree: Worktree;
  selected: boolean;
  /** Git-state tone of the selected workspace — mirrors the panel header. */
  tone?: HeaderTone;
  /** Agents mid-turn in this workspace right now. */
  runningAgentIds?: string[];
  /** Background setup still running, or failed and not yet dismissed. */
  setup?: WorkspaceSetupEntry;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = worktree.workspaceName ?? (worktree.isProjectRoot ? "Main" : "Workspace");

  // Dismiss the context menu on any click outside it, or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <WorkspaceStateSurface
      tone={tone}
      active={selected}
      offset={selected ? 0 : 2}
      ref={menuRef}
      className="group/card relative mb-2 break-inside-avoid rounded-2xl"
    >
      <button
        type="button"
        data-active={selected ? "true" : undefined}
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          setMenuOpen(false);
          onSelect();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((open) => !open);
        }}
        style={{
          minHeight: cardHeight(worktree.path, selected),
        }}
        className={cn(
          "relative flex w-full flex-col overflow-hidden rounded-2xl p-3 text-left outline-none",
          "transition-[background-color,color,box-shadow] duration-80",
          "focus-visible:ring-1 focus-visible:ring-ring",
          selected
            ? "bg-transparent text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <span className="line-clamp-3 pr-5 text-[13px] font-medium leading-snug">
          {name}
          {selected && <span className="sr-only"> (active workspace)</span>}
        </span>
        <WorkspaceSetupBadge entry={setup} />
        <RunningAgents agentIds={runningAgentIds} />
      </button>
      <button
        type="button"
        aria-label={`${name} options`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-open={menuOpen ? "true" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setMenuOpen((open) => !open);
        }}
        className={cn(
          "absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md outline-none",
          "text-current opacity-0 transition-opacity duration-80",
          "group-hover/card:opacity-100 focus-visible:opacity-100 data-[open=true]:opacity-100",
          "text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {menuOpen && (
        <Elevated
          offset={2}
          data-pipper-id="workspace-context-menu"
          className="absolute right-1 top-full z-50 mt-1 w-44 rounded-lg border border-border p-1"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-foreground"
            onClick={() => {
              setMenuOpen(false);
              onDelete?.();
            }}
          >
            <Trash size={14} /> Delete workspace
          </button>
        </Elevated>
      )}
    </WorkspaceStateSurface>
  );
}

export function AdvancedShell() {
  const activeProject = useProjectStore((state) => state.activeProject);
  const queryClient = useQueryClient();
  const {
    selectedWorktreePathByProject,
    isCreating,
    error: worktreeError,
    loadWorktrees,
    createWorktree,
    switchWorktree,
    syncSelections,
    clearError: clearWorktreeError,
  } = useWorktreeStore();
  const loadProjectThreads = useThreadStore((state) => state.loadProjectThreads);
  const setupByPath = useWorkspaceSetupStore((state) => state.entries);
  const [projects, setProjects] = useState<Project[]>([]);
  const [worktreesByProject, setWorktreesByProject] = useState<Record<string, Worktree[]>>({});
  const [dialogProject, setDialogProject] = useState<Project | null>(null);
  // Whether the dialog's project can host a worktree (and its fix when it
  // cannot). null while the read is in flight.
  const [dialogRepoState, setDialogRepoState] = useState<ProjectRepoState | null>(null);
  const [dialogRepoError, setDialogRepoError] = useState<string | null>(null);
  const [isInitializingRepo, setIsInitializingRepo] = useState(false);
  // The dialog's project, readable from async callbacks after render state has
  // moved on; null when the dialog is closed. Doubles as the stale-response
  // guard: a read that resolves after the dialog moved on is dropped.
  const dialogProjectRef = useRef<Project | null>(null);
  // Git-state tone of the selected workspace, reported by the control panel,
  // used to tint the active card with the panel's gradient.
  const [selectedTone, setSelectedTone] = useState<HeaderTone>("neutral");
  // Left rail collapse. Tracked here (not inside the provider) so the edge
  // hover target can slide it back in once the in-rail trigger is hidden.
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  // Projects whose workspace list has been expanded past the initial page.
  const [expandedWorkspaceProjects, setExpandedWorkspaceProjects] = useState<Set<string>>(
    new Set(),
  );
  const loadMoreWorkspaces = (projectId: string) => {
    setExpandedWorkspaceProjects((current) => new Set(current).add(projectId));
  };

  const selectedPath = activeProject
    ? normalizeWorkspacePath(selectedWorktreePathByProject[activeProject.id], activeProject.path)
    : null;
  const selectedWorktree = useMemo(() => {
    if (!activeProject || !selectedPath) return null;
    return (
      (worktreesByProject[activeProject.id] ?? []).find(
        (item) => normalizeWorkspacePath(item.path, activeProject.path) === selectedPath,
      ) ?? null
    );
  }, [activeProject, selectedPath, worktreesByProject]);
  const selectedWorkspaceName = useMemo(() => {
    if (!selectedPath) return null;
    if (selectedWorktree && !selectedWorktree.isProjectRoot)
      return selectedWorktree.workspaceName ?? null;
    if (selectedWorktree?.isProjectRoot) return "main";
    return selectedPath.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  }, [selectedPath, selectedWorktree]);

  useEffect(() => {
    void window.omni.projects
      .list()
      .then((items) => setProjects(items.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setProjects([]));
    const unsubscribe = window.omni.projects.onListChanged?.((project) => {
      setProjects((current) =>
        [...current.filter((item) => item.id !== project.id), project].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    void Promise.all(
      projects.map(async (project) => {
        try {
          return [project.id, await window.omni.worktrees.list(project.id)] as const;
        } catch {
          return [project.id, [] as Worktree[]] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      // Newest-first for linked worktrees (git order is arbitrary readdir).
      const ordered = Object.fromEntries(
        entries.map(([id, list]) => [id, orderWorktreesForDisplay(list)]),
      );
      setWorktreesByProject(ordered);
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Setup that follows a worktree create (script or dependency install) shows
  // on the workspace's card while it runs and under the conversation if it
  // fails. App.tsx keeps the toasts for the basic shell only.
  useEffect(() => startWorkspaceSetupWatcher(), []);

  useEffect(() => {
    if (!activeProject) return;
    void loadWorktrees(activeProject.id);
    void loadProjectThreads(activeProject.id, { reset: true });
  }, [activeProject?.id, loadProjectThreads, loadWorktrees]);

  // Sidebar toggles: "[" left, "]" right. Owned here rather than by the
  // providers because the design-system shortcut routing hands a keystroke to
  // a single provider when they nest, which kills "]" whenever focus sits
  // outside the inner (right) provider. Providers get shortcut={null}.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      if (event.key === "[") {
        event.preventDefault();
        setLeftSidebarOpen((open) => !open);
      } else if (event.key === "]") {
        event.preventDefault();
        setRightSidebarOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const terminalTabsRevision = useTerminalStore((state) => state.tabsRevision);
  const terminalSessions = useMemo(
    () =>
      getAllTerminalSessions(useTerminalStore.getState()).map((session) => ({
        id: session.id,
        cwd: session.cwd,
      })),
    [terminalTabsRevision],
  );
  const workspaceMode = useWorkspaceViewStore((state) => state.mode);
  const activeTerminalId = useWorkspaceViewStore((state) => state.activeTerminalId);
  const showTerminalView = workspaceMode === "terminal" && activeTerminalId != null;
  // Terminals mount on first view and then stay mounted (hidden) to keep their
  // PTY and scrollback; never-viewed sessions don't load the terminal chunk.
  const [viewedTerminalIds, setViewedTerminalIds] = useState<ReadonlySet<string>>(() => new Set());
  if (showTerminalView && activeTerminalId && !viewedTerminalIds.has(activeTerminalId)) {
    setViewedTerminalIds(new Set(viewedTerminalIds).add(activeTerminalId));
  }

  const openProject = async (project: Project) => {
    if (project.id !== activeProject?.id) await window.omni.projects.setActive(project.id);
  };

  const openWorkspaceDialog = (project: Project) => {
    // A failure from an earlier attempt (possibly another project) must not
    // greet the user before they have typed anything.
    clearWorktreeError();
    setDialogRepoError(null);
    setDialogRepoState(null);
    setIsInitializingRepo(false);
    dialogProjectRef.current = project;
    setDialogProject(project);
    void checkDialogRepoState(project.id);
  };
  const closeWorkspaceDialog = () => {
    dialogProjectRef.current = null;
    clearWorktreeError();
    setDialogRepoError(null);
    setDialogRepoState(null);
    setIsInitializingRepo(false);
    setDialogProject(null);
  };

  /**
   * Read whether the dialog's project can host a worktree. A failed read is
   * never "no repo": the dialog must not offer to initialize a repository it
   * could not inspect.
   */
  const checkDialogRepoState = async (projectId: string) => {
    if (!window.omni?.git?.projectRepoState) {
      // Preload predates the git bridge (needs app restart, not just HMR).
      setDialogRepoState("broken");
      setDialogRepoError("Git bridge missing — restart the app (bun run dev) to load it.");
      return;
    }
    try {
      const state = await window.omni.git.projectRepoState(projectId);
      if (dialogProjectRef.current?.id !== projectId) return;
      setDialogRepoState(state);
      // A create failure ("Not a git repository…") is superseded by the
      // setup prompt it produced; keeping both would show a raw git error
      // above the button that fixes it.
      if (state !== "ready") clearWorktreeError();
    } catch (err) {
      if (dialogProjectRef.current?.id !== projectId) return;
      setDialogRepoState("broken");
      setDialogRepoError(
        err instanceof Error ? err.message : "Could not read this project’s git state.",
      );
    }
  };

  /** Initialize the project's repository (or its initial commit) and re-read. */
  const initializeDialogRepo = async () => {
    const project = dialogProjectRef.current;
    if (!project || isInitializingRepo) return;
    const stillActive = () => dialogProjectRef.current?.id === project.id;
    setIsInitializingRepo(true);
    setDialogRepoError(null);
    try {
      const user = await window.omni.launch.getUser().catch(() => null);
      // Identity comes from the signed-in account; stored as repo-local config
      // so global git identity is never touched.
      await window.omni.git.init({
        projectId: project.id,
        name: user?.name,
        email: user?.email,
      });
      if (!stillActive()) return;
      await checkDialogRepoState(project.id);
      if (!stillActive()) return;
      // The project root is a real workspace now — surface it in the sidebar
      // without waiting for the next project switch.
      await reloadWorkspaces(project);
    } catch (err) {
      if (!stillActive()) return;
      setDialogRepoError(err instanceof Error ? err.message : "Could not initialize git.");
    } finally {
      if (stillActive()) setIsInitializingRepo(false);
    }
  };

  const createWorkspace = async (name: string) => {
    if (!dialogProject) return;
    const project = dialogProject;
    const worktree = await createWorktree(project.id, name);
    if (!worktree) {
      // Creation can fail because the project is no longer a usable repo
      // (removed, or left with no commits). Re-read the state so the dialog
      // offers the fix instead of stranding the user on a raw git error.
      void checkDialogRepoState(project.id);
      return;
    }
    setDialogProject(null);
    // The worktree exists on disk now — show it before anything that can
    // still fail (switching, renaming), so the sidebar never hides a real
    // workspace behind a later error.
    setWorktreesByProject((current) => {
      const existing = current[project.id] ?? [];
      const withoutDup = existing.filter((item) => item.path !== worktree.path);
      // Newest-first: the fresh worktree carries Date.now(), so it sorts top.
      return { ...current, [project.id]: orderWorktreesForDisplay([worktree, ...withoutDup]) };
    });
    const thread = await selectWorkspace(project, worktree.path);
    if (thread) {
      try {
        await window.omni.threads.rename(thread.id, name);
      } catch (err) {
        // Cosmetic: the chat keeps its default title; the workspace is fine.
        console.error("[AdvancedShell] Failed to name the workspace thread:", err);
      }
      void queryClient.invalidateQueries({ queryKey: ["open-tabs"] });
    } else {
      // The dialog is gone, so the store's error has nowhere else to show.
      toast({
        icon: <GitBranch weight="duotone" className="size-5 text-destructive" />,
        title: "Workspace created, but could not be opened",
        description:
          useWorktreeStore.getState().error ?? "Select it from the sidebar to try again.",
      });
    }
    await loadWorktrees(project.id);
  };

  /** After "Continue" the worktree is on a new branch — refresh git-derived rows. */
  const reloadWorkspaces = async (project: Project) => {
    const items = await window.omni.worktrees.list(project.id).catch(() => null);
    // Git's order is readdir order; keep the same newest-first display as
    // the initial load so "Continue" never reshuffles the rows.
    if (items)
      setWorktreesByProject((current) => ({
        ...current,
        [project.id]: orderWorktreesForDisplay(items),
      }));
    if (project.id === activeProject?.id) await loadWorktrees(project.id);
  };
  const deleteWorkspace = async (project: Project, worktree: Worktree) => {
    if (worktree.isProjectRoot) return;
    if (
      !window.confirm(
        `Delete workspace "${worktree.workspaceName ?? "Workspace"}" and all of its chats?`,
      )
    )
      return;
    await window.omni.worktrees.delete({ projectId: project.id, path: worktree.path });
    setWorktreesByProject((current) => ({
      ...current,
      [project.id]: (current[project.id] ?? []).filter((item) => item.path !== worktree.path),
    }));
    await syncSelections();
    if (project.id === activeProject?.id) await loadWorktrees(project.id);
  };

  const selectWorkspace = async (project: Project, path: string) => {
    if (project.id !== activeProject?.id) await window.omni.projects.setActive(project.id);
    return switchWorktree(project.id, path);
  };

  // Workspaces for the active project — only the active project's grid renders.
  const runningAgents = useRunningAgentsByWorkspace(activeProject);
  const visibleWorktrees = activeProject
    ? (worktreesByProject[activeProject.id] ?? []).filter((worktree) => !worktree.isProjectRoot)
    : [];
  const activeWorktrees = visibleWorktrees;
  const workspacesExpanded = activeProject
    ? expandedWorkspaceProjects.has(activeProject.id)
    : false;
  const firstPage = activeWorktrees.slice(0, WORKSPACE_PAGE_SIZE);
  // The active workspace must never hide behind "Load more": pin it into the
  // visible page when the selection (switch/restore of an older workspace)
  // falls past the page boundary.
  const selectedBeyondPage =
    !workspacesExpanded && selectedPath && !firstPage.some((item) => item.path === selectedPath)
      ? (activeWorktrees.find((item) => item.path === selectedPath) ?? null)
      : null;
  const shownWorktrees = workspacesExpanded
    ? activeWorktrees
    : selectedBeyondPage
      ? [...firstPage, selectedBeyondPage]
      : firstPage;
  const hiddenWorkspaceCount = activeWorktrees.length - shownWorktrees.length;

  return (
    <WorkspaceToneProvider tone={selectedTone}>
      <SidebarProvider
        open={leftSidebarOpen}
        onOpenChange={setLeftSidebarOpen}
        persist={false}
        shortcut={null}
        width="20rem"
      >
        <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-surface-1 text-foreground">
          <DiffIngestor />
          <Toaster />
          {/* Reaching the left edge slides the docked rail back in. It is a
            plain hover target, not the design-system peek overlay, so the
            panel arrives as the real column instead of a floating card. */}
          {!leftSidebarOpen ? (
            <div
              className="group/left-edge absolute inset-y-0 left-0 z-40 w-6"
              onPointerEnter={() => setLeftSidebarOpen(true)}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-px bg-border opacity-0 transition-opacity duration-80 group-hover/left-edge:opacity-100"
              />
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <Sidebar collapsible="offcanvas" rail={false}>
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-end px-2 pt-3">
                  <SidebarTrigger size="icon-sm" aria-label="Collapse workspace sidebar">
                    <SidebarSimple size={16} />
                  </SidebarTrigger>
                </div>
                <div className="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
                  <div className="min-w-0 flex-1">
                    <ProjectTabs
                      projects={projects}
                      activeProjectId={activeProject?.id}
                      onSelect={(project) => void openProject(project)}
                    />
                  </div>
                  {activeProject && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`New workspace in ${activeProject.name}`}
                      onClick={() => openWorkspaceDialog(activeProject)}
                    >
                      <Plus size={16} />
                    </Button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2">
                  {activeProject ? (
                    <>
                      {activeWorktrees.length === 0 ? (
                        <button
                          type="button"
                          className="flex min-h-[7rem] w-full items-center justify-center rounded-2xl border border-dashed border-border text-[13px] text-muted-foreground/70 transition-colors duration-80 hover:bg-surface-2 hover:text-foreground"
                          onClick={() => openWorkspaceDialog(activeProject)}
                        >
                          <Plus size={16} className="mr-1.5" /> New workspace
                        </button>
                      ) : (
                        <div className="columns-2 gap-2">
                          {shownWorktrees.map((worktree) => {
                            const isSelected = worktree.path === selectedPath;
                            return (
                              <WorkspaceCard
                                key={worktree.path}
                                worktree={worktree}
                                selected={isSelected}
                                tone={isSelected ? selectedTone : "neutral"}
                                runningAgentIds={
                                  runningAgents.get(
                                    normalizeWorkspacePath(worktree.path, activeProject.path),
                                  ) ?? EMPTY_AGENT_IDS
                                }
                                setup={setupByPath[worktree.path]}
                                onSelect={() => void selectWorkspace(activeProject, worktree.path)}
                                onDelete={() => void deleteWorkspace(activeProject, worktree)}
                              />
                            );
                          })}
                        </div>
                      )}
                      {hiddenWorkspaceCount > 0 ? (
                        <button
                          type="button"
                          className="flex mt-2 h-8 w-full items-center justify-center gap-2 rounded-md text-[12px] text-muted-foreground transition-colors duration-80 hover:bg-hover hover:text-foreground"
                          onClick={() => loadMoreWorkspaces(activeProject.id)}
                        >
                          <CaretDown size={14} />
                          Load more ({hiddenWorkspaceCount})
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <p className="px-1 py-2 text-[13px] text-muted-foreground/70">
                      Select a project to see its workspaces.
                    </p>
                  )}
                </div>
              </div>
              <SidebarFooter className="border-t border-border p-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground"
                    onClick={() => void window.omni.launch.show("add")}
                  >
                    <FolderPlus size={16} />
                    New project
                  </button>
                </div>
              </SidebarFooter>
            </Sidebar>

            <SidebarProvider
              open={rightSidebarOpen}
              onOpenChange={setRightSidebarOpen}
              persist={false}
              shortcut={null}
              width="24rem"
              mobileBreakpoint={1024}
              className="min-h-0 min-w-0 flex-1"
            >
              <main className="relative flex min-w-0 flex-1 overflow-hidden">
                <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <div className="flex h-12 shrink-0 items-center gap-2 bg-surface-1 px-3">
                    <div className="mx-auto mt-2 min-w-0 flex-1 max-w-[1000px] px-4 [&_[data-pipper-id=global-tab-bar]]:justify-center">
                      <GlobalTabBar />
                    </div>
                    <SidebarTrigger
                      size="icon-sm"
                      className="mt-2 shrink-0"
                      aria-label="Toggle workspace panel"
                    >
                      <SidebarSimple size={16} className="-scale-x-100" />
                    </SidebarTrigger>
                  </div>
                  <div className="relative min-h-0 flex-1 overflow-hidden">
                    <AgentView />
                    {terminalSessions.map((session) => {
                      const active = showTerminalView && activeTerminalId === session.id;
                      if (!active && !viewedTerminalIds.has(session.id)) return null;
                      return (
                        <div
                          key={session.id}
                          className={cn(
                            "absolute inset-0 z-30 bg-surface-1 p-2",
                            active ? "visible" : "invisible pointer-events-none",
                          )}
                        >
                          <Suspense fallback={null}>
                            <TerminalSession
                              sessionId={session.id}
                              cwd={session.cwd}
                              isActive={active}
                            />
                          </Suspense>
                        </div>
                      );
                    })}
                  </div>
                  <WorkspaceSetupFailures projects={projects} />
                  <ThreadCompletionDock projects={projects} />
                </section>
                <Sidebar side="right" collapsible="offcanvas" rail={false}>
                  <WorkspaceControlPanel
                    project={activeProject}
                    worktreePath={selectedPath}
                    workspaceName={selectedWorkspaceName}
                    onToneChange={setSelectedTone}
                    onDelete={
                      activeProject && selectedWorktree && !selectedWorktree.isProjectRoot
                        ? () => deleteWorkspace(activeProject, selectedWorktree)
                        : undefined
                    }
                    onContinued={activeProject ? () => reloadWorkspaces(activeProject) : undefined}
                  />
                </Sidebar>
              </main>
            </SidebarProvider>
          </div>
        </div>
        {dialogProject && (
          <WorkspaceNameDialog
            project={dialogProject}
            isCreating={isCreating}
            error={dialogRepoError ?? worktreeError}
            repoState={dialogRepoState}
            isInitializing={isInitializingRepo}
            onCancel={closeWorkspaceDialog}
            onSubmit={(name) => void createWorkspace(name)}
            onInitialize={() => void initializeDialogRepo()}
            onRetryRepoState={() => void checkDialogRepoState(dialogProject.id)}
          />
        )}
      </SidebarProvider>
    </WorkspaceToneProvider>
  );
}
