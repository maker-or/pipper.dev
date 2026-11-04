import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import { surfaceBgClass } from "@/lib/surface-classes";
import { useSurface } from "@/lib/surface-context";
import { useDiffTabShown } from "@/lib/diff-actions";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

// Loaded when changes are first opened, keeping the diff viewer out of startup.
const DiffView = lazy(() =>
  import("@/components/diff-view").then((m) => ({ default: m.DiffView })),
);

/**
 * The active thread's changes tab, layered over the agent view like the file
 * preview. It stays mounted (hidden and inert) while another tab is on
 * screen, so switching away and back keeps the scroll position.
 */
export function DiffLayer() {
  const surface = useSurface();
  const shown = useDiffTabShown();
  const visible = useWorkspaceViewStore((state) => state.mode === "diff");
  if (!shown) return null;
  return (
    <section
      className={cn(
        "absolute inset-0 flex flex-col overflow-hidden p-2",
        surfaceBgClass(surface),
        visible ? "z-30 visible" : "-z-10 invisible pointer-events-none",
      )}
      aria-hidden={!visible}
      inert={!visible}
      data-pipper-id="diff-panel"
      data-visible={visible ? "true" : "false"}
    >
      <div className="min-h-0 flex-1 overflow-hidden rounded-md">
        <Suspense fallback={null}>
          <DiffView />
        </Suspense>
      </div>
    </section>
  );
}
