import { create } from "zustand";
import { useAgentStore } from "@/store/agent-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/**
 * Background threads whose agent run finished while the user was looking at
 * a different thread, oldest completion first.
 *
 * The shell surfaces the head of this queue in a persistent dock and
 * announces each arrival with a toast. An entry leaves the queue the moment
 * the user views that thread — by the dock arrow, the toast button, or an
 * ordinary tab click — so the queue never asks for a second acknowledgement.
 */
interface ThreadCompletionState {
  queue: string[];
  /** Threads whose next departure from the running set is user-initiated
   *  (tab closed, thread deleted) rather than a completion worth announcing. */
  suppressed: string[];
  enqueue: (threadId: string) => void;
  acknowledge: (threadId: string) => void;
  /** Forget a thread the user is closing or deleting, now and when it stops. */
  dismissThread: (threadId: string) => void;
  clear: () => void;
}

export const useThreadCompletionStore = create<ThreadCompletionState>((set) => ({
  queue: [],
  suppressed: [],
  enqueue: (threadId) =>
    set((state) =>
      state.queue.includes(threadId) ? state : { queue: [...state.queue, threadId] },
    ),
  acknowledge: (threadId) =>
    set((state) =>
      state.queue.includes(threadId)
        ? { queue: state.queue.filter((id) => id !== threadId) }
        : state,
    ),
  dismissThread: (threadId) =>
    set((state) => ({
      queue: state.queue.filter((id) => id !== threadId),
      suppressed: state.suppressed.includes(threadId)
        ? state.suppressed
        : [...state.suppressed, threadId],
    })),
  clear: () => set({ queue: [], suppressed: [] }),
}));

/**
 * Threads that left the running set between two observations, excluding the
 * thread the user is looking at (or switching to): that completion is already
 * visible on screen and would only be noise.
 */
export function completedBackgroundThreads(
  previous: readonly string[],
  next: readonly string[],
  viewedThreadIds: ReadonlyArray<string | null | undefined>,
): string[] {
  const running = new Set(next);
  const viewed = new Set(viewedThreadIds.filter((id): id is string => Boolean(id)));
  return previous.filter((id) => !running.has(id) && !viewed.has(id));
}

/**
 * Feed the queue from the agent store's running-thread set and drain it as
 * the user views queued threads. Returns an unsubscribe function; the
 * shell keeps exactly one watcher alive while mounted.
 */
export function startThreadCompletionWatcher(onCompleted?: (threadId: string) => void): () => void {
  let previousRunning = useAgentStore.getState().runningThreadIds;
  let previousViewed = useAgentStore.getState().snapshot?.threadId ?? null;

  return useAgentStore.subscribe((state) => {
    const completion = useThreadCompletionStore.getState();

    if (state.runningThreadIds !== previousRunning) {
      const previous = previousRunning;
      previousRunning = state.runningThreadIds;

      // A thread that starts (again) has outlived any pending close/delete
      // suppression, so its eventual finish must be announced normally.
      const started = state.runningThreadIds.filter((id) => !previous.includes(id));
      if (started.some((id) => completion.suppressed.includes(id))) {
        useThreadCompletionStore.setState((current) => ({
          suppressed: current.suppressed.filter((id) => !started.includes(id)),
        }));
      }

      const viewed = [
        state.snapshot?.threadId,
        state.pendingThreadTarget,
        useWorkspaceViewStore.getState().requestedThreadId,
      ];
      for (const threadId of completedBackgroundThreads(previous, state.runningThreadIds, viewed)) {
        const { suppressed } = useThreadCompletionStore.getState();
        if (suppressed.includes(threadId)) {
          useThreadCompletionStore.setState({
            suppressed: suppressed.filter((id) => id !== threadId),
          });
          continue;
        }
        useThreadCompletionStore.getState().enqueue(threadId);
        onCompleted?.(threadId);
      }
    }

    const viewedNow = state.snapshot?.threadId ?? null;
    if (viewedNow !== previousViewed) {
      previousViewed = viewedNow;
      if (viewedNow) useThreadCompletionStore.getState().acknowledge(viewedNow);
    }
  });
}
