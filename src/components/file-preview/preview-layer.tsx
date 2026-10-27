import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { useShownPreviewWorkspaceKey } from "@/lib/file-preview-actions";
import { usePreviewStore } from "@/store/preview-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

// Loaded when a file is first opened, keeping the code viewer out of startup.
const FilePreview = lazy(() =>
  import("@/components/file-preview/file-preview").then((m) => ({ default: m.FilePreview })),
);

/**
 * The shown workspace's preview tab, layered over the agent view. It stays
 * mounted (hidden and inert) while another tab is on screen, so switching
 * away and back keeps the scroll position and any half-written comment.
 */
export function PreviewLayer() {
  const workspaceKey = useShownPreviewWorkspaceKey();
  const hasPreview = usePreviewStore((state) =>
    workspaceKey ? Boolean(state.workspaces[workspaceKey]?.path) : false,
  );
  const visible = useWorkspaceViewStore((state) => state.mode === "preview");
  if (!workspaceKey || !hasPreview) return null;
  return (
    <section
      className={cn(
        "absolute inset-0 flex flex-col overflow-hidden bg-surface-1",
        visible ? "z-30 visible" : "-z-10 invisible pointer-events-none",
      )}
      aria-hidden={!visible}
      inert={!visible}
      data-pipper-id="preview-panel"
      data-visible={visible ? "true" : "false"}
    >
      <Suspense fallback={null}>
        <FilePreview workspaceKey={workspaceKey} />
      </Suspense>
    </section>
  );
}
