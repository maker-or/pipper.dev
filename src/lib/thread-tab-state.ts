import type { Thread } from "../../contracts/threads.ts";

/** Every tab of the selected project, across its workspaces. */
export function visibleProjectThreadTabs(
  threads: Thread[],
  projectId: string | null,
  displayedThreadId: string | null,
  requestedThreadId: string | null,
): Thread[] {
  if (!projectId) return [];
  return threads.filter(
    (thread) =>
      thread.project_id === projectId ||
      thread.id === displayedThreadId ||
      thread.id === requestedThreadId,
  );
}
