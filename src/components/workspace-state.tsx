import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Elevated } from "@/lib/elevated";
import { useSurface } from "@/lib/surface-context";
import { useShape } from "@/lib/shape-context";
import { cn } from "@/lib/utils";
import {
  HEADER_TONE_COLOR,
  HEADER_TONE_FILL,
  HEADER_TONE_INK,
  toneIdentity,
  toneInsetShadow,
  toneFade,
  type HeaderTone,
} from "@/lib/workspace-tone";

/** One semantic role map shared by the shell, its controls, and the gallery. */
export function workspaceStateStyle(tone: HeaderTone): CSSProperties {
  const badge = toneIdentity(tone);
  return {
    "--workspace-state-accent": HEADER_TONE_COLOR[tone],
    "--focus-ring": HEADER_TONE_COLOR[tone],
    "--workspace-state-surface": "var(--surface-1)",
    "--workspace-state-on-surface": "var(--foreground)",
    "--workspace-state-action": HEADER_TONE_FILL[tone],
    "--workspace-state-on-action": HEADER_TONE_INK[tone],
    "--workspace-state-caret": "var(--workspace-caret-color, var(--workspace-state-on-action))",
    "--workspace-state-glow": toneInsetShadow(tone),
    "--workspace-state-glow-background": `var(--workspace-glow-background-${tone}, var(--workspace-state-surface))`,
    "--workspace-state-secondary-fill": `var(--workspace-control-tint-${tone}, color-mix(in srgb, var(--workspace-state-on-surface) 15%, transparent))`,
    "--workspace-state-tag-fill": `var(--workspace-control-tint-${tone}, color-mix(in srgb, var(--workspace-state-on-surface) 30%, transparent))`,
    "--workspace-state-control-ink": `var(--workspace-control-ink-${tone}, var(--workspace-state-on-surface))`,
    "--workspace-state-tag-arrow-fill":
      "color-mix(in srgb, var(--workspace-state-control-ink) var(--workspace-pr-arrow-opacity), transparent)",
    "--workspace-state-badge": badge.bg,
    "--workspace-state-on-badge": badge.ink,
  } as CSSProperties;
}

export interface WorkspaceStateSurfaceProps extends Omit<
  ComponentPropsWithoutRef<typeof Elevated>,
  "offset"
> {
  offset?: number;
  tone: HeaderTone;
  variant?: "card" | "header" | "notice";
  active?: boolean;
}

/** Elevation supplies the substrate; the Git state supplies its wash and glow. */
export const WorkspaceStateSurface = forwardRef<HTMLDivElement, WorkspaceStateSurfaceProps>(
  (
    { tone, variant = "card", active = true, offset = 0, className, style, children, ...props },
    ref,
  ) => {
    const shape = useShape();
    const substrate = useSurface();
    const level = Math.max(1, Math.min(8, substrate + offset));
    return (
      <Elevated
        ref={ref}
        offset={offset}
        data-workspace-state={tone}
        data-state-surface={variant}
        data-state-active={active ? "true" : "false"}
        className={cn("workspace-state-surface relative isolate", shape.container, className)}
        style={
          {
            ...workspaceStateStyle(tone),
            "--workspace-state-surface": `var(--surface-${level})`,
            // A header fades into what follows, so it has no elevation ring
            // to draw an edge (the class alone loses to the surface's ring).
            ...(variant === "header" ? { boxShadow: "none" } : {}),
            ...(variant === "header" && active ? { backgroundImage: toneFade(tone) } : {}),
            ...style,
          } as CSSProperties
        }
        {...props}
      >
        {children}
      </Elevated>
    );
  },
);
WorkspaceStateSurface.displayName = "WorkspaceStateSurface";

export interface WorkspaceStateActionProps extends Omit<ButtonProps, "variant"> {
  tone: HeaderTone;
  appearance?: "primary" | "secondary" | "tag" | "segment";
}

/** State actions retain Button's keyboard, loading, disabled and shape behavior. */
export const WorkspaceStateAction = forwardRef<HTMLButtonElement, WorkspaceStateActionProps>(
  ({ tone, appearance = "primary", size = "sm", className, style, children, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size={size}
      data-workspace-state={tone}
      data-state-action={appearance}
      className={cn("workspace-state-action shrink-0 font-semibold", className)}
      style={{ ...workspaceStateStyle(tone), ...style }}
      {...props}
    >
      {appearance === "tag" ? (
        <span
          className={cn(
            "inline-flex items-center whitespace-nowrap",
            size === "sm" ? "h-6" : size === "lg" ? "h-8" : "h-7",
          )}
        >
          {children}
        </span>
      ) : (
        children
      )}
    </Button>
  ),
);
WorkspaceStateAction.displayName = "WorkspaceStateAction";

export interface WorkspaceStateActionGroupProps extends ComponentPropsWithoutRef<"div"> {
  tone: HeaderTone;
}

/** Split controls paint one fill behind both segments, avoiding a center seam. */
export const WorkspaceStateActionGroup = forwardRef<HTMLDivElement, WorkspaceStateActionGroupProps>(
  ({ tone, className, style, ...props }, ref) => {
    const shape = useShape();
    return (
      <div
        ref={ref}
        data-workspace-state={tone}
        data-state-action-group
        className={cn(
          "workspace-state-action-group flex h-7 overflow-hidden",
          shape.button,
          className,
        )}
        style={{ ...workspaceStateStyle(tone), ...style }}
        {...props}
      />
    );
  },
);
WorkspaceStateActionGroup.displayName = "WorkspaceStateActionGroup";

export interface WorkspaceStateBadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone: HeaderTone;
}

export const WorkspaceStateBadge = forwardRef<HTMLSpanElement, WorkspaceStateBadgeProps>(
  ({ tone, className, style, ...props }, ref) => (
    <span
      ref={ref}
      data-workspace-state={tone}
      data-state-badge
      className={cn(
        "workspace-state-badge inline-flex shrink-0 items-center justify-center rounded-full",
        className,
      )}
      style={{ ...workspaceStateStyle(tone), ...style }}
      {...props}
    />
  ),
);
WorkspaceStateBadge.displayName = "WorkspaceStateBadge";
