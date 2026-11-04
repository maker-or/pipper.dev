import { create } from "zustand";
import type { Thread } from "../../contracts/threads.ts";

interface WorktreeState {
  /**
   * Active workspace target by project. The project root is stored as its
   * path. This is a MIRROR of the persisted canonical selection in launch
   * state — the main process is the single writer (it reconciles on every
   * thread activation); the renderer re-reads via `syncSelections` and only
   * sets it optimistically on explicit switches.
   */
  selectedWorktreePathByProject: Record<string, string>;
  hasHydratedSelections: boolean;
  /** Re-read the persisted per-project selections (boot + after activations). */
  syncSelections: () => Promise<void>;
  /** Make `path` the project's workspace; resolves the thread main restored there. */
  switchWorktree: (projectId: string, path: string) => Promise<Thread | null>;
}

// Drops stale syncSelections responses: only the latest request may apply.
let selectionsSyncToken = 0;

export const useWorktreeStore = create<WorktreeState>((set, get) => ({
  selectedWorktreePathByProject: {},
  hasHydratedSelections: false,
  syncSelections: async () => {
    const token = ++selectionsSyncToken;
    try {
      const persisted = await window.omni.worktrees.getSelections();
      if (token !== selectionsSyncToken) return;
      // Persisted state is authoritative — the main process reconciled it on
      // the activation that triggered this sync.
      set({
        selectedWorktreePathByProject: persisted,
        hasHydratedSelections: true,
      });
    } catch {
      if (token === selectionsSyncToken) set({ hasHydratedSelections: true });
    }
  },
  switchWorktree: async (projectId, path) => {
    try {
      const thread = await window.omni.worktrees.switch({ projectId, path });
      set((state) => ({
        selectedWorktreePathByProject: {
          ...state.selectedWorktreePathByProject,
          [projectId]: path,
        },
      }));
      // The main process persisted the canonical selection during the
      // switch; re-read it so the mirror is exact (root realpath etc.).
      void get().syncSelections();
      return thread;
    } catch {
      return null;
    }
  },
}));
