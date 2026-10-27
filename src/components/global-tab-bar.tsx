"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChatCircleIcon,
  FileCodeIcon,
  FileIcon,
  FilmStripIcon,
  FolderPlusIcon,
  ImageIcon,
  MusicNotesIcon,
  PlusIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dropdown, DropdownSeparator } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { Tabs, TabsList, TabItem } from "@/components/ui/tabs";
import { ProjectIcon } from "@/components/ui/icon-picker";
import { PixelGridLoader } from "@/components/ui/pixel-grid-loader";
import { toast } from "@/components/ui/toast";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { useAgentStore } from "@/store/agent-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { makeWorkspaceKey, useTerminalStore } from "@/store/terminal-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { usePreviewStore } from "@/store/preview-store";
import { useShownPreviewWorkspaceKey } from "@/lib/file-preview-actions";
import { useUiModeStore } from "@/store/ui-mode-store";
import { useTabGestureStore } from "@/store/tab-gesture-store";
import { useThreadCompletionStore } from "@/store/thread-completion-store";
import { confirmDiscardDraft, selectThread } from "@/lib/thread-actions";
import { beginRendererInteraction } from "@/lib/monitor-runtime-observer";
import { visibleWorkspaceThreadTabs } from "@/lib/thread-tab-state";
import { listenForPageSwipes } from "@/lib/page-swipe";
import { resolveTerminalWorkspace } from "@/lib/terminal-workspace";
import { useAnchoredPopoverPosition } from "@/lib/anchored-popover";
import {
  OPEN_TABS_QUERY_KEY,
  useOpenTabsQuery,
  usePrefetchRecentProjects,
  useRecentProjectsQuery,
} from "@/lib/thread-queries";
import type { Thread } from "../../contracts/threads.ts";
import { isThreadInWorkspace, normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import {
  activeTabToClose,
  isCloseTabShortcutEvent,
  isNewTabShortcutEvent,
  isNewTerminalShortcutEvent,
  tabIndexFromShortcutEvent,
  tabValueAfterSwipe,
  tabValueAtShortcutIndex,
  tabValuesInBarOrder,
} from "@/lib/tab-shortcuts";

const TERMINAL_TAB_PREFIX = "terminal:";
/** The workspace's single file preview tab. */
const PREVIEW_TAB_VALUE = "__preview__";

const IMAGE_EXTENSION = /\.(png|apng|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const VIDEO_EXTENSION = /\.(mp4|m4v|webm|mov|ogv)$/i;
const AUDIO_EXTENSION = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i;
const BINARY_EXTENSION = /\.(pdf|zip|gz|tar|dmg|exe|bin|woff2?|ttf|otf)$/i;

function previewTabIcon(path: string) {
  if (IMAGE_EXTENSION.test(path)) return ImageIcon;
  if (VIDEO_EXTENSION.test(path)) return FilmStripIcon;
  if (AUDIO_EXTENSION.test(path)) return MusicNotesIcon;
  if (BINARY_EXTENSION.test(path)) return FileIcon;
  return FileCodeIcon;
}

// Stable component identity — a fresh function reference remounts the icon on
// every unrelated re-render (e.g. streaming), restarting the CSS pulse.
function TabWorkingIcon(props: { className?: string; size?: number }) {
  return <PixelGridLoader size={props.size} className={props.className} />;
}

const projectIconComponentCache = new Map<
  string,
  (props: { className?: string }) => ReactElement
>();
function getProjectIconComponent(name: string) {
  let Component = projectIconComponentCache.get(name);
  if (!Component) {
    Component = (props: { className?: string }) => (
      <ProjectIcon name={name} className={props.className} />
    );
    projectIconComponentCache.set(name, Component);
  }
  return Component;
}

/**
 * The shared tab strip that lives above the active workspace. It merges the
 * two kinds of views into one row:
 *   - agent threads (persisted, backed by open-tabs)
 *   - terminals (ephemeral, backed by the in-memory terminal store)
 *
 * "New thread" opens a draft composer (no session spawn). Creation happens on
 * first send in AgentPanel.
 */
export function GlobalTabBar() {
  const queryClient = useQueryClient();
  const { activeProject } = useProjectStore();
  const { pagesByProject, loadProjectThreads, renameThread } = useThreadStore();
  const snapshot = useAgentStore((state) => state.snapshot);
  const agentError = useAgentStore((state) => state.error);
  const runningThreadIds = useAgentStore((state) => state.runningThreadIds);
  const pendingThreadTarget = useAgentStore((state) => state.pendingThreadTarget);

  const requestedThreadId = useWorkspaceViewStore((state) => state.requestedThreadId);
  const requestThread = useWorkspaceViewStore((state) => state.requestThread);
  const mode = useWorkspaceViewStore((state) => state.mode);
  const showAgent = useWorkspaceViewStore((state) => state.showAgent);
  const showTerminal = useWorkspaceViewStore((state) => state.showTerminal);
  const showPreview = useWorkspaceViewStore((state) => state.showPreview);
  const previewKey = useShownPreviewWorkspaceKey();
  // The path shown in this workspace's preview tab, or null when it has none.
  const previewPath = usePreviewStore((state) => {
    const preview = previewKey ? state.workspaces[previewKey] : undefined;
    return preview?.path ?? null;
  });
  const closePreview = usePreviewStore((state) => state.close);
  const draft = useWorkspaceViewStore((state) => state.draft);
  const draftCompletionThreadId = useWorkspaceViewStore((state) => state.draftCompletionThreadId);
  const beginDraft = useWorkspaceViewStore((state) => state.beginDraft);
  const endDraft = useWorkspaceViewStore((state) => state.endDraft);
  const clearDraftCompletion = useWorkspaceViewStore((state) => state.clearDraftCompletion);

  const terminalTabsRevision = useTerminalStore((state) => state.tabsRevision);
  const terminalWorkspaceKey = useTerminalStore((state) => state.workspaceKey);
  const terminalTabs = useMemo(
    () =>
      useTerminalStore
        .getState()
        .sessions.map(({ id, title, status, cwd }) => ({ id, title, status, cwd })),
    [terminalTabsRevision],
  );
  const activeTerminalId = useWorkspaceViewStore((state) => state.activeTerminalId);
  const setViewActiveTerminalId = useWorkspaceViewStore((state) => state.setActiveTerminalId);
  const closeSession = useTerminalStore((state) => state.closeSession);
  const initializeGlobalListener = useTerminalStore((state) => state.initializeGlobalListener);

  const selectedWorktreePathByProject = useWorktreeStore(
    (state) => state.selectedWorktreePathByProject,
  );
  const uiMode = useUiModeStore((state) => state.mode);

  const [projectsList, setProjectsList] = useState<
    Array<{ id: string; name: string; icon: string; path?: string }>
  >([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingThreadTitle, setEditingThreadTitle] = useState("");
  const [editingThreadOriginalTitle, setEditingThreadOriginalTitle] = useState("");

  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownPosition = useAnchoredPopoverPosition(buttonRef, isDropdownOpen, 224);
  const closingTabIdsRef = useRef<Set<string>>(new Set());
  const openedDraftCompletionRef = useRef<string | null>(null);

  const openTabsQuery = useOpenTabsQuery();
  const openTabsState = openTabsQuery.data;
  const openThreads = useMemo(() => openTabsState?.openThreads ?? [], [openTabsState?.openThreads]);
  const orderedOpenThreads = useMemo(() => {
    const threadsById = new Map(openThreads.map((thread) => [thread.id, thread]));
    return (openTabsState?.openThreadIds ?? [])
      .map((threadId) => threadsById.get(threadId))
      .filter((thread): thread is Thread => Boolean(thread));
  }, [openTabsState?.openThreadIds, openThreads]);
  const activeThreadId = openTabsState?.activeThreadId ?? null;
  const threadSwitchHistory = openTabsState?.threadSwitchHistory ?? [];
  const snapshotThreadId = snapshot?.threadId ?? null;
  const optimisticRequestedThreadId =
    requestedThreadId && pendingThreadTarget === requestedThreadId ? requestedThreadId : null;

  const activeWorkspacePath = useMemo(() => {
    if (!activeProject) return null;
    return normalizeWorkspacePath(
      selectedWorktreePathByProject[activeProject.id],
      activeProject.path,
    );
  }, [activeProject, selectedWorktreePathByProject]);

  const activeTerminalWorkspaceKey = useMemo(() => {
    if (!activeProject) return null;
    const selectedPath = selectedWorktreePathByProject[activeProject.id] ?? activeProject.path;
    return makeWorkspaceKey(activeProject.id, selectedPath);
  }, [activeProject, selectedWorktreePathByProject]);

  const visibleOpenThreads = useMemo(() => {
    if (uiMode !== "advanced") return orderedOpenThreads;
    return visibleWorkspaceThreadTabs(
      orderedOpenThreads,
      activeProject?.id ?? null,
      activeWorkspacePath,
      snapshotThreadId,
      optimisticRequestedThreadId,
    );
  }, [
    orderedOpenThreads,
    uiMode,
    activeProject,
    activeWorkspacePath,
    snapshotThreadId,
    optimisticRequestedThreadId,
  ]);

  const visibleTerminalTabs = useMemo(() => {
    if (uiMode !== "advanced" || !activeProject) return terminalTabs;
    // TerminalStore already buckets sessions using the canonical workspace
    // selected by the main process. Compare that bucket identity instead of
    // raw cwd strings, which may differ through symlinks or Git realpaths.
    return terminalWorkspaceKey === activeTerminalWorkspaceKey ? terminalTabs : [];
  }, [activeProject, activeTerminalWorkspaceKey, terminalTabs, terminalWorkspaceKey, uiMode]);

  const recentProjectsQuery = useRecentProjectsQuery(
    activeProject?.id,
    threadSwitchHistory,
    openThreads,
  );
  usePrefetchRecentProjects(recentProjectsQuery.data ?? []);

  useEffect(() => {
    async function loadProjects() {
      const list = await window.omni.projects.list();
      setProjectsList(list);
    }
    void loadProjects();
  }, [activeProject?.id]);

  useEffect(() => {
    if (!window.omni?.projects?.onListChanged) return;
    const unsubscribe = window.omni.projects.onListChanged(() => {
      void window.omni.projects
        .list()
        .then((list) => setProjectsList(list))
        .catch((err) => console.error("Failed to reload projects list:", err));
    });
    return unsubscribe;
  }, []);
  useEffect(() => {
    initializeGlobalListener();
  }, [initializeGlobalListener]);

  useEffect(() => {
    for (const projectId of recentProjectsQuery.data ?? []) {
      if (!pagesByProject[projectId]) void loadProjectThreads(projectId, { reset: true });
    }
  }, [loadProjectThreads, pagesByProject, recentProjectsQuery.data]);

  useEffect(() => {
    // While composing a draft, the snapshot can still belong to the previous
    // live thread (or to an unrelated background activation). Do not turn that
    // snapshot into an open tab until the draft has become a real thread.
    if (draft) return;
    // Draft submission provides the authoritative new thread id. Keep using
    // it until the agent snapshot catches up; otherwise a stale snapshot can
    // reopen the thread that was visible before the draft started.
    if (draftCompletionThreadId) {
      const targetThreadId = draftCompletionThreadId;
      if (openedDraftCompletionRef.current !== targetThreadId) {
        openedDraftCompletionRef.current = targetThreadId;
        void window.omni.tabs
          .open(targetThreadId)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: OPEN_TABS_QUERY_KEY });
          })
          .catch(() => {});
      }
      if (snapshotThreadId === targetThreadId) {
        openedDraftCompletionRef.current = null;
        clearDraftCompletion();
      }
      return;
    }
    if (!snapshotThreadId) return;
    // While a user switch is pending, snapshotThreadId is intentionally still
    // the previous thread. Persisting it here races the target activation and
    // makes the tab highlight jump back to the old thread.
    if (pendingThreadTarget) return;
    if (closingTabIdsRef.current.has(snapshotThreadId)) return;
    void window.omni.tabs
      .open(snapshotThreadId)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: OPEN_TABS_QUERY_KEY });
      })
      .catch(() => {});
  }, [
    snapshotThreadId,
    pendingThreadTarget,
    draft,
    draftCompletionThreadId,
    clearDraftCompletion,
    queryClient,
  ]);

  useEffect(() => {
    if (!requestedThreadId) return;
    if (requestedThreadId === snapshotThreadId || pendingThreadTarget !== requestedThreadId) {
      requestThread(null);
    }
  }, [requestedThreadId, snapshotThreadId, pendingThreadTarget, requestThread]);

  useEffect(() => {
    if (requestedThreadId && agentError) requestThread(null);
  }, [agentError, requestedThreadId, requestThread]);

  useEffect(() => {
    if (!editingThreadId) return;
    if (openThreads.some((thread) => thread.id === editingThreadId)) return;
    cancelRenameThread();
  }, [editingThreadId, openThreads]);

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
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isDropdownOpen]);

  const startRenameThread = (threadId: string, title: string) => {
    setEditingThreadId(threadId);
    setEditingThreadTitle(title);
    setEditingThreadOriginalTitle(title);
  };
  const cancelRenameThread = () => {
    setEditingThreadId(null);
    setEditingThreadTitle("");
    setEditingThreadOriginalTitle("");
  };
  const commitRenameThread = async () => {
    if (!editingThreadId) return false;
    const nextTitle = editingThreadTitle.trim();
    const originalTitle = editingThreadOriginalTitle.trim();
    if (!nextTitle || nextTitle === originalTitle) {
      cancelRenameThread();
      return true;
    }
    const renamedThread = await renameThread(editingThreadId, nextTitle);
    if (!renamedThread) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Rename failed",
        description: useThreadStore.getState().error ?? "The thread title was not updated.",
      });
      return false;
    }
    queryClient.setQueryData<{ openThreads: Thread[] } | undefined>(
      OPEN_TABS_QUERY_KEY,
      (current) =>
        current
          ? {
              ...current,
              openThreads: current.openThreads.map((thread) =>
                thread.id === renamedThread.id ? renamedThread : thread,
              ),
            }
          : current,
    );
    cancelRenameThread();
    return true;
  };

  const handleSelectThread = async (id: string, activateView = true) => {
    const currentDraft = useWorkspaceViewStore.getState().draft;
    if (currentDraft?.dirty) {
      const ok = confirmDiscardDraft();
      if (!ok) return;
    }
    if (currentDraft) endDraft();
    closingTabIdsRef.current.delete(id);
    await selectThread(id, { activateView });
  };

  const handleCloseThreadTab = async (id: string) => {
    if (closingTabIdsRef.current.has(id)) return;
    closingTabIdsRef.current.add(id);
    // Closing stops the run too; that stop is not a completion to announce.
    useThreadCompletionStore.getState().dismissThread(id);
    try {
      const wasActive = id === (snapshotThreadId ?? activeThreadId);
      const nextState = await window.omni.tabs.close(id);
      await queryClient.invalidateQueries({ queryKey: OPEN_TABS_QUERY_KEY });
      if (!wasActive) return;
      // Persisted state always names *some* open tab as active, and when the
      // closed tab was its workspace's last one that is a tab from another
      // workspace. Advanced mode hides those, so activating it would jump the
      // user to a thread they cannot see; fall through to the draft/terminal
      // path instead, exactly as if no tab remained.
      const nextThread = nextState.activeThreadId
        ? openThreads.find((thread) => thread.id === nextState.activeThreadId)
        : undefined;
      const nextIsVisible =
        uiMode !== "advanced" ||
        (nextThread !== undefined &&
          nextThread.project_id === activeProject?.id &&
          isThreadInWorkspace(nextThread, activeWorkspacePath));
      if (nextState.activeThreadId && nextIsVisible) {
        // Only bring the agent view forward when it was the view on screen.
        await handleSelectThread(nextState.activeThreadId, mode === "agent");
      } else {
        requestThread(null);
        const sessions = useTerminalStore.getState().sessions;
        const referencedTerminalId = useWorkspaceViewStore.getState().activeTerminalId;
        const terminalId = sessions.some((session) => session.id === referencedTerminalId)
          ? referencedTerminalId
          : (sessions[0]?.id ?? null);
        if (mode === "agent" && terminalId) {
          showTerminal(terminalId);
        } else {
          const project = activeProject;
          const worktreePath = project
            ? normalizeWorkspacePath(selectedWorktreePathByProject[project.id], project.path)
            : null;
          beginDraft({
            projectId: project?.id ?? null,
            previousActiveProjectId: project?.id ?? null,
            worktreePath,
          });
          // beginDraft shows the agent view; a preview on screen stays there.
          if (mode === "preview" && previewPath) showPreview();
          else showAgent();
        }
      }
    } catch (err) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Close tab failed",
        description: err instanceof Error ? err.message : "The active tab could not be changed.",
      });
    } finally {
      closingTabIdsRef.current.delete(id);
    }
  };

  const handleNewThread = () => {
    setIsDropdownOpen(false);
    const currentDraft = useWorkspaceViewStore.getState().draft;
    if (currentDraft?.dirty) {
      const ok = confirmDiscardDraft();
      if (!ok) return;
    } else if (currentDraft) {
      showAgent();
      return;
    }
    const project = activeProject;
    const worktreePath = project
      ? normalizeWorkspacePath(selectedWorktreePathByProject[project.id], project.path)
      : null;
    beginDraft({
      projectId: project?.id ?? null,
      previousActiveProjectId: project?.id ?? null,
      worktreePath,
    });
    showAgent();
  };

  const handleSelectTerminal = (id: string) => {
    showTerminal(id);
  };

  const handleNewTerminal = () => {
    setIsDropdownOpen(false);
    const project = useProjectStore.getState().activeProject;
    const workspace = resolveTerminalWorkspace({
      preferThread:
        useUiModeStore.getState().mode === "basic" && !useWorkspaceViewStore.getState().draft,
      thread: useAgentStore.getState().snapshot,
      project,
      selectedPath: project
        ? useWorktreeStore.getState().selectedWorktreePathByProject[project.id]
        : null,
    });
    const terminals = useTerminalStore.getState();
    if (workspace) {
      terminals.setWorkspace(makeWorkspaceKey(workspace.projectId, workspace.cwd), workspace.cwd);
    }
    const id = useTerminalStore.getState().createSession(workspace?.cwd);
    showTerminal(id);
  };

  /** After closing the visible terminal or preview: the agent thread, or a draft when none is open. */
  const showAgentOrDraft = () => {
    const hasOpenThreads = orderedOpenThreads.length > 0;
    const targetThreadId = snapshotThreadId ?? activeThreadId ?? orderedOpenThreads[0]?.id;
    if (hasOpenThreads && targetThreadId) {
      showAgent();
      return;
    }
    const project = activeProject;
    const worktreePath = project
      ? normalizeWorkspacePath(selectedWorktreePathByProject[project.id], project.path)
      : null;
    beginDraft({
      projectId: project?.id ?? null,
      previousActiveProjectId: project?.id ?? null,
      worktreePath,
    });
    showAgent();
  };

  const handleCloseTerminal = (id: string) => {
    const wasViewTerminal = mode === "terminal";
    const wasReferencedTerminal = activeTerminalId === id;
    const next = closeSession(id);
    if (!wasReferencedTerminal) return;
    if (wasViewTerminal) {
      if (next) showTerminal(next);
      else showAgentOrDraft();
    } else {
      setViewActiveTerminalId(next);
    }
  };

  const handleClosePreview = () => {
    if (previewKey) closePreview(previewKey);
    if (useWorkspaceViewStore.getState().mode === "preview") showAgentOrDraft();
  };

  // A preview tab belongs to one workspace. Switching to a workspace without
  // one (or closing it elsewhere) must not leave the view on an empty preview.
  useEffect(() => {
    if (mode === "preview" && !previewPath) showAgent();
  }, [mode, previewPath, showAgent]);

  // Draft is tab-less: use a sentinel that matches no TabItem so nothing highlights.
  const selectedThreadId = optimisticRequestedThreadId ?? snapshotThreadId ?? activeThreadId ?? "";
  const selectedTabValue =
    mode === "preview" && previewPath
      ? PREVIEW_TAB_VALUE
      : mode === "terminal" && activeTerminalId
        ? `${TERMINAL_TAB_PREFIX}${activeTerminalId}`
        : draft
          ? "__draft__"
          : selectedThreadId;

  const orderedTabValues = useMemo(
    () => [
      ...tabValuesInBarOrder(
        visibleOpenThreads.map((thread) => thread.id),
        visibleTerminalTabs.map((session) => session.id),
        TERMINAL_TAB_PREFIX,
      ),
      ...(previewPath ? [PREVIEW_TAB_VALUE] : []),
    ],
    [visibleOpenThreads, visibleTerminalTabs, previewPath],
  );

  const handleTabChangeRef = useRef<(value: string) => void>(() => {});
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;
  const handleNewTerminalRef = useRef(handleNewTerminal);
  handleNewTerminalRef.current = handleNewTerminal;

  const handleTabChange = (value: string) => {
    const clickStartedAt = performance.now();
    beginRendererInteraction("tab-click");
    if (value.startsWith(TERMINAL_TAB_PREFIX)) {
      handleSelectTerminal(value.slice(TERMINAL_TAB_PREFIX.length));
      return;
    }
    if (value === PREVIEW_TAB_VALUE) {
      showPreview();
      return;
    }
    const highlightPaint = new Promise<number>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve(performance.now() - clickStartedAt));
      });
    });
    void handleSelectThread(value)
      .then(async () => {
        const clickToSwitchResolvedMs = performance.now() - clickStartedAt;
        // The selected tab changes optimistically, before the main-process
        // activation promise settles. Start its double-rAF clock at click time
        // so a background snapshot reconciliation is not misreported as paint.
        const clickToHighlightPaintMs = await highlightPaint;
        void window.omni.monitor?.reportTabClickTiming({
          timestamp: Date.now(),
          threadId: value,
          clickToHighlightPaintMs,
          clickToSwitchResolvedMs,
          switchDurationMs: null,
          phase: null,
          success: true,
        });
      })
      .catch((err) => {
        void window.omni.monitor?.reportTabClickTiming({
          timestamp: Date.now(),
          threadId: value,
          clickToHighlightPaintMs: performance.now() - clickStartedAt,
          clickToSwitchResolvedMs: performance.now() - clickStartedAt,
          switchDurationMs: null,
          phase: null,
          success: false,
        });
        toast({
          icon: <WarningIcon className="size-5 text-red-500" />,
          title: "Thread switch failed",
          description: err instanceof Error ? err.message : "The thread could not be opened.",
        });
      });
  };
  handleTabChangeRef.current = handleTabChange;

  const swipeNavigationRef = useRef({ orderedTabValues, selectedTabValue });
  swipeNavigationRef.current = { orderedTabValues, selectedTabValue };

  useEffect(() => {
    return listenForPageSwipes({
      readFluidSwipeEnabled: () =>
        window.omni.tabs.isFluidPageSwipeEnabled?.() ?? Promise.resolve(false),
      subscribeToNativeSwipe: (callback) => window.omni.tabs.onSwipe?.(callback),
      isEnabled: () => useTabGestureStore.getState().swipeEnabled,
      navigate: (direction) => {
        const { orderedTabValues, selectedTabValue } = swipeNavigationRef.current;
        const value = tabValueAfterSwipe(orderedTabValues, selectedTabValue, direction);
        if (value) handleTabChangeRef.current(value);
      },
    });
  }, []);

  const handleCloseActiveTab = () => {
    const currentMode = useWorkspaceViewStore.getState().mode;
    const currentDraft = useWorkspaceViewStore.getState().draft;
    const curTerminalId = useWorkspaceViewStore.getState().activeTerminalId;
    const curThreadId = optimisticRequestedThreadId ?? snapshotThreadId ?? activeThreadId;

    switch (
      activeTabToClose({
        mode: currentMode,
        terminalId: curTerminalId,
        hasDraft: currentDraft !== null,
        threadId: curThreadId,
      })
    ) {
      case "preview":
        handleClosePreview();
        return;
      case "terminal":
        if (curTerminalId) handleCloseTerminal(curTerminalId);
        return;
      case "draft":
        if (currentDraft?.dirty && !confirmDiscardDraft()) return;
        endDraft();
        return;
      case "thread":
        if (curThreadId) void handleCloseThreadTab(curThreadId);
        return;
    }
  };

  const handleCloseActiveTabRef = useRef(handleCloseActiveTab);
  handleCloseActiveTabRef.current = handleCloseActiveTab;

  useEffect(() => {
    const activateTabAtIndex = (index: number) => {
      const value = tabValueAtShortcutIndex(orderedTabValues, index);
      if (!value) return;
      handleTabChangeRef.current(value);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isNewTerminalShortcutEvent(event)) {
        event.preventDefault();
        handleNewTerminalRef.current();
        return;
      }
      if (isNewTabShortcutEvent(event)) {
        event.preventDefault();
        handleNewThreadRef.current();
        return;
      }
      if (isCloseTabShortcutEvent(event)) {
        event.preventDefault();
        handleCloseActiveTabRef.current();
        return;
      }
      const index = tabIndexFromShortcutEvent(event);
      if (index == null) return;
      if (!tabValueAtShortcutIndex(orderedTabValues, index)) return;
      event.preventDefault();
      activateTabAtIndex(index);
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribeSelect = window.omni.tabs.onSelectByIndex?.(activateTabAtIndex);
    const unsubscribeNewTab = window.omni.tabs.onNewTab?.(() => handleNewThreadRef.current());
    const unsubscribeNewTerminal = window.omni.tabs.onNewTerminal?.(() =>
      handleNewTerminalRef.current(),
    );
    const unsubscribeCloseActive = window.omni.tabs.onCloseActive?.(() =>
      handleCloseActiveTabRef.current(),
    );
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribeSelect?.();
      unsubscribeNewTab?.();
      unsubscribeNewTerminal?.();
      unsubscribeCloseActive?.();
    };
  }, [orderedTabValues]);

  return (
    <Tabs className="w-full min-w-0" value={selectedTabValue} onValueChange={handleTabChange}>
      <div
        className="flex w-full max-w-[1000px] min-w-0 items-center gap-1"
        data-pipper-id="global-tab-bar"
      >
        <TabsList
          data-pipper-id="global-tabs"
          className="min-w-0 max-w-full flex-[0_1_auto] gap-1 overflow-x-auto p-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40"
        >
          {visibleOpenThreads.map((thread, idx) => {
            const project = projectsList.find((item) => item.id === thread.project_id);
            const isThreadWorking = runningThreadIds.includes(thread.id);
            const Icon = isThreadWorking
              ? TabWorkingIcon
              : project
                ? getProjectIconComponent(project.icon)
                : undefined;
            const isEditing = editingThreadId === thread.id;
            const tabTitle = thread.title ?? "New thread";
            return (
              <TabItem
                key={thread.id}
                index={idx}
                value={thread.id}
                label={tabTitle}
                scrollLabelOnHover
                icon={Icon}
                onClose={() => handleCloseThreadTab(thread.id)}
                editing={isEditing}
                editValue={isEditing ? editingThreadTitle : tabTitle}
                onEditValueChange={setEditingThreadTitle}
                onEditCommit={commitRenameThread}
                onEditCancel={cancelRenameThread}
                onDoubleClick={() => startRenameThread(thread.id, tabTitle)}
                data-pipper-id={`thread-tab-${thread.id}`}
              />
            );
          })}
          {visibleTerminalTabs.map((session, idx) => (
            <TabItem
              key={session.id}
              index={visibleOpenThreads.length + idx}
              value={`${TERMINAL_TAB_PREFIX}${session.id}`}
              label={session.title}
              scrollLabelOnHover
              icon={
                session.status === "exited" || session.status === "error"
                  ? WarningIcon
                  : TerminalWindowIcon
              }
              onClose={() => handleCloseTerminal(session.id)}
              title={
                session.status === "exited"
                  ? "Terminal process exited"
                  : session.status === "error"
                    ? "Terminal failed to start"
                    : undefined
              }
              className={
                session.status === "exited" || session.status === "error"
                  ? "[&_svg]:!text-red-500"
                  : undefined
              }
              data-pipper-id={`terminal-tab-${session.id}`}
            />
          ))}
          {previewPath && (
            <TabItem
              key={PREVIEW_TAB_VALUE}
              index={visibleOpenThreads.length + visibleTerminalTabs.length}
              value={PREVIEW_TAB_VALUE}
              label={previewPath.slice(previewPath.lastIndexOf("/") + 1)}
              scrollLabelOnHover
              icon={previewTabIcon(previewPath)}
              onClose={handleClosePreview}
              title={previewPath}
              data-pipper-id="preview-tab"
            />
          )}
        </TabsList>

        <div className="relative shrink-0" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <Button
            data-pipper-id="add-tab-button"
            ref={buttonRef}
            variant="ghost"
            size="icon-sm"
            active={isDropdownOpen}
            aria-label="Add tab"
            onClick={() => setIsDropdownOpen((prev) => !prev)}
          >
            <PlusIcon size={16} />
          </Button>

          {isDropdownOpen &&
            dropdownPosition &&
            createPortal(
              <div
                data-pipper-id="add-tab-dropdown"
                data-placement={dropdownPosition.placement}
                ref={dropdownRef}
                className="fixed z-[250]"
                style={
                  {
                    left: dropdownPosition.left,
                    top: dropdownPosition.top,
                    bottom: dropdownPosition.bottom,
                    width: dropdownPosition.width,
                    maxHeight: dropdownPosition.maxHeight,
                    WebkitAppRegion: "no-drag",
                  } as CSSProperties
                }
              >
                <Dropdown className="w-full" style={{ maxHeight: dropdownPosition.maxHeight }}>
                  <MenuItem
                    index={0}
                    label="New terminal"
                    icon={TerminalWindowIcon}
                    onSelect={handleNewTerminal}
                  />
                  <MenuItem
                    index={1}
                    label="New thread"
                    icon={ChatCircleIcon}
                    onSelect={handleNewThread}
                  />
                  <DropdownSeparator />
                  <MenuItem
                    index={2}
                    label="New project"
                    icon={FolderPlusIcon}
                    onSelect={async () => {
                      setIsDropdownOpen(false);
                      await window.omni.launch.show("add");
                    }}
                  />
                </Dropdown>
              </div>,
              document.body,
            )}
        </div>
      </div>
    </Tabs>
  );
}
