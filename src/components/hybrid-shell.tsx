import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DotsThree, FolderPlus, SidebarSimple, Trash } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import { AgentView } from "@/components/agent-view";
import { cardHeight, RunningAgents } from "@/components/advanced-shell";
import { DiffIngestor } from "@/components/diff-ingestor";
import { DiffLayer } from "@/components/diff-layer";
import { GlobalTabBar } from "@/components/global-tab-bar";
import { PreviewLayer } from "@/components/file-preview/preview-layer";
import { ProjectThreadsDropdown } from "@/components/project-threads-dropdown";
import { SessionPanel, useSessionWorkspace } from "@/components/session-panel";
import { ThreadCompletionDock } from "@/components/thread-completion-dock";
import { WorkspaceStateSurface } from "@/components/workspace-state";
import { ProjectIcon } from "@/components/ui/icon-picker";
import { Elevated } from "@/lib/elevated";
import type { HeaderTone } from "@/lib/workspace-tone";
import { WorkspaceToneProvider } from "@/lib/workspace-tone-context";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarFooter, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { useRunningAgentsByProject } from "@/lib/running-agents";
import { useShellProjectId } from "@/lib/shell-project";
import { newDraftWorktreePath } from "@/lib/draft-worktree";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { getAllTerminalSessions, useTerminalStore } from "@/store/terminal-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

// Loaded on first terminal so xterm/WASM stay out of the startup chunk.
const TerminalSession = lazy(() =>
  import("@/components/terminal-session").then((m) => ({ default: m.TerminalSession })),
);

const EMPTY_AGENT_IDS: string[] = [];

const SESSION_PANEL_KEY = "pipper.hybrid.sessionPanelOpen";

function readSessionPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(SESSION_PANEL_KEY) !== "false";
  } catch {
    return true;
  }
}

/** A single project rendered as a card in the sidebar grid. */
function ProjectCard({
  project,
  selected,
  tone,
  runningAgentIds,
  onSelect,
  onDelete,
}: {
  project: Project;
  selected: boolean;
  /** Git-state tone of the displayed thread's workspace, shown when selected. */
  tone: HeaderTone;
  /** Agents mid-turn anywhere in this project right now. */
  runningAgentIds: string[];
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = menuPosition !== null;
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!cardRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setMenuPosition(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuPosition(null);
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
      tone={selected ? tone : "neutral"}
      active={selected}
      offset={selected ? 0 : 2}
      ref={cardRef}
      className="group/card relative mb-2 break-inside-avoid rounded-2xl"
    >
      <button
        type="button"
        data-active={selected ? "true" : undefined}
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          setMenuPosition(null);
          onSelect();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuPosition({ x: event.clientX, y: event.clientY });
        }}
        style={{ minHeight: cardHeight(project.path, selected) }}
        className={cn(
          "relative flex w-full flex-col overflow-hidden rounded-2xl p-3 text-left outline-none",
          "transition-[background-color,color,box-shadow] duration-80",
          "focus-visible:ring-1 focus-visible:ring-ring",
          selected
            ? "bg-transparent text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <ProjectIcon name={project.icon} className="mb-2 size-4 shrink-0 opacity-80" />
        <span className="line-clamp-3 text-[13px] font-medium leading-snug">
          {project.name}
          {selected && <span className="sr-only"> (active project)</span>}
        </span>
        <RunningAgents agentIds={runningAgentIds} />
      </button>
      <button
        type="button"
        aria-label={`${project.name} options`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-open={menuOpen ? "true" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (menuOpen) {
            setMenuPosition(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition({ x: rect.right - 176, y: rect.bottom + 6 });
        }}
        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity duration-80 hover:bg-hover hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[open=true]:opacity-100"
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {menuPosition &&
        createPortal(
          <Elevated
            ref={menuRef}
            offset={2}
            role="menu"
            data-pipper-id="project-context-menu"
            className="fixed z-[500] w-44 rounded-lg border border-border p-1"
            style={{
              left: Math.max(8, Math.min(menuPosition.x, window.innerWidth - 184)),
              top: Math.max(8, Math.min(menuPosition.y, window.innerHeight - 48)),
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-destructive"
              onClick={() => {
                setMenuPosition(null);
                onDelete();
              }}
            >
              <Trash size={14} /> Delete project
            </button>
          </Elevated>,
          document.body,
        )}
    </WorkspaceStateSurface>
  );
}

/**
 * Hybrid shell: the advanced shell's left rail, one card per project instead
 * of per workspace. The thread area is the basic shell's: the global tab bar
 * (scoped to the selected project) over the agent view. Worktrees are picked
 * in the composer rail, beside the model. The right panel shows the displayed
 * thread's session: environment, context, connectors and changes.
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
  const runningAgents = useRunningAgentsByProject();
  const session = useSessionWorkspace(projects);
  // The card tints only for the project whose thread is on screen.
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
      .then((items) => setProjects(items.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setProjects([]));
    const unsubscribe = window.omni.projects.onListChanged?.((project) => {
      setProjects((current) =>
        [...current.filter((item) => item.id !== project.id), project].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
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

  // "[" toggles the rail and "]" the session panel, as in the advanced shell.
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
        width="20rem"
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
            <Sidebar collapsible="offcanvas" rail={false}>
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-end px-2 pb-2 pt-3">
                  <SidebarTrigger size="icon-sm" aria-label="Collapse project sidebar">
                    <SidebarSimple size={16} />
                  </SidebarTrigger>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2">
                  {projects.length === 0 ? (
                    <p className="px-1 py-2 text-[13px] text-muted-foreground/70">
                      No projects yet
                    </p>
                  ) : (
                    <div className="columns-2 gap-2">
                      {projects.map((project) => (
                        <ProjectCard
                          key={project.id}
                          project={project}
                          selected={project.id === shellProjectId}
                          tone={sessionTone}
                          runningAgentIds={runningAgents.get(project.id) ?? EMPTY_AGENT_IDS}
                          onSelect={() => void openProject(project)}
                          onDelete={() => void deleteProject(project)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <SidebarFooter className="border-t border-border p-2">
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground"
                  onClick={() => void window.omni.launch.show("add")}
                >
                  <FolderPlus size={16} />
                  New project
                </button>
              </SidebarFooter>
            </Sidebar>

            <main className="relative flex min-w-0 flex-1 overflow-hidden">
              <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <div className="relative z-40 flex h-12 shrink-0 items-center gap-2 bg-surface-1 px-3">
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
                  sessionPanelOpen ? "w-72" : "w-0 border-l-0",
                )}
              >
                <div className="h-full w-72 overflow-y-auto pt-1">
                  {sessionPanelOpen ? <SessionPanel session={session} /> : null}
                </div>
              </aside>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </WorkspaceToneProvider>
  );
}
