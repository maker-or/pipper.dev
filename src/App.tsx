import { useEffect, useState, useRef, useMemo, lazy, Suspense } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { ProjectIcon } from "@/components/ui/icon-picker";
import { useProjectStore } from "@/store/project-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { useAgentStore } from "@/store/agent-store";
import { getAllTerminalSessions, makeWorkspaceKey, useTerminalStore } from "@/store/terminal-store";
import { resolveTerminalWorkspace } from "@/lib/terminal-workspace";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/toast";
import { AgentView } from "@/components/agent-view";
import { GlobalTabBar } from "@/components/global-tab-bar";
import { DiffIngestor } from "@/components/diff-ingestor";
import { useDiffStore } from "@/store/diff-store";
import { useIsDiffSplit, useWorkspaceViewStore } from "@/store/workspace-view-store";
import { cn } from "@/lib/utils";
import { Dropdown, DropdownSeparator } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { useLauncherUpdateStore } from "@/store/launcher-update-store";
import { reportStartupMilestone } from "@/lib/startup-timing";
import { Bell, FolderPlus, GitBranch, Plus, PlusMinusIcon } from "@phosphor-icons/react";
import { ProjectThreadsDropdown } from "@/components/project-threads-dropdown";

const DiffView = lazy(() =>
  import("@/components/diff-view").then((m) => ({ default: m.DiffView })),
);
const TerminalSession = lazy(() =>
  import("@/components/terminal-session").then((m) => ({ default: m.TerminalSession })),
);
const ProjectFileTree = lazy(() =>
  import("@/components/project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);
const LauncherUpdateBanner = lazy(() =>
  import("@/components/launcher-update").then((m) => ({ default: m.LauncherUpdateBanner })),
);
const LauncherUpdateDialog = lazy(() =>
  import("@/components/launcher-update").then((m) => ({ default: m.LauncherUpdateDialog })),
);
import type { Worktree } from "../contracts/worktrees.ts";
import {
  createMonitorObserverId,
  startMonitorFreezeObserver,
  startMonitorRuntimeObserver,
} from "@/lib/monitor-runtime-observer";
import { useMonitorTabSync } from "@/lib/monitor-tab-sync";
import { AdvancedShell } from "@/components/advanced-shell";
import { useShowPreviewWorkspace } from "@/lib/file-preview-actions";
import { PreviewLayer } from "@/components/file-preview/preview-layer";
import { normalizeWorkspacePath } from "../contracts/workspace-scope.ts";
import { useUiModeStore } from "@/store/ui-mode-store";

const EMPTY_WORKTREES: Worktree[] = [];

export default function App() {
  const uiMode = useUiModeStore((state) => state.mode);
  const { activeProject, loadActiveProject, isLoading, error: projectError } = useProjectStore();
  const snapshotThreadId = useAgentStore((state) => state.snapshot?.threadId ?? null);
  const snapshotCwd = useAgentStore((state) => state.snapshot?.cwd ?? null);
  const snapshotProjectId = useAgentStore((state) => state.snapshot?.projectId ?? null);

  // ── Workspace view routing ────────────────────────────────────────────
  // The header tab strip (GlobalTabBar) flips these; we route the workspace
  // area between a full-width agent view, a 40:60 agent|diff split, and a
  // full-width terminal overlay. The agent view stays mounted across all
  // three states (terminal is an overlay, the diff panel mounts beside it)
  // so its composer draft and scroll position survive tab switches.
  const workspaceMode = useWorkspaceViewStore((state) => state.mode);
  const draft = useWorkspaceViewStore((state) => state.draft);
  const activeTerminalId = useWorkspaceViewStore((state) => state.activeTerminalId);
  const terminalTabsRevision = useTerminalStore((state) => state.tabsRevision);
  const terminalSessions = useMemo(
    () =>
      getAllTerminalSessions(useTerminalStore.getState()).map((session) => ({
        id: session.id,
        cwd: session.cwd,
      })),
    [terminalTabsRevision],
  );
  const hasActiveTerminal =
    activeTerminalId != null && terminalSessions.some((session) => session.id === activeTerminalId);
  const diffFileCount = useDiffStore((state) => state.order.length);
  const isDiffOpen = useDiffStore((state) => state.isOpen);
  const openDiff = useDiffStore((state) => state.open);
  const closeDiff = useDiffStore((state) => state.close);
  const showAgent = useWorkspaceViewStore((state) => state.showAgent);
  const showDiffSplit = useIsDiffSplit();
  const showTerminalView = workspaceMode === "terminal" && hasActiveTerminal;
  // Draft chrome: never show ambient activeProject just because one is open.
  // Only show a project name when the draft bound one (chip) or we're live.
  const isDraftMode = draft != null;
  const toggleDiff = () => {
    if (isDraftMode) return;
    if (workspaceMode !== "agent") {
      showAgent();
      openDiff();
      return;
    }
    if (isDiffOpen) closeDiff();
    else openDiff();
  };
  const initializeLauncherUpdates = useLauncherUpdateStore((state) => state.initialize);
  const [monitorEnabled, setMonitorEnabled] = useState(false);

  useEffect(() => {
    void window.omni.monitor
      ?.isEnabled()
      .then((enabled) => setMonitorEnabled(enabled))
      .catch(() => setMonitorEnabled(false));
  }, []);

  // Report document.visibilityState to main so the agent bridge can stop
  // replaying streaming deltas into a window nobody can see.
  useEffect(() => {
    const report = () => window.omni?.window?.reportVisibility(!document.hidden);
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, []);

  useMonitorTabSync(monitorEnabled);

  useEffect(() => {
    if (!monitorEnabled) return;
    const observerId = createMonitorObserverId();
    // Detailed DOM attribution only while a monitor window or recording uses it.
    let detailed = false;
    void window.omni.monitor.getDemand().then((demand) => {
      detailed = demand.detailed;
    });
    const offDemand = window.omni.monitor.onDemand((demand) => {
      detailed = demand.detailed;
    });
    const context = {
      observerId,
      getActiveThreadId: () => useAgentStore.getState().state?.threadId ?? null,
      getRunningThreadIds: () => useAgentStore.getState().runningThreadIds,
      isDetailed: () => detailed,
    };
    const stopFreezeObserver = startMonitorFreezeObserver(context, (report) => {
      void window.omni.monitor.reportRendererFreeze({
        ...report,
        activeThreadId: context.getActiveThreadId(),
        runningThreadIds: context.getRunningThreadIds(),
      });
    });
    const stopRuntimeObserver = startMonitorRuntimeObserver(context, (telemetry) => {
      void window.omni.monitor.reportRendererTelemetry(telemetry);
    });
    return () => {
      offDemand();
      stopFreezeObserver();
      stopRuntimeObserver();
    };
  }, [monitorEnabled]);

  const [projectsList, setProjectsList] = useState<any[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isWorkspaceDropdownOpen, setIsWorkspaceDropdownOpen] = useState(false);
  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [isWorkspaceFormOpen, setIsWorkspaceFormOpen] = useState(false);
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);

  // Unbound draft has no project chrome — close the file tree so it can't
  // keep showing the previous ambient project's files.
  useEffect(() => {
    if (draft && !draft.projectId) setIsFileTreeOpen(false);
  }, [draft, draft?.projectId]);
  const [workspaceName, setWorkspaceName] = useState("");
  const workspaceGroupRef = useGroupRef();
  const workspaceLayoutsRef = useRef<Record<string, Record<string, number>>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);
  const workspaceButtonRef = useRef<HTMLButtonElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const branchButtonRef = useRef<HTMLButtonElement>(null);
  const {
    worktrees,
    branches,
    projectId: worktreeProjectId,
    branchProjectId,
    selectedWorktreePathByProject,
    isLoading: isLoadingWorktrees,
    isCreating: isCreatingWorktree,
    isSwitching: isSwitchingWorktree,
    isLoadingBranches,
    isSwitchingBranch,
    error: worktreeError,
    loadWorktrees,
    loadBranches,
    createWorktree,
    switchWorktree,
    switchBranch,
  } = useWorktreeStore();

  const loadProjectsList = async () => {
    try {
      if (window.omni?.projects?.list) {
        const list = await window.omni.projects.list();
        setProjectsList(list);
      }
    } catch (err) {
      console.error("Failed to load projects list:", err);
    }
  };

  useEffect(() => {
    void loadProjectsList();
  }, [activeProject?.id]);

  useEffect(() => {
    const handleFileTreeShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "b" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        setIsFileTreeOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", handleFileTreeShortcut);
    return () => document.removeEventListener("keydown", handleFileTreeShortcut);
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void initializeLauncherUpdates().then((dispose) => {
      cleanup = dispose;
    });
    return () => cleanup?.();
  }, [initializeLauncherUpdates]);

  const handleToggleDropdown = async () => {
    if (!isDropdownOpen) {
      await loadProjectsList();
    }
    setIsDropdownOpen((prev) => !prev);
  };

  const closeWorkspaceDropdown = () => {
    setIsWorkspaceDropdownOpen(false);
    setIsWorkspaceFormOpen(false);
    setWorkspaceName("");
  };

  const closeBranchDropdown = () => setIsBranchDropdownOpen(false);

  // Basic chrome follows the displayed thread while persisted project and
  // workspace mirrors catch up. Drafts keep their own explicit context.
  const chromeProject = useMemo(() => {
    if (isDraftMode) {
      if (!draft?.projectId) return null;
      return (
        projectsList.find((p) => p.id === draft.projectId) ??
        (activeProject?.id === draft.projectId ? activeProject : null)
      );
    }
    if (uiMode === "basic" && snapshotThreadId && snapshotProjectId) {
      return (
        (activeProject?.id === snapshotProjectId ? activeProject : null) ??
        projectsList.find((project) => project.id === snapshotProjectId) ??
        null
      );
    }
    return activeProject;
  }, [
    isDraftMode,
    draft?.projectId,
    projectsList,
    activeProject,
    uiMode,
    snapshotThreadId,
    snapshotProjectId,
  ]);

  const currentProject = chromeProject ?? activeProject;

  const handleToggleWorkspaceDropdown = () => {
    if (!currentProject) return;
    if (!isWorkspaceDropdownOpen) void loadWorktrees(currentProject.id);
    setIsWorkspaceDropdownOpen((open) => !open);
    closeBranchDropdown();
    setIsDropdownOpen(false);
  };

  const handleToggleBranchDropdown = () => {
    if (!currentProject) return;
    if (!isBranchDropdownOpen) void loadBranches(currentProject.id);
    setIsBranchDropdownOpen((open) => !open);
    closeWorkspaceDropdown();
    setIsDropdownOpen(false);
  };

  const handleCreateWorkspace = async () => {
    if (!currentProject || !workspaceName.trim() || isCreatingWorktree) return;
    const worktree = await createWorktree(currentProject.id, workspaceName.trim());
    if (!worktree) return;
    // The store only splices the new worktree into the list it currently
    // holds; when the picker targets another project (draft-bound), reload
    // that project so the new workspace is selectable right away.
    if (worktreeProjectId !== currentProject.id) void loadWorktrees(currentProject.id);
    if (draft) {
      useWorkspaceViewStore.getState().setDraftProject(currentProject.id, worktree.path);
      // A draft has no thread to activate yet. Switching the worktree through
      // the main process would restore that workspace's last thread and race
      // the eventual thread created by the draft's first send.
      setWorkspaceName("");
      setIsWorkspaceFormOpen(false);
      toast({
        icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
        title: "Worktree created",
        description: `${worktree.branch ?? "New branch"} is ready for the new thread.`,
      });
      return;
    }
    // Terminals follow via the workspace-bucket effect below once the
    // selection map updates.
    const thread = await switchWorktree(currentProject.id, worktree.path);
    if (!thread) return;
    setWorkspaceName("");
    setIsWorkspaceFormOpen(false);
    toast({
      icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
      title: "Worktree created",
      description: `${worktree.branch ?? "New branch"} is now selected.`,
    });
  };

  const handleSwitchWorktree = async (path: string) => {
    if (!currentProject || isSwitchingWorktree) return;
    if (draft) {
      useWorkspaceViewStore.getState().setDraftProject(currentProject.id, path);
      closeWorkspaceDropdown();
      return;
    }
    const thread = await switchWorktree(currentProject.id, path);
    if (!thread) return;
    closeWorkspaceDropdown();
  };

  const handleSwitchBranch = async (branch: string) => {
    if (!currentProject || !selectedWorktreePath || isSwitchingBranch) return;
    const worktree = await switchBranch(currentProject.id, selectedWorktreePath, branch);
    if (!worktree) return;
    closeBranchDropdown();
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        isDropdownOpen &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setIsDropdownOpen(false);
      }
      if (
        isWorkspaceDropdownOpen &&
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(target) &&
        workspaceButtonRef.current &&
        !workspaceButtonRef.current.contains(target)
      ) {
        closeWorkspaceDropdown();
      }
      if (
        isBranchDropdownOpen &&
        branchDropdownRef.current &&
        !branchDropdownRef.current.contains(target) &&
        branchButtonRef.current &&
        !branchButtonRef.current.contains(target)
      ) {
        closeBranchDropdown();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen, isWorkspaceDropdownOpen, isBranchDropdownOpen]);

  const checkedIndex = useMemo(() => {
    const idx = projectsList.findIndex((p) => p.id === currentProject?.id);
    return idx !== -1 ? idx : undefined;
  }, [currentProject?.id, projectsList]);
  // Stable identity when there's nothing to show, so effects keyed on this
  // don't re-fire on every render while another project's list is loaded.
  const visibleWorktrees = worktreeProjectId === currentProject?.id ? worktrees : EMPTY_WORKTREES;
  const visibleBranches = branchProjectId === currentProject?.id ? branches : [];
  const storedWorktreePath = currentProject
    ? selectedWorktreePathByProject[currentProject.id]
    : undefined;
  const followsThread = uiMode === "basic" && !draft && snapshotThreadId != null;
  const targetWorktreePath =
    draft && draft.projectId === currentProject?.id
      ? (draft.worktreePath ?? currentProject?.path)
      : followsThread && snapshotProjectId === currentProject?.id && snapshotCwd
        ? snapshotCwd
        : storedWorktreePath;
  // Preserve an explicit target even if it is missing from the cached list;
  // falling back to the root would label another workspace as the active one.
  // Git's root entry still handles a symlinked configured project path.
  const selectedWorktree =
    (targetWorktreePath
      ? (visibleWorktrees.find((worktree) => worktree.path === targetWorktreePath) ??
        (targetWorktreePath === currentProject?.path
          ? visibleWorktrees.find((worktree) => worktree.isProjectRoot)
          : null))
      : (visibleWorktrees.find((worktree) => worktree.isProjectRoot) ?? visibleWorktrees[0])) ??
    null;
  const selectedWorktreePath =
    selectedWorktree?.path ?? targetWorktreePath ?? currentProject?.path ?? null;
  // Previews follow the workspace the file tree lists. The advanced shell
  // reports its own workspace, so this one stays out of it.
  useShowPreviewWorkspace(
    uiMode === "basic",
    chromeProject?.id ?? null,
    chromeProject ? normalizeWorkspacePath(selectedWorktreePath, chromeProject.path) : null,
  );
  // Derive a real name from the path we already know, so the label is meaningful
  // even before the worktree list loads (or if it fails): the project root reads
  // as "main"; a linked worktree reads as its folder name. Never literal "Workspace".
  const derivedWorkspaceName = (() => {
    if (!selectedWorktreePath || !currentProject) return "main";
    if (selectedWorktreePath === currentProject.path) return "main";
    return selectedWorktreePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "main";
  })();
  const workspaceNameLabel = selectedWorktree?.workspaceName ?? derivedWorkspaceName;
  const branchLabel = selectedWorktree
    ? (selectedWorktree.branch ?? "Detached HEAD")
    : isLoadingWorktrees
      ? "Loading…"
      : "Unavailable";

  // File tree follows chrome project (draft chip or ambient). Unbound draft → off.
  const showFileTreePanel = isFileTreeOpen && chromeProject !== null;
  const workspaceLayoutKey = [
    "agent",
    ...(showDiffSplit ? ["diff"] : []),
    ...(showFileTreePanel ? ["files"] : []),
  ]
    .sort()
    .join(":");

  useEffect(() => {
    // react-resizable-panels applies these values by position, in panel
    // order (agent, diff, files), not by key: keep the keys in that order.
    const layout =
      workspaceLayoutsRef.current[workspaceLayoutKey] ??
      (showFileTreePanel
        ? showDiffSplit
          ? { agent: 34, diff: 51, files: 15 }
          : { agent: 85, files: 15 }
        : showDiffSplit
          ? { agent: 40, diff: 60 }
          : { agent: 100 });

    const expectedIds = Object.keys(layout).sort().join(":");
    let frameId = 0;
    let attempts = 0;

    const applyLayoutWhenReady = () => {
      const group = workspaceGroupRef.current;
      const registeredIds = group ? Object.keys(group.getLayout()).sort().join(":") : "";

      if (group && registeredIds === expectedIds) {
        group.setLayout(layout);
        return;
      }

      attempts += 1;
      if (attempts < 4) frameId = window.requestAnimationFrame(applyLayoutWhenReady);
    };

    frameId = window.requestAnimationFrame(applyLayoutWhenReady);
    return () => window.cancelAnimationFrame(frameId);
  }, [showFileTreePanel, showDiffSplit, workspaceGroupRef, workspaceLayoutKey]);

  // ── Workspace-first orchestration ─────────────────────────────────────
  // The persisted per-project workspace selection is the canonical context,
  // and the MAIN process is its single writer (it reconciles on every thread
  // activation). The renderer mirrors it: re-read whenever the active
  // session changes, then keep terminals bucketed to (project, workspace).
  const hasHydratedSelections = useWorktreeStore((state) => state.hasHydratedSelections);
  useEffect(() => {
    void useWorktreeStore.getState().syncSelections();
  }, [snapshotThreadId, snapshotCwd]);

  // Surface the background dependency install that follows a worktree create,
  // so the user knows when the workspace is actually ready to run.
  useEffect(() => {
    if (!window.omni?.worktrees?.onSetupProgress) return;
    return window.omni.worktrees.onSetupProgress((progress) => {
      if (uiMode === "advanced") return;
      // Remote/phone workspaces set up in the background; only a failure is
      // worth interrupting the desktop user for.
      if (progress.activation === "background" && progress.status !== "failed") return;
      if (progress.status === "installing") {
        toast({
          icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
          title: "Installing dependencies",
          description: `Running ${progress.manager} install in ${progress.workspaceName}…`,
        });
      } else if (progress.status === "installed") {
        toast({
          icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
          title: "Workspace ready",
          description: `${progress.workspaceName}: dependencies installed.`,
        });
      } else if (progress.status === "failed") {
        toast({
          icon: <Bell weight="duotone" className="size-5 text-red-500" />,
          title: "Dependency install failed",
          description: `${progress.workspaceName}: ${progress.message ?? "Install did not complete."}`,
        });
      } else if (progress.status === "skipped" && progress.message) {
        toast({
          icon: <GitBranch weight="duotone" className="size-5 text-foreground" />,
          title: "Workspace created",
          description: `${progress.workspaceName}: ${progress.message}`,
        });
      }
      // "skipped" (no package.json) is intentionally silent.
    });
  }, [uiMode]);

  // Deletion stops its terminals, including sessions in a background bucket.
  useEffect(() => {
    return window.omni.worktrees.onDeleted(({ projectId, path }) => {
      const closedIds = useTerminalStore
        .getState()
        .closeWorkspace(makeWorkspaceKey(projectId, path));
      const view = useWorkspaceViewStore.getState();
      if (view.activeTerminalId && closedIds.includes(view.activeTerminalId)) {
        view.setActiveTerminalId(null);
        view.showAgent();
      }
    });
  }, []);

  // Terminals belong to their workspace: entering another workspace (picker
  // switch, project switch, cross-workspace activation) hides the previous
  // sessions without stopping them and shows the target workspace's terminals.
  const terminalWorkspace = resolveTerminalWorkspace({
    preferThread: uiMode === "basic" && !draft,
    thread: { threadId: snapshotThreadId, projectId: snapshotProjectId, cwd: snapshotCwd },
    project: activeProject,
    selectedPath: selectedWorktreePath,
  });
  const terminalProjectId = terminalWorkspace?.projectId;
  const terminalCwd = terminalWorkspace?.cwd;
  useEffect(() => {
    if (!hasHydratedSelections || !terminalProjectId || !terminalCwd) return;
    const key = makeWorkspaceKey(terminalProjectId, terminalCwd);
    const terminals = useTerminalStore.getState();
    if (terminals.workspaceKey === key) return;
    const view = useWorkspaceViewStore.getState();
    const wasTerminalActive = view.mode === "terminal";
    let newActiveId = terminals.setWorkspace(key, terminalCwd);
    if (wasTerminalActive) {
      if (!newActiveId) {
        newActiveId = useTerminalStore.getState().createSession(terminalCwd);
      }
      view.showTerminal(newActiveId);
    } else {
      view.setActiveTerminalId(newActiveId);
    }
  }, [hasHydratedSelections, terminalProjectId, terminalCwd]);

  useEffect(() => {
    void loadActiveProject().finally(() => {
      reportStartupMilestone("project-context-ready");
    });
  }, [loadActiveProject]);

  const worktreeRefreshThreadId = followsThread ? snapshotThreadId : null;
  const worktreeRefreshCwd = followsThread ? snapshotCwd : null;
  useEffect(() => {
    if (currentProject) void loadWorktrees(currentProject.id);
  }, [currentProject?.id, worktreeRefreshThreadId, worktreeRefreshCwd, loadWorktrees]);

  useEffect(() => {
    if (!window.omni?.projects?.onActiveChanged) return;
    const unsubscribe = window.omni.projects.onActiveChanged(() => {
      void loadActiveProject();
    });
    return unsubscribe;
  }, [loadActiveProject]);

  useEffect(() => {
    if (!window.omni?.projects?.onListChanged) return;
    const unsubscribe = window.omni.projects.onListChanged((project) => {
      void loadProjectsList();
      toast({
        icon: <FolderPlus weight="duotone" className="size-5 text-emerald-500" />,
        title: "Project added",
        description: `${project.name} is ready in your project list.`,
        duration: 5000,
      });
    });
    return unsubscribe;
  }, []);

  if (isLoading && !activeProject) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-1 text-muted-foreground text-sm font-mono">
        Loading project context…
      </div>
    );
  }

  if (uiMode === "advanced") {
    return <AdvancedShell />;
  }

  return (
    <div className="relative h-screen w-screen flex flex-col bg-surface-1 text-foreground">
      {/* Headless: keeps the diff store fed from the active agent thread. */}
      <DiffIngestor />
      <Suspense fallback={null}>
        <LauncherUpdateDialog />
      </Suspense>

      {/* Title Bar / Header */}
      <header
        className="h-14 grid grid-cols-[clamp(160px,22vw,240px)_minmax(0,1fr)_clamp(160px,22vw,240px)] items-center px-4 border-b border-border/60 bg-surface-1 select-none shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        data-pipper-id="header"
      >
        <div
          className="relative flex w-full min-w-0 items-center gap-3 p-2 pl-[4.5rem]"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          data-pipper-id="Project Selector Wrapper"
        >
          {chromeProject ? (
            <div className="flex w-full min-w-0 items-center gap-2">
              <div className="flex w-full min-w-0 flex-col items-start">
                <button
                  type="button"
                  ref={buttonRef}
                  onClick={handleToggleDropdown}
                  className="group flex w-full min-w-0 items-center gap-1 rounded px-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <span className="truncate text-[15px] font-semibold tracking-tight text-foreground">
                    {chromeProject.name}
                  </span>
                </button>
                {/* Worktree/branch only make sense once a project is bound. */}
                <div className="flex w-full min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    ref={workspaceButtonRef}
                    onClick={handleToggleWorkspaceDropdown}
                    className="group flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded px-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Select worktree"
                  >
                    <GitBranch weight="duotone" className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate group-hover:text-foreground">
                      {workspaceNameLabel}
                    </span>
                  </button>
                  <span className="shrink-0 text-muted-foreground/40">/</span>
                  <button
                    type="button"
                    ref={branchButtonRef}
                    onClick={handleToggleBranchDropdown}
                    className="group flex min-w-0 items-center gap-1 rounded px-1 font-mono text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label="Select branch"
                  >
                    <span className="truncate group-hover:text-foreground">{branchLabel}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : isDraftMode ? (
            <div className="flex min-w-0 items-center gap-2 px-1">
              <span className="truncate text-[15px] font-semibold tracking-tight text-muted-foreground">
                New thread
              </span>
            </div>
          ) : null}

          {isDropdownOpen && (
            <div ref={dropdownRef} className="absolute left-0 top-full mt-1 z-[200]">
              <Dropdown checkedIndex={checkedIndex} className="w-64 max-h-[300px]">
                {projectsList.map((project, idx) => {
                  const ProjectIconItem = ((props: { className?: string }) => (
                    <ProjectIcon name={project.icon} className={props.className} />
                  )) as any;
                  return (
                    <MenuItem
                      key={project.id}
                      index={idx}
                      label={project.name}
                      icon={ProjectIconItem}
                      checked={chromeProject?.id === project.id}
                      onSelect={async () => {
                        setIsDropdownOpen(false);
                        // While drafting, the project switcher owns the draft's
                        // context project (same as the @project chip).
                        if (draft) {
                          const worktreePath =
                            useWorktreeStore.getState().selectedWorktreePathByProject[project.id] ??
                            project.path ??
                            null;
                          useWorkspaceViewStore
                            .getState()
                            .setDraftProject(project.id, worktreePath);
                          useWorkspaceViewStore.getState().markDraftUserEditedProject();
                        }
                        // Draft project selection is local context. Activating
                        // the project here would also restore its last thread,
                        // which must not happen until the draft is submitted.
                        if (!draft && window.omni?.projects?.setActive) {
                          try {
                            await window.omni.projects.setActive(project.id);
                          } catch (err) {
                            toast({
                              icon: <Bell weight="duotone" className="size-5 text-red-500" />,
                              title: "Project switch failed",
                              description:
                                err instanceof Error
                                  ? err.message
                                  : "Could not activate that project.",
                            });
                          }
                        }
                      }}
                    />
                  );
                })}
                {projectsList.length > 0 && <DropdownSeparator />}
                <MenuItem
                  index={projectsList.length}
                  label="Add Project"
                  icon={(props) => <FolderPlus {...props} weight="duotone" />}
                  onSelect={async () => {
                    setIsDropdownOpen(false);
                    if (window.omni?.launch?.show) {
                      await window.omni.launch.show("add");
                    }
                  }}
                />
              </Dropdown>
            </div>
          )}

          {isWorkspaceDropdownOpen && currentProject && (
            <div
              ref={workspaceDropdownRef}
              className="absolute left-7 top-full z-[200] mt-1 w-80 overflow-hidden rounded-xl border border-border bg-surface-1 p-1.5 shadow-surface-5"
            >
              <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Worktrees
              </div>
              <div className="max-h-[280px] overflow-y-auto">
                {isLoadingWorktrees ? (
                  <div className="px-2 py-3 text-[12px] text-muted-foreground">
                    Loading worktrees…
                  </div>
                ) : (
                  visibleWorktrees.map((worktree) => {
                    const isSelected = worktree.path === selectedWorktreePath;
                    const name = worktree.workspaceName ?? "Workspace";
                    return (
                      <button
                        key={worktree.path}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                          isSelected
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-hover hover:text-foreground"
                        }`}
                        disabled={isSelected || isSwitchingWorktree}
                        onClick={() => void handleSwitchWorktree(worktree.path)}
                      >
                        <GitBranch weight="duotone" className="size-3.5 shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium">{name}</span>
                          <span className="block truncate font-mono text-[10px] opacity-70">
                            {worktree.path}
                          </span>
                        </span>
                        {isSelected && <span className="size-1.5 rounded-full bg-foreground" />}
                      </button>
                    );
                  })
                )}
              </div>
              {worktreeError && (
                <div className="px-2 py-2 text-[11px] text-red-500">{worktreeError}</div>
              )}
              <div className="mt-1 border-t border-border/60 pt-1">
                {isWorkspaceFormOpen ? (
                  <form
                    className="flex gap-1 px-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleCreateWorkspace();
                    }}
                  >
                    <input
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                      placeholder="New worktree name"
                      aria-label="New worktree name"
                      autoFocus
                      className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1.5 text-[12px] text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-ring"
                    />
                    <button
                      type="submit"
                      disabled={!workspaceName.trim() || isCreatingWorktree || isSwitchingWorktree}
                      className="rounded-md bg-foreground px-2 text-[11px] font-medium text-background disabled:opacity-50"
                    >
                      {isCreatingWorktree || isSwitchingWorktree ? "…" : "Create"}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                    onClick={() => setIsWorkspaceFormOpen(true)}
                  >
                    <Plus weight="duotone" className="size-3.5" />
                    New worktree
                  </button>
                )}
              </div>
            </div>
          )}

          {isBranchDropdownOpen && currentProject && selectedWorktree && (
            <div
              ref={branchDropdownRef}
              className="absolute left-7 top-full z-[200] mt-1 w-80 overflow-hidden rounded-xl border border-border bg-surface-1 p-1.5 shadow-surface-5"
            >
              <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Local branches · {workspaceNameLabel}
              </div>
              <div className="max-h-[280px] overflow-y-auto">
                {isLoadingBranches ? (
                  <div className="px-2 py-3 text-[12px] text-muted-foreground">
                    Loading branches…
                  </div>
                ) : visibleBranches.length === 0 ? (
                  <div className="px-2 py-3 text-[12px] text-muted-foreground">
                    No local branches found.
                  </div>
                ) : (
                  visibleBranches.map((branch) => {
                    const isCurrent = branch.name === selectedWorktree.branch;
                    const heldElsewhere =
                      branch.worktreePath !== null && branch.worktreePath !== selectedWorktree.path;
                    const heldBy = visibleWorktrees.find(
                      (worktree) => worktree.path === branch.worktreePath,
                    );
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        disabled={isCurrent || heldElsewhere || isSwitchingBranch}
                        onClick={() => void handleSwitchBranch(branch.name)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-default ${
                          isCurrent
                            ? "bg-accent text-foreground"
                            : heldElsewhere
                              ? "text-muted-foreground/45"
                              : "text-muted-foreground hover:bg-hover hover:text-foreground"
                        }`}
                      >
                        <GitBranch weight="duotone" className="size-3.5 shrink-0 opacity-70" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12px] font-medium">
                            {branch.name}
                          </span>
                          {heldElsewhere && (
                            <span className="block truncate text-[10px] opacity-70">
                              Checked out in {heldBy?.workspaceName ?? "another worktree"}
                            </span>
                          )}
                        </span>
                        {isCurrent && <span className="size-1.5 rounded-full bg-foreground" />}
                      </button>
                    );
                  })
                )}
              </div>
              {worktreeError && (
                <div className="px-2 py-2 text-[11px] text-red-500">{worktreeError}</div>
              )}
            </div>
          )}
        </div>

        <div
          className="mx-2 flex min-w-0 items-center [&_[data-pipper-id=global-tab-bar]]:mx-auto [&_[data-pipper-id=global-tab-bar]]:justify-center"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          data-pipper-id="Global Tab Bar Wrapper"
        >
          <GlobalTabBar />
        </div>

        <div
          className="flex w-[72px] shrink-0 items-center justify-self-end justify-end gap-1"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          data-pipper-id="Theme and Flyout Controls"
        >
          {!isDraftMode && diffFileCount > 0 && (
            <button
              type="button"
              onClick={toggleDiff}
              aria-label={showDiffSplit ? "Hide changes" : "View changes"}
              title={showDiffSplit ? "Hide changes" : "View changes"}
              className={cn(
                "relative inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                showDiffSplit
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              data-pipper-id="header-diff-toggle"
            >
              <PlusMinusIcon weight="bold" className="size-4" />
            </button>
          )}
          <ProjectThreadsDropdown />
        </div>
      </header>

      <Suspense fallback={null}>
        <LauncherUpdateBanner />
      </Suspense>
      {projectError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-[12px] text-red-500">
          {projectError}
        </div>
      )}

      <Toaster />

      {/* Workspace area.
          - Files (optional): 15% explorer on the left.
          - Agent thread (global): remaining width.
          - Diffs (optional): 60% of the non-explorer workspace.
          - Terminal (global): full-width terminal overlaid on the (still
            mounted) agent view.
          Stable panel keys preserve AgentView while optional siblings change. */}
      <div className="relative flex-1 flex min-h-0" data-pipper-id="workspace panel">
        <Group
          orientation="horizontal"
          groupRef={workspaceGroupRef}
          defaultLayout={{ agent: 100 }}
          onLayoutChanged={(layout) => {
            const key = Object.keys(layout).sort().join(":");
            workspaceLayoutsRef.current[key] = { ...layout };
          }}
          className="flex-1 flex min-h-0"
          data-pipper-id="workspace split"
        >
          <Panel
            key="agent"
            id="agent"
            data-pipper-id="agent panel"
            className="relative z-20 overflow-visible"
          >
            {/* Stable wrapper (never conditionally swapped) so AgentView is not
                remounted when the diff split toggles. The panel is full width
                in every state: the agent view owns the centered reading column
                for its conversation + composer so its ambient background can
                still span the full width behind them. */}
            <div className="flex h-full w-full flex-col">
              <AgentView />
            </div>
            {/* Inside the agent panel, not over the whole workspace, so the
                file tree on the right stays clickable while previewing. */}
            <PreviewLayer />
          </Panel>
          {showDiffSplit && (
            <Separator
              key="diff-separator"
              className="group relative w-px bg-border transition-colors data-[separator-state=drag]:bg-foreground/30 data-[separator-state=hover]:bg-foreground/20"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
            </Separator>
          )}
          {showDiffSplit && (
            <Panel
              key="diff"
              id="diff"
              data-pipper-id="diff panel"
              minSize="40%"
              className="relative z-10 overflow-hidden"
            >
              <section className="h-full w-full flex flex-col bg-surface-1 p-2">
                <div className="flex-1 overflow-hidden min-h-0 rounded-md">
                  <Suspense fallback={null}>
                    <DiffView />
                  </Suspense>
                </div>
              </section>
            </Panel>
          )}
          {showFileTreePanel && (
            <Separator
              key="files-separator"
              className="group relative w-px bg-border transition-colors data-[separator-state=drag]:bg-foreground/30 data-[separator-state=hover]:bg-foreground/20"
            >
              <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
            </Separator>
          )}
          {showFileTreePanel && (
            <Panel
              key="files"
              id="files"
              defaultSize="15%"
              minSize="12%"
              maxSize="25%"
              data-pipper-id="file tree panel"
              className="relative z-10 overflow-hidden"
            >
              <section className="flex h-full w-full flex-col bg-surface-1">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Suspense fallback={null}>
                    <ProjectFileTree
                      projectId={chromeProject.id}
                      worktreePath={normalizeWorkspacePath(
                        selectedWorktreePath,
                        chromeProject.path,
                      )}
                    />
                  </Suspense>
                </div>
              </section>
            </Panel>
          )}
        </Group>

        {terminalSessions.map((session) => {
          const isActive = showTerminalView && activeTerminalId === session.id;
          return (
            <section
              key={session.id}
              className={cn(
                "absolute inset-0 z-30 flex flex-col overflow-hidden bg-surface-1 p-2",
                isActive
                  ? "pointer-events-auto visible opacity-100"
                  : "pointer-events-none invisible opacity-0 -z-10",
              )}
              aria-hidden={!isActive}
              inert={!isActive}
              data-pipper-id={`terminal-panel-${session.id}`}
            >
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <Suspense fallback={null}>
                  <TerminalSession sessionId={session.id} cwd={session.cwd} isActive={isActive} />
                </Suspense>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
