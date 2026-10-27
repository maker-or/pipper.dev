import { create } from "zustand";
import { useDiffStore } from "@/store/diff-store";
import type { DraftState } from "../../contracts/composer.ts";

/**
 * Which primary ("global") view fills the workspace area.
 *
 * - `agent` — the active agent thread's conversation (owned by the agent
 *   store / open-tabs machinery). When the thread has diffs open it renders
 *   as a 40:60 conversation | diff split; otherwise it fills 100% width.
 * - `terminal` — a single terminal session, filling 100% width.
 * - `preview` — the active workspace's file preview tab (see preview-store),
 *   filling 100% width.
 *
 * Agent threads and terminals share one tab strip in the header. Only the
 * mode + which terminal is active live here; the active *thread* identity
 * stays owned by `useAgentStore`/open-tabs so its optimistic-switch logic is
 * unchanged.
 *
 * A **draft** is a pre-thread composer state: no open-tab row, no session.
 * Chrome (title-bar project name, file tree, etc.) must read draft.projectId
 * rather than ambient activeProject while a draft is active.
 */
export type WorkspaceMode = "agent" | "terminal" | "preview";

export type BeginDraftOptions = {
  /** Soft-default project chip from ambient active project. */
  projectId?: string | null;
  previousActiveProjectId?: string | null;
  worktreePath?: string | null;
};

interface WorkspaceViewState {
  mode: WorkspaceMode;
  activeTerminalId: string | null;
  /**
   * Optimistic switch target while `switchThread` is in flight. The header
   * sets it the instant a tab is clicked so the conversation can show a
   * switching veil before the agent snapshot catches up; the header clears
   * it once `snapshot.threadId` matches (or the switch errors).
   */
  requestedThreadId: string | null;
  /**
   * Pre-create thread composer. Null when viewing a live thread or nothing.
   * Mutually exclusive with a selected tab highlight in the tab strip.
   */
  draft: DraftState | null;
  /**
   * Thread created from the most recent draft. The global tab bar consumes
   * this one-shot handoff so a stale agent snapshot cannot reopen the prior
   * thread when the draft disappears.
   */
  draftCompletionThreadId: string | null;
  showAgent: () => void;
  showTerminal: (sessionId: string) => void;
  showPreview: () => void;
  setActiveTerminalId: (sessionId: string | null) => void;
  requestThread: (threadId: string | null) => void;
  beginDraft: (options?: BeginDraftOptions) => void;
  endDraft: () => void;
  completeDraft: (threadId: string) => void;
  clearDraftCompletion: () => void;
  setDraftProject: (projectId: string | null, worktreePath?: string | null) => void;
  setDraftAgent: (agentId: string | null) => void;
  setDraftModel: (modelId: string | null) => void;
  setDraftWorktree: (worktreePath: string | null) => void;
  setDraftDirty: (dirty: boolean) => void;
  markDraftUserEditedProject: () => void;
}

export const useWorkspaceViewStore = create<WorkspaceViewState>((set, get) => ({
  mode: "agent",
  activeTerminalId: null,
  requestedThreadId: null,
  draft: null,
  draftCompletionThreadId: null,

  showAgent: () => set({ mode: "agent" }),
  showTerminal: (sessionId) => set({ mode: "terminal", activeTerminalId: sessionId }),
  showPreview: () => set({ mode: "preview" }),
  setActiveTerminalId: (sessionId) => set({ activeTerminalId: sessionId }),
  requestThread: (threadId) => set({ requestedThreadId: threadId }),

  beginDraft: (options = {}) => {
    const projectId = options.projectId ?? null;
    set({
      mode: "agent",
      requestedThreadId: null,
      draftCompletionThreadId: null,
      draft: {
        projectId,
        agentId: null,
        modelId: null,
        worktreePath: options.worktreePath ?? null,
        dirty: false,
        previousActiveProjectId: options.previousActiveProjectId ?? null,
        softDefaultProject: Boolean(projectId),
      },
    });
  },

  endDraft: () => set({ draft: null, draftCompletionThreadId: null }),

  completeDraft: (threadId) => set({ draft: null, draftCompletionThreadId: threadId }),
  clearDraftCompletion: () => set({ draftCompletionThreadId: null }),

  setDraftProject: (projectId, worktreePath) => {
    const draft = get().draft;
    if (!draft) return;
    const projectChanged = projectId !== draft.projectId;
    set({
      draft: {
        ...draft,
        projectId,
        // When the project changes and no explicit worktree is supplied, drop
        // the previous project's path so send re-resolves for the new project.
        worktreePath:
          worktreePath !== undefined ? worktreePath : projectChanged ? null : draft.worktreePath,
        // Clearing the project means chrome should unbind; keep soft flag only
        // while the auto chip is still the bound project.
        softDefaultProject: projectId != null && draft.softDefaultProject && !projectChanged,
        dirty: draft.dirty || projectChanged,
      },
    });
  },

  setDraftAgent: (agentId) => {
    const draft = get().draft;
    if (!draft) return;
    set({
      draft: {
        ...draft,
        agentId,
        dirty: draft.dirty || agentId !== draft.agentId,
      },
    });
  },

  setDraftModel: (modelId) => {
    const draft = get().draft;
    if (!draft) return;
    set({
      draft: {
        ...draft,
        modelId,
        dirty: draft.dirty || modelId !== draft.modelId,
      },
    });
  },

  setDraftWorktree: (worktreePath) => {
    const draft = get().draft;
    if (!draft) return;
    set({
      draft: {
        ...draft,
        worktreePath,
        dirty: true,
      },
    });
  },

  setDraftDirty: (dirty) => {
    const draft = get().draft;
    if (!draft) return;
    set({ draft: { ...draft, dirty } });
  },

  markDraftUserEditedProject: () => {
    const draft = get().draft;
    if (!draft) return;
    set({ draft: { ...draft, softDefaultProject: false, dirty: true } });
  },
}));

/**
 * Whether the workspace is rendering the 40:60 conversation | diff split.
 * The shell uses it to lay out the panels; the agent view uses it to decide
 * between its centered reading column (full-width global view) and the panel's
 * full width (already narrow inside the split). Draft has no thread → no split.
 */
export function useIsDiffSplit(): boolean {
  const mode = useWorkspaceViewStore((state) => state.mode);
  const draft = useWorkspaceViewStore((state) => state.draft);
  const isDiffOpen = useDiffStore((state) => state.isOpen);
  const diffFileCount = useDiffStore((state) => state.order.length);
  if (draft) return false;
  return mode === "agent" && isDiffOpen && diffFileCount > 0;
}

/**
 * Project id that owns the current agent chrome (title bar, file tree).
 * Draft with no project → null (do not fall back to ambient activeProject).
 * Live agent mode → null here; callers should use snapshot/activeProject.
 */
export function selectDraftContextProjectId(draft: DraftState | null | undefined): string | null {
  if (!draft) return null;
  return draft.projectId;
}
