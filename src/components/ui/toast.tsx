"use client";

import { toast as sonnerToast } from "sonner";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { surfaceClasses } from "@/lib/surface-classes";

interface ToastAction {
  label: string;
  /** Runs on click; the toast dismisses itself right after. */
  onClick: () => void;
}

interface ToastOptions {
  icon: ReactNode;
  title: string;
  description?: string;
  duration?: number;
  action?: ToastAction;
}

/** Character caps; line clamps below keep even unbroken text to a few lines. */
export const TOAST_TITLE_MAX = 80;
export const TOAST_DESCRIPTION_MAX = 160;

/** Collapse whitespace and cut at `max` characters, ending in an ellipsis. */
export function clampToastText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function ToastContent({
  icon,
  title,
  description,
  action,
  onAction,
}: Omit<ToastOptions, "duration"> & { onAction?: () => void }) {
  return (
    <div className={cn("flex items-start gap-3 p-3 ", surfaceClasses(3))}>
      <div className="shrink-0 mt-0.5">{icon}</div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <p
          className="line-clamp-2 break-words text-[14px] text-foreground font-medium leading-tight"
          title={title}
        >
          {clampToastText(title, TOAST_TITLE_MAX)}
        </p>
        {description && (
          <p
            className="line-clamp-2 break-words text-[13px] text-muted-foreground leading-snug"
            title={description}
          >
            {clampToastText(description, TOAST_DESCRIPTION_MAX)}
          </p>
        )}
      </div>
      {action && (
        <button
          type="button"
          className="ml-auto shrink-0 self-center rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-foreground outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
          onClick={() => {
            onAction?.();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function toast({ icon, title, description, duration, action }: ToastOptions) {
  return sonnerToast.custom(
    (id) => (
      <ToastContent
        icon={icon}
        title={title}
        description={description}
        action={action}
        onAction={() => sonnerToast.dismiss(id)}
      />
    ),
    { duration },
  );
}
