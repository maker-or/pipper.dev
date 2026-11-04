import type { ReactNode } from "react";
import { WorkspaceStateAction } from "@/components/workspace-state";
import type { HeaderTone } from "@/lib/workspace-tone";

/*
 * Outer corners fully round (half the 28px button height); the facing corners
 * softly round, so each reads as its own button. Exact values, not 999px:
 * when corners add up to more than the box, CSS shrinks them all in
 * proportion, which would flatten the facing corners to nothing.
 */
const LEADING_RADIUS = "14px 5px 5px 14px";
const TRAILING_RADIUS = "5px 14px 14px 5px";
const ALONE_RADIUS = "14px";

export interface PairedActionButton {
  label: ReactNode;
  title: string;
  /** Spoken name, when the label alone doesn't say what the button does. */
  ariaLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}

/**
 * Two separate raised buttons side by side, a small gap apart: a main action
 * and a short companion (such as a PR number). Each keeps its own fill and
 * bevel; their outer corners are fully round and the facing corners softly
 * round. Without a companion the main action stands alone as a pill.
 */
export function WorkspacePairedAction({
  tone,
  primary,
  secondary,
}: {
  tone: HeaderTone;
  primary: PairedActionButton;
  secondary?: PairedActionButton | null;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-pipper-id="workspace-paired-action">
      <WorkspaceStateAction
        tone={tone}
        data-paired
        disabled={primary.disabled}
        title={primary.title}
        aria-label={primary.ariaLabel}
        onClick={primary.onClick}
        className="px-3 text-[12px] font-semibold disabled:opacity-50"
        style={{ borderRadius: secondary ? LEADING_RADIUS : ALONE_RADIUS }}
      >
        {primary.label}
      </WorkspaceStateAction>
      {secondary ? (
        <WorkspaceStateAction
          tone={tone}
          data-paired
          disabled={secondary.disabled}
          title={secondary.title}
          aria-label={secondary.ariaLabel}
          onClick={secondary.onClick}
          className="px-2.5 text-[12px] font-semibold tabular-nums disabled:opacity-50"
          style={{ borderRadius: TRAILING_RADIUS }}
        >
          {secondary.label}
        </WorkspaceStateAction>
      ) : null}
    </div>
  );
}
