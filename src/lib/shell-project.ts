import { useProjectStore } from "@/store/project-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/**
 * The project the hybrid shell shows as selected: a draft's project while
 * drafting, else the active project.
 *
 * Picking a project during a draft only moves the draft. Activating the
 * project would also open its last thread behind the draft (starting that
 * thread's agent session) before the draft is ever sent. Sending the draft
 * makes its project active, and discarding it returns to the active one.
 */
export function useShellProjectId(): string | null {
  const draftProjectId = useWorkspaceViewStore((state) => state.draft?.projectId ?? null);
  const activeProjectId = useProjectStore((state) => state.activeProject?.id ?? null);
  return draftProjectId ?? activeProjectId;
}
