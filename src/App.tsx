import { useEffect, useMemo, useState } from "react";
import { Bell, FolderPlus, GitBranch } from "@phosphor-icons/react";
import type { Project } from "../contracts/projects.ts";
import { normalizeWorkspacePath } from "../contracts/workspace-scope.ts";
import { HybridShell } from "@/components/hybrid-shell";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { useShowPreviewWorkspace } from "@/lib/file-preview-actions";
import {
  createMonitorObserverId,
  startMonitorFreezeObserver,
  startMonitorRuntimeObserver,
} from "@/lib/monitor-runtime-observer";
import { useMonitorTabSync } from "@/lib/monitor-tab-sync";
import { reportStartupMilestone } from "@/lib/startup-timing";
import { resolveTerminalWorkspace } from "@/lib/terminal-workspace";
import { useAgentStore } from "@/store/agent-store";
import { useLauncherUpdateStore } from "@/store/launcher-update-store";
import { useProjectStore } from "@/store/project-store";
import { makeWorkspaceKey, useTerminalStore } from "@/store/terminal-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { useWorktreeStore } from "@/store/worktree-store";

/**
 * The renderer root: app-wide wiring every view depends on (project context,
 * workspace selections, terminals bucketed by workspace, previews, monitor
 * telemetry, update checks), then the shell.
 *
 * The workspace follows the displayed thread; a draft keeps its own project
 * and worktree.
 */
export default function App() {
  const { activeProject, loadActiveProject, isLoading, error: projectError } = useProjectStore();
  const snapshotThreadId = useAgentStore((state) => state.snapshot?.threadId ?? null);
  const snapshotCwd = useAgentStore((state) => state.snapshot?.cwd ?? null);
  const snapshotProjectId = useAgentStore((state) => state.snapshot?.projectId ?? null);
  const draft = useWorkspaceViewStore((state) => state.draft);
  const initializeLauncherUpdates = useLauncherUpdateStore((state) => state.initialize);
  const selectedWorktreePathByProject = useWorktreeStore(
    (state) => state.selectedWorktreePathByProject,
  );
  const hasHydratedSelections = useWorktreeStore((state) => state.hasHydratedSelections);
  const [projects, setProjects] = useState<Project[]>([]);
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

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void initializeLauncherUpdates().then((dispose) => {
      cleanup = dispose;
    });
    return () => cleanup?.();
  }, [initializeLauncherUpdates]);

  // A draft can target a project other than the active one, so its path comes
  // from the full list.
  const loadProjects = async () => {
    try {
      setProjects(await window.omni.projects.list());
    } catch (err) {
      console.error("Failed to load projects list:", err);
    }
  };
  useEffect(() => {
    void loadProjects();
  }, [activeProject?.id]);

  // The project and workspace on screen: a draft's own, else the displayed
  // thread's, else the active project's persisted selection.
  const currentProject = useMemo(() => {
    if (draft) {
      if (!draft.projectId) return null;
      return (
        projects.find((project) => project.id === draft.projectId) ??
        (activeProject?.id === draft.projectId ? activeProject : null)
      );
    }
    return activeProject;
  }, [draft, projects, activeProject]);
  const followsThread = !draft && snapshotThreadId != null;
  const workspacePath = !currentProject
    ? null
    : draft
      ? (draft.worktreePath ?? currentProject.path)
      : followsThread && snapshotProjectId === currentProject.id && snapshotCwd
        ? snapshotCwd
        : (selectedWorktreePathByProject[currentProject.id] ?? currentProject.path);

  // Previews follow the workspace on screen.
  useShowPreviewWorkspace(
    currentProject?.id ?? null,
    currentProject ? normalizeWorkspacePath(workspacePath, currentProject.path) : null,
  );

  // The persisted per-project workspace selection is the canonical context,
  // and the MAIN process is its single writer (it reconciles on every thread
  // activation). The renderer mirrors it: re-read whenever the active
  // session changes, then keep terminals bucketed to (project, workspace).
  useEffect(() => {
    void useWorktreeStore.getState().syncSelections();
  }, [snapshotThreadId, snapshotCwd]);

  // Surface the background dependency install that follows a worktree create,
  // so the user knows when the workspace is actually ready to run.
  useEffect(() => {
    if (!window.omni?.worktrees?.onSetupProgress) return;
    return window.omni.worktrees.onSetupProgress((progress) => {
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
  }, []);

  // Project errors surface as a toast, once each, like every other error.
  useEffect(() => {
    if (projectError) toast(errorToast(projectError));
  }, [projectError]);

  // Workspaces created or deleted by anyone (an agent included): refresh the
  // persisted selection, which a delete moves to the root.
  useEffect(() => {
    return window.omni.worktrees.onChanged(() => {
      void useWorktreeStore.getState().syncSelections();
    });
  }, []);

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
    preferThread: !draft,
    thread: { threadId: snapshotThreadId, projectId: snapshotProjectId, cwd: snapshotCwd },
    project: activeProject,
    selectedPath: workspacePath,
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

  useEffect(() => {
    if (!window.omni?.projects?.onActiveChanged) return;
    return window.omni.projects.onActiveChanged(() => {
      void loadActiveProject();
    });
  }, [loadActiveProject]);

  useEffect(() => {
    if (!window.omni?.projects?.onListChanged) return;
    return window.omni.projects.onListChanged((project) => {
      void loadProjects();
      toast({
        icon: <FolderPlus weight="duotone" className="size-5 text-emerald-500" />,
        title: "Project added",
        description: `${project.name} is ready in your project list.`,
        duration: 5000,
      });
    });
  }, []);

  if (isLoading && !activeProject) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-1 text-muted-foreground text-sm font-mono">
        Loading project context…
      </div>
    );
  }

  return <HybridShell />;
}
