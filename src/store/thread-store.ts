import { create } from "zustand";
import type { Thread } from "../../contracts/threads.ts";
import { useContinuationStore } from "@/store/continuation-store";
import { useThreadCompletionStore } from "@/store/thread-completion-store";

const THREAD_PAGE_SIZE = 10;

interface ProjectThreadPageState {
  nextOffset: number;
  hasMore: boolean;
  isLoading: boolean;
}

interface ThreadState {
  threads: Thread[];
  pagesByProject: Record<string, ProjectThreadPageState>;
  isLoading: boolean;
  error: string | null;
  loadThreads: () => Promise<void>;
  loadProjectThreads: (projectId: string, options?: { reset?: boolean }) => Promise<void>;
  renameThread: (id: string, title: string) => Promise<Thread | null>;
  deleteThread: (id: string) => Promise<void>;
  /** Drop a thread already deleted in main (by an agent, or with its workspace). */
  forgetThread: (id: string) => void;
  addThread: (thread: Thread) => void;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  pagesByProject: {},
  isLoading: false,
  error: null,
  loadThreads: async () => {
    set({ isLoading: true, error: null });
    try {
      const list = await window.omni.threads.list();
      set({ threads: list, isLoading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to load threads",
        isLoading: false,
      });
    }
  },
  loadProjectThreads: async (projectId, options) => {
    const reset = options?.reset ?? false;
    let offset = 0;
    let shouldLoad = true;
    let hasMoreAfterError = false;

    set((state) => {
      const current = state.pagesByProject[projectId];
      offset = reset ? 0 : (current?.nextOffset ?? 0);
      shouldLoad = reset || current == null || current.hasMore;
      hasMoreAfterError = current?.hasMore ?? false;

      if (!shouldLoad || current?.isLoading) {
        shouldLoad = false;
        return {};
      }

      return {
        error: null,
        pagesByProject: {
          ...state.pagesByProject,
          [projectId]: {
            nextOffset: offset,
            hasMore: current?.hasMore ?? true,
            isLoading: true,
          },
        },
      };
    });

    if (!shouldLoad) return;

    try {
      const page = await window.omni.threads.listProject({
        projectId,
        limit: THREAD_PAGE_SIZE,
        offset,
      });

      set((state) => {
        const pageThreads = page.threads as Thread[];
        const remainingThreads = reset
          ? state.threads.filter((thread) => thread.project_id !== projectId)
          : state.threads.filter((thread) => !pageThreads.some((item) => item.id === thread.id));
        return {
          threads: [...remainingThreads, ...pageThreads],
          pagesByProject: {
            ...state.pagesByProject,
            [projectId]: {
              nextOffset: page.nextOffset,
              hasMore: page.hasMore,
              isLoading: false,
            },
          },
        };
      });
    } catch (err) {
      set((state) => {
        return {
          error: err instanceof Error ? err.message : "Failed to load threads",
          pagesByProject: {
            ...state.pagesByProject,
            [projectId]: {
              nextOffset: offset,
              hasMore: hasMoreAfterError,
              isLoading: false,
            },
          },
        };
      });
    }
  },
  // Thread creation goes through the agent store's `createThread`, which
  // binds the new thread to the current workspace; a store-local create here
  // would silently bind to the project root.
  renameThread: async (id, title) => {
    try {
      const thread = await window.omni.threads.rename(id, title);
      set((state) => ({
        threads: state.threads.map((item) => (item.id === id ? thread : item)),
        error: null,
      }));
      return thread;
    } catch (err) {
      console.error("Failed to rename thread:", err);
      set({
        error: err instanceof Error ? err.message : "Failed to rename thread",
      });
      return null;
    }
  },
  deleteThread: async (id) => {
    try {
      await window.omni.threads.delete(id);
      get().forgetThread(id);
      set({ error: null });
    } catch (err) {
      console.error("Failed to delete thread:", err);
      set({
        error: err instanceof Error ? err.message : "Failed to delete thread",
      });
      throw err;
    }
  },
  forgetThread: (id) => {
    // Drop any unsent `/continue` transcript staged for this thread.
    useContinuationStore.getState().clearPending(id);
    useThreadCompletionStore.getState().dismissThread(id);
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== id),
      // A local mutation did not advance the server-backed pagination
      // cursor, so deleting it must not move that cursor backwards either.
      pagesByProject: state.pagesByProject,
    }));
  },
  addThread: (thread) => {
    set((state) => {
      return {
        threads: [thread, ...state.threads.filter((item) => item.id !== thread.id)],
        pagesByProject: state.pagesByProject,
      };
    });
  },
}));
