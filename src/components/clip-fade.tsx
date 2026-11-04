import { useSurface } from "@/lib/surface-context";
import { cn } from "@/lib/utils";

/**
 * Fades the bottom of clipped content into the surface it sits on, read from
 * surface context so the fade never shows as a band on a raised surface.
 */
export function ClipFade({ className }: { className?: string }) {
  const surface = `var(--surface-${useSurface()})`;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-8", className)}
      style={{ background: `linear-gradient(to top, ${surface}, transparent)` }}
    />
  );
}
