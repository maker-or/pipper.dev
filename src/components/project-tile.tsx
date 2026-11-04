import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import type { Project } from "../../contracts/projects.ts";
import { ProjectShapeIcon } from "@/components/project-shape";
import type { HeaderTone } from "@/lib/workspace-tone";
import { cn } from "@/lib/utils";

/**
 * A project in the rail: its shape over its name. Shapes rest in the surface
 * colour; the selected project's shape turns bright, then takes the git
 * state's colour once one of its threads is on screen.
 */
export function ProjectTile({
  project,
  selected,
  tone,
  rootRef,
  className,
  children,
  ...buttonProps
}: {
  project: Pick<Project, "id" | "icon" | "name">;
  selected: boolean;
  /** Git-state tone of the displayed workspace (`neutral` with no thread on
   *  screen); used only when selected. */
  tone: HeaderTone;
  /** The tile's outer element, which also holds the overlays. */
  rootRef?: Ref<HTMLDivElement>;
  /** Overlays such as the options menu. */
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<"button">, "children">) {
  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)} data-pipper-id="project-tile">
      <button
        type="button"
        data-active={selected ? "true" : undefined}
        aria-current={selected ? "page" : undefined}
        title={project.name}
        className={cn(
          "flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none",
          "transition-colors duration-80 focus-visible:ring-1 focus-visible:ring-ring",
          selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
        {...buttonProps}
      >
        <ProjectShapeIcon project={project} tone={selected ? tone : null} className="size-12" />
        <span className="w-full truncate text-center text-[11px] font-medium leading-4">
          {project.name}
          {selected && <span className="sr-only"> (active project)</span>}
        </span>
      </button>
      {children}
    </div>
  );
}
