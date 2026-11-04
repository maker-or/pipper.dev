import { create } from "zustand";

const STORAGE_KEY = "pipper.subthreads.dismissed";

/** Oldest dismissals drop off past this, so the list cannot grow forever. */
const MAX_DISMISSED = 500;

function readDismissed(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface DismissedSubthreadsState {
  /** Task ids of finished subthreads the user closed, oldest first. */
  taskIds: string[];
  dismiss: (taskId: string) => void;
}

/**
 * Finished subthreads the user closed in the session panel. A finished
 * subthread stays listed until closed, so the closing is remembered across
 * restarts; otherwise every past subthread would come back on launch.
 */
export const useDismissedSubthreadsStore = create<DismissedSubthreadsState>((set, get) => ({
  taskIds: readDismissed(),
  dismiss: (taskId) => {
    if (get().taskIds.includes(taskId)) return;
    const taskIds = [...get().taskIds, taskId].slice(-MAX_DISMISSED);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(taskIds));
    } catch {
      // Keep the dismissal for this session when storage is unavailable.
    }
    set({ taskIds });
  },
}));
