import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import { AgentView } from "@/components/agent-view";
import { DiffIngestor } from "@/components/diff-ingestor";
import { DiffLayer } from "@/components/diff-layer";
import { GlobalTabBar } from "@/components/global-tab-bar";
import { PreviewLayer } from "@/components/file-preview/preview-layer";
import { ProjectThreadsDropdown } from "@/components/project-threads-dropdown";
import { SessionPanel, useSessionWorkspace } from "@/components/session-panel";
import { ThreadCompletionDock } from "@/components/thread-completion-dock";
import { ProjectRail } from "@/components/project-rail";
import { WorkspaceToneProvider } from "@/lib/workspace-tone-context";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { useShellProjectId } from "@/lib/shell-project";
import { newDraftWorktreePath } from "@/lib/draft-worktree";
import { upsertProject } from "@/lib/project-order";
import { surfaceBgClass } from "@/lib/surface-classes";
import { SurfaceProvider } from "@/lib/surface-context";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { getAllTerminalSessions, useTerminalStore } from "@/store/terminal-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

// Loaded on first terminal so xterm/WASM stay out of the startup chunk.
const TerminalSession = lazy(() =>
  import("@/components/terminal-session").then((m) => ({ default: m.TerminalSession })),
);

const SESSION_PANEL_KEY = "pipper.hybrid.sessionPanelOpen";

/** Surface level of the inset card that holds the thread and its panels. */
const INSET_SURFACE = 2;

// macOS draws the window's traffic lights over the top-left corner.
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

function readSessionPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(SESSION_PANEL_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * The app shell: a left rail with one shape tile per project, the global tab bar
 * (scoped to the selected project) over the agent view, and the session
 * panel on the right with the displayed thread's git state, checks,
 * subthreads, changes and files. Worktrees are picked in the composer rail,
 * beside the model, or from the session panel.
 */
export function HybridShell() {
  const activeProject = useProjectStore((state) => state.activeProject);
  const shellProjectId = useShellProjectId();
  const loadProjectThreads = useThreadStore((state) => state.loadProjectThreads);
  const [projects, setProjects] = useState<Project[]>([]);
  const shellProject =
    projects.find((project) => project.id === shellProjectId) ??
    (activeProject?.id === shellProjectId ? activeProject : null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionPanelOpen, setSessionPanelOpenState] = useState(readSessionPanelOpen);
  const setSessionPanelOpen = (update: (open: boolean) => boolean) => {
    setSessionPanelOpenState((open) => {
      const next = update(open);
      try {
        window.localStorage.setItem(SESSION_PANEL_KEY, String(next));
      } catch {
        // Keep the in-memory choice when storage is unavailable.
      }
      return next;
    });
  };
  const session = useSessionWorkspace(projects);
  // The selected tile takes its git colour once its thread is on screen;
  // until then it shows the bright neutral fill.
  const sessionTone =
    session.project && session.project.id === activeProject?.id ? session.tone : "neutral";

  const deleteProject = async (project: Project) => {
    const confirmed = window.confirm(
      `Delete “${project.name}” from Pipper? Its chats and project history will be deleted. The project folder and worktrees on disk will be kept.`,
    );
    if (!confirmed) return;
    try {
      const result = await window.omni.projects.delete(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (
        result.activeProjectId === null &&
        useProjectStore.getState().activeProject?.id === project.id
      ) {
        useProjectStore.getState().clearActiveProject();
      }
    } catch (err) {
      toast(errorToast(err instanceof Error ? err.message : "Could not delete that project."));
    }
  };

  useEffect(() => {
    void window.omni.projects
      .list()
      .then(setProjects)
      .catch(() => setProjects([]));
    const unsubscribe = window.omni.projects.onListChanged?.((project) => {
      setProjects((current) => upsertProject(current, project));
    });
    const unsubscribeDeleted = window.omni.projects.onDeleted?.((projectId) => {
      setProjects((current) => current.filter((item) => item.id !== projectId));
    });
    return () => {
      unsubscribe?.();
      unsubscribeDeleted?.();
    };
  }, []);

  useEffect(() => {
    if (!shellProjectId) return;
    void loadProjectThreads(shellProjectId, { reset: true });
  }, [shellProjectId, loadProjectThreads]);

  // "[" toggles the rail and "]" the session panel.
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
        setSidebarOpen((open) => !open);
      } else if (event.key === "]") {
        event.preventDefault();
        setSessionPanelOpen((open) => !open);
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
    if (project.id === shellProjectId) return;
    // A draft follows the selected project: it would otherwise send into the
    // project the user just left, with that project's worktree. Only the
    // draft moves; see useShellProjectId.
    const view = useWorkspaceViewStore.getState();
    if (view.draft) {
      const worktreePath = newDraftWorktreePath(project);
      view.setDraftProject(project.id, worktreePath, { markDirty: false });
      return;
    }
    try {
      await window.omni.projects.setActive(project.id);
    } catch (err) {
      toast(errorToast(err instanceof Error ? err.message : "Could not open that project."));
    }
  };

  return (
    <WorkspaceToneProvider tone={session.project ? session.tone : null}>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        persist={false}
        shortcut={null}
        width="5.5rem"
      >
        <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-surface-1 text-foreground">
          <DiffIngestor />
          <Toaster />
          {/* Reaching the left edge slides the docked rail back in. */}
          {!sidebarOpen ? (
            <div
              className="group/left-edge absolute inset-y-0 left-0 z-40 w-6"
              onPointerEnter={() => setSidebarOpen(true)}
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-px bg-border opacity-0 transition-opacity duration-80 group-hover/left-edge:opacity-100"
              />
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <Sidebar variant="inset" collapsible="offcanvas" rail={false}>
              <div className="flex min-h-0 flex-1 flex-col">
                {/* Clears the window controls, level with the tab bar. */}
                <div className={cn("shrink-0", IS_MAC ? "h-12" : "h-3")} />
                <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
                  {projects.length === 0 ? (
                    <p className="px-1 py-2 text-center text-[11px] text-muted-foreground/70">
                      No projects yet
                    </p>
                  ) : (
                    <ProjectRail
                      projects={projects}
                      onProjectsChange={setProjects}
                      selectedId={shellProjectId}
                      tone={sessionTone}
                      onOpen={(project) => void openProject(project)}
                      onDelete={(project) => void deleteProject(project)}
                    />
                  )}
                </div>
              </div>
            </Sidebar>

            <SidebarInset className="flex-row overflow-hidden">
              {/* The inset card is a raised surface; what's inside paints it. */}
              <SurfaceProvider value={INSET_SURFACE}>
                <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <div
                    className={cn(
                      "relative z-40 flex h-12 shrink-0 items-center gap-2 px-3 transition-[padding] duration-160 ease-out",
                      surfaceBgClass(INSET_SURFACE),
                      // With the rail collapsed the header reaches the window's corner.
                      IS_MAC && !sidebarOpen && "pl-20",
                    )}
                  >
                    <div className="mx-auto min-w-0 flex-1 max-w-[1000px] px-4 [&_[data-pipper-id=global-tab-bar]]:justify-center">
                      <GlobalTabBar />
                    </div>
                    <div className="ml-2 flex shrink-0 items-center gap-1">
                      <ProjectThreadsDropdown project={shellProject} />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={sessionPanelOpen ? "Hide session panel" : "Show session panel"}
                        aria-pressed={sessionPanelOpen}
                        title={
                          sessionPanelOpen ? "Hide session panel ( ] )" : "Show session panel ( ] )"
                        }
                        onClick={() => setSessionPanelOpen((open) => !open)}
                      >
                        <SidebarSimple size={16} className="-scale-x-100" />
                      </Button>
                    </div>
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
                            "absolute inset-0 z-30 p-2",
                            surfaceBgClass(INSET_SURFACE),
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
                    <PreviewLayer />
                    <DiffLayer />
                  </div>
                  <ThreadCompletionDock projects={projects} />
                </section>
                <aside
                  aria-label="Session"
                  aria-hidden={!sessionPanelOpen}
                  inert={!sessionPanelOpen}
                  className={cn(
                    "shrink-0 overflow-hidden border-l border-border transition-[width] duration-160 ease-out",
                    sessionPanelOpen ? "w-[22rem]" : "w-0 border-l-0",
                  )}
                >
                  <div className="h-full w-[22rem]">
                    {sessionPanelOpen ? <SessionPanel session={session} /> : null}
                  </div>
                </aside>
              </SurfaceProvider>
            </SidebarInset>
          </div>
        </div>
      </SidebarProvider>
    </WorkspaceToneProvider>
  );
}
