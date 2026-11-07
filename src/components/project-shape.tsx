import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";
import {
  PROJECT_SHAPES,
  projectShape,
  type Project,
  type ProjectShapeId,
} from "../../contracts/projects.ts";
import { projectShapePath, projectShapeLabel } from "@/lib/project-shapes";
import { useSurface } from "@/lib/surface-context";
import { HEADER_TONE_FILL, type HeaderTone } from "@/lib/workspace-tone";
import { cn } from "@/lib/utils";

/** A flat shape in the current colour, for tabs and chips. */
export function ShapeGlyph({
  shape,
  className,
  style,
}: {
  shape: ProjectShapeId;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={style}
      data-project-shape={shape}
    >
      <path d={projectShapePath(shape)} />
    </svg>
  );
}

/** How far a resting shape stands above the surface it sits on: low, so
 *  inactive projects stay quiet next to the selected one. */
const SHAPE_ELEVATION = 2;

/**
 * A project shape, standing on whatever surface holds it. At rest (no
 * `tone`) it is that surface raised by SHAPE_ELEVATION, edged with the
 * theme's shadow ring and drop, like an Elevated card cut to the shape. With
 * a `tone` it is painted in that git state's fill, lit from the top left;
 * `neutral` is the bright fill an active project shows before its thread does.
 */
export function ShapeIcon({
  shape,
  tone = null,
  className,
}: {
  shape: ProjectShapeId;
  tone?: HeaderTone | null;
  className?: string;
}) {
  const gradientId = `shape-gloss-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const level = Math.min(useSurface() + SHAPE_ELEVATION, 8);
  const toned = tone !== null;
  const fill = toned ? HEADER_TONE_FILL[tone] : `var(--shape-fill, var(--surface-${level}))`;
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      className={cn("overflow-visible", className)}
      style={
        {
          ...(toned ? { "--shape-fill": fill } : {}),
          filter:
            "drop-shadow(0 1px 1px var(--dm-drop, var(--shadow-color))) drop-shadow(0 3px 3px var(--dm-drop, var(--shadow-color)))",
        } as CSSProperties
      }
      data-project-shape={shape}
    >
      {toned ? (
        <defs>
          <radialGradient id={gradientId} cx="38%" cy="30%" r="75%">
            <stop
              offset="0%"
              style={{ stopColor: "color-mix(in srgb, var(--shape-fill) 72%, white)" }}
            />
            <stop offset="55%" style={{ stopColor: "var(--shape-fill)" }} />
            <stop
              offset="100%"
              style={{ stopColor: "color-mix(in srgb, var(--shape-fill) 82%, black)" }}
            />
          </radialGradient>
        </defs>
      ) : null}
      <path
        d={projectShapePath(shape)}
        fill={toned ? `url(#${gradientId})` : fill}
        // The stroke sits under the fill, so only a 1px ring shows outside it.
        stroke="var(--dm-ring-high, var(--shadow-color))"
        strokeWidth={2}
        strokeLinejoin="round"
        paintOrder="stroke"
        vectorEffect="non-scaling-stroke"
        className="transition-[fill] duration-160"
      />
    </svg>
  );
}

/** A project's shape, coloured by its workspace's git state. */
export function ProjectShapeIcon({
  project,
  ...props
}: {
  project: Pick<Project, "id" | "icon">;
  tone?: HeaderTone | null;
  className?: string;
}) {
  return <ShapeIcon shape={projectShape(project)} {...props} />;
}

/** A small, flat project mark in the current colour, for tabs and chips. */
export function ProjectMark({
  project,
  className,
}: {
  project: Pick<Project, "id" | "icon">;
  className?: string;
}) {
  return <ShapeGlyph shape={projectShape(project)} className={className} />;
}

/** The shape choice when creating a project: one tile per shape. */
export function ShapePicker({
  value,
  onValueChange,
  disabled = false,
  className,
}: {
  value: ProjectShapeId | undefined;
  onValueChange: (value: ProjectShapeId) => void;
  disabled?: boolean;
  className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // Roving focus: the chosen tile (or the first) is the one tab stop.
  const focusIndex = Math.max(0, value ? PROJECT_SHAPES.indexOf(value) : 0);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = buttons.current.findIndex((button) => button === document.activeElement);
    const next = (Math.max(0, current) + step + PROJECT_SHAPES.length) % PROJECT_SHAPES.length;
    onValueChange(PROJECT_SHAPES[next]);
    buttons.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Shape"
      onKeyDown={onKeyDown}
      className={cn("grid grid-cols-9 gap-2 p-0.5", className)}
    >
      {PROJECT_SHAPES.map((shape, index) => {
        const selected = shape === value;
        return (
          <button
            key={shape}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={projectShapeLabel(shape)}
            title={projectShapeLabel(shape)}
            tabIndex={index === focusIndex ? 0 : -1}
            disabled={disabled}
            onClick={() => onValueChange(shape)}
            className={cn(
              "group grid aspect-square place-items-center rounded-xl outline-none",
              "transition-colors duration-80 focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-50",
              selected ? "bg-accent ring-1 ring-border" : "hover:bg-hover",
            )}
          >
            <ShapeIcon
              shape={shape}
              className={cn(
                "size-3/5",
                !selected && "group-hover:[--shape-fill:var(--foreground)]",
                selected && "[&>path]:!fill-white [&>path]:!stroke-white",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
