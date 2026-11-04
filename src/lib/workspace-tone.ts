/**
 * Git-state tone tokens.
 *
 * The workspace surfaces (the control panel header, its action buttons, and
 * the sidebar's active workspace card) all derive their colour from one tone
 * vocabulary, so the same git state reads the same colour everywhere. This
 * module is the single source for that mapping; components import from here
 * rather than re-declaring colours.
 *
 * Header tone is git truth:
 * - neutral: no PR yet (fresh worktree or work in progress)
 * - action:  PR open but something blocks merging (dirty tree, draft,
 *            checks running or failing)
 * - ready:   PR open, tree clean, checks green — merge is the next step
 * - merged:  the branch's PR landed — delete the workspace or continue on
 *            a fresh branch
 * - stale:   no PR and nothing of the user's own to save or share, but the
 *            base branch has moved on — catching up is the next step
 */
export const WORKSPACE_STATES = ["neutral", "action", "ready", "merged", "stale"] as const;
export type HeaderTone = (typeof WORKSPACE_STATES)[number];

/** The palette's state names and meaning, shared with the visual reference. */
export const WORKSPACE_STATE_META: Record<
  HeaderTone,
  { label: string; description: string; action: string }
> = {
  neutral: { label: "In progress", description: "No pull request yet", action: "Commit" },
  action: {
    label: "Needs attention",
    description: "Draft, unpushed changes, or pending checks",
    action: "Commit & push",
  },
  ready: {
    label: "Ready to merge",
    description: "Clean workspace and no blocking checks",
    action: "Merge",
  },
  merged: { label: "Merged", description: "The pull request has landed", action: "Delete" },
  stale: {
    label: "Needs updating",
    description: "The base branch has moved ahead",
    action: "Get latest",
  },
};

/** Shared tone gradients: the panel header and the sidebar's active workspace
 *  card both paint from this map so the two stay in lockstep. */
export const HEADER_TONE_GRADIENT: Record<HeaderTone, string> = {
  neutral:
    "from-[var(--workspace-tone-neutral)]/50 via-[var(--workspace-tone-neutral)]/20 to-transparent",
  action:
    "from-[var(--workspace-tone-action)]/80 via-[var(--workspace-tone-action)]/20 to-transparent",
  ready:
    "from-[var(--workspace-tone-ready)]/80 via-[var(--workspace-tone-ready)]/20 to-transparent",
  merged:
    "from-[var(--workspace-tone-merged)]/80 via-[var(--workspace-tone-merged)]/20 to-transparent",
  stale:
    "from-[var(--workspace-tone-stale)]/80 via-[var(--workspace-tone-stale)]/20 to-transparent",
};

/** Theme-aware state colours live alongside the surface tokens in index.css. */
export const HEADER_TONE_COLOR: Record<HeaderTone, string> = {
  neutral: "var(--workspace-tone-neutral)",
  action: "var(--workspace-tone-action)",
  ready: "var(--workspace-tone-ready)",
  merged: "var(--workspace-tone-merged)",
  stale: "var(--workspace-tone-stale)",
};

/**
 * Inset glow for a state surface: the tone colour cast inward from all four
 * edges, on top of whatever background the surface already has. Shared by the
 * control panel header and the sidebar's active workspace card so the two
 * read as the same state in the same colour.
 *
 * Two stacked shadows shape the falloff the way a single blur cannot: a
 * near-edge band, then a deep glow that reaches toward the centre over the
 * parent colour. No border ring — the state reads purely as a soft inward
 * bleed from all four edges.
 */
export function toneInsetShadow(tone: HeaderTone): string {
  const color = `var(--workspace-glow-${tone}, ${HEADER_TONE_COLOR[tone]})`;
  return [
    `inset 0 0 22px 2px color-mix(in srgb, ${color} var(--workspace-glow-inner-strength, 55%), transparent)`,
    `inset 0 0 48px 8px color-mix(in srgb, ${color} var(--workspace-glow-outer-strength, 30%), transparent)`,
  ].join(", ");
}

/**
 * A header's git-state tint: the state colour at the top, easing into the
 * surface underneath so it ends with no edge. Every stop is mixed with the
 * surface itself rather than with transparency, so the last stop is exactly
 * the panel background in either theme. Each theme sets how strong the top is.
 */
export function toneFade(tone: HeaderTone): string {
  const color = `var(--workspace-glow-background-${tone}, ${HEADER_TONE_COLOR[tone]})`;
  const surface = "var(--workspace-state-surface)";
  const stop = (share: number, at: string) =>
    `color-mix(in srgb, ${color} calc(var(--workspace-header-fade-strength) * ${share}), ${surface}) ${at}`;
  return `linear-gradient(to bottom, ${stop(1, "0%")}, ${stop(0.62, "30%")}, ${stop(0.3, "60%")}, ${stop(0.1, "82%")}, ${surface} 100%)`;
}

/**
 * Flat fill for solid action buttons, paired with HEADER_TONE_INK.
 * Each theme supplies its own coordinated fill and label colours.
 */
export const HEADER_TONE_FILL: Record<HeaderTone, string> = {
  neutral: "var(--workspace-fill-neutral)",
  action: "var(--workspace-fill-action)",
  ready: "var(--workspace-fill-ready)",
  merged: "var(--workspace-fill-merged)",
  stale: "var(--workspace-fill-stale)",
};

/** Ink paired with the state action fill in either theme. */
export const HEADER_TONE_INK: Record<HeaderTone, string> = {
  neutral: "var(--workspace-ink-neutral)",
  action: "var(--workspace-ink-action)",
  ready: "var(--workspace-ink-ready)",
  merged: "var(--workspace-ink-merged)",
  stale: "var(--workspace-ink-stale)",
};

/** Theme-aware badge surface/text pair, coordinated with each state's palette. */
export function toneIdentity(tone: HeaderTone): { bg: string; ink: string; ring: string } {
  return {
    bg: `var(--workspace-badge-surface-${tone})`,
    ink: `var(--workspace-badge-ink-${tone})`,
    ring: `color-mix(in srgb, ${HEADER_TONE_COLOR[tone]} 85%, transparent)`,
  };
}
