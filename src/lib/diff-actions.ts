import { useMemo } from "react";
import { useAgentStore } from "@/store/agent-store";
import { useDiffStore } from "@/store/diff-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

/**
 * Open the active thread's changes in their own tab, brought to the front
 * like a file preview.
 */
export function openDiffView(): void {
  useDiffStore.getState().open();
  useWorkspaceViewStore.getState().showDiff();
}

/**
 * Whether the shell shows a changes tab now: a thread on screen and changes
 * open. Files load only once changes are open, so this can't wait for
 * them; the tab says "No file changes yet" until they arrive.
 */
export function useDiffTabShown(): boolean {
  const hasDraft = useWorkspaceViewStore((state) => state.draft !== null);
  const isOpen = useDiffStore((state) => state.isOpen);
  return !hasDraft && isOpen;
}

/** Whether the displayed thread has edited any file, before its diffs are loaded. */
export function useThreadHasEdits(): boolean {
  const toolCalls = useAgentStore((state) => state.slice.toolCalls);
  const fileCount = useDiffStore((state) => state.order.length);
  const hasDiffCall = useMemo(
    () => Object.values(toolCalls).some((toolCall) => toolCall.hasDiff),
    [toolCalls],
  );
  return fileCount > 0 || hasDiffCall;
}
