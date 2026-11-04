/**
 * The theme lab's model: which git-state tokens it exposes, how a draft of
 * edits turns into token values, and the CSS it exports for `src/index.css`.
 * Surfaces and text colours belong to the component library and stay out.
 *
 * A draft holds two kinds of edit per theme: explicit token values, and a
 * per-group OKLCH adjustment (lightness, intensity, hue) applied on top of
 * each colour in the group. Nothing here touches the DOM; the original values
 * come from the caller, resolved from the live stylesheet.
 */
import { WORKSPACE_STATES, WORKSPACE_STATE_META, type HeaderTone } from "@/lib/workspace-tone";
import { adjustHex, isNoAdjust, NO_ADJUST, type ColorAdjust } from "@/lib/oklch";

export type LabTheme = "light" | "dark";
export const LAB_THEMES: readonly LabTheme[] = ["light", "dark"];

export interface LabToken {
  /** CSS custom property, e.g. `--workspace-fill-ready`. */
  name: string;
  label: string;
  kind: "color" | "percent";
  /** Themes the token is meaningful in; both when omitted. */
  themes?: readonly LabTheme[];
}

export interface LabGroup {
  id: string;
  label: string;
  description: string;
  tokens: readonly LabToken[];
  /** Whether the group gets lightness / intensity / hue knobs. */
  adjustable: boolean;
}

const color = (name: string, label: string, themes?: readonly LabTheme[]): LabToken => ({
  name,
  label,
  kind: "color",
  themes,
});

/** Each git state's colours, in plain names. Dark leaves several unset on purpose
 *  (the components fall back to the accent); setting one here overrides that. */
const stateGroups: LabGroup[] = WORKSPACE_STATES.map((tone) => ({
  id: `state-${tone}`,
  label: WORKSPACE_STATE_META[tone].label,
  description: WORKSPACE_STATE_META[tone].description,
  adjustable: true,
  tokens: [
    // Dark derives the accent, badge and badge text from one base colour.
    color(`--workspace-tone-${tone}`, "Accent", ["light"]),
    color(`--workspace-color-${tone}`, "Accent", ["dark"]),
    color(`--workspace-glow-background-${tone}`, "Header wash"),
    color(`--workspace-glow-${tone}`, "Card glow"),
    color(`--workspace-fill-${tone}`, "Button"),
    color(`--workspace-ink-${tone}`, "Button text"),
    color(`--workspace-badge-surface-${tone}`, "Badge"),
    color(`--workspace-badge-ink-${tone}`, "Badge text"),
    color(`--workspace-control-tint-${tone}`, "PR tag"),
    color(`--workspace-control-ink-${tone}`, "PR tag text"),
  ],
}));

/** Shared by every state: how strongly the state shows. */
export const STATE_INTENSITY_GROUP: LabGroup = {
  id: "intensity",
  label: "Intensity",
  description: "How strongly every git state shows.",
  adjustable: false,
  tokens: [
    { name: "--workspace-header-fade-strength", label: "Header wash", kind: "percent" },
    { name: "--workspace-glow-inner-strength", label: "Card glow", kind: "percent" },
    { name: "--workspace-glow-outer-strength", label: "Card deep glow", kind: "percent" },
    { name: "--workspace-pr-arrow-opacity", label: "PR tag arrow", kind: "percent" },
  ],
};

export const THEME_LAB_GROUPS: readonly LabGroup[] = [...stateGroups, STATE_INTENSITY_GROUP];

/** The group holding one git state's colours. */
export function stateGroup(tone: HeaderTone): LabGroup {
  return stateGroups[WORKSPACE_STATES.indexOf(tone)];
}

export function tokensFor(group: LabGroup, theme: LabTheme): LabToken[] {
  return group.tokens.filter((token) => !token.themes || token.themes.includes(theme));
}

export interface ThemeLabDraft {
  /** Explicit values: lowercase hex for colours, `NN%` for percents. */
  values: Record<LabTheme, Record<string, string>>;
  adjust: Record<LabTheme, Record<string, ColorAdjust>>;
}

export function emptyDraft(): ThemeLabDraft {
  return { values: { light: {}, dark: {} }, adjust: { light: {}, dark: {} } };
}

/** Original token values per theme: hex / `NN%`, or null when unset (the code falls back). */
export type ThemeOriginals = Record<LabTheme, Record<string, string | null>>;

export function groupAdjust(draft: ThemeLabDraft, theme: LabTheme, groupId: string): ColorAdjust {
  return draft.adjust[theme][groupId] ?? NO_ADJUST;
}

/**
 * The tokens a draft changes in one theme, with their final values. A
 * group's adjustment applies to the edited value when there is one, else to
 * the original; tokens that end up at their original value are left out.
 */
export function changedTokens(
  draft: ThemeLabDraft,
  theme: LabTheme,
  originals: Record<string, string | null>,
): Map<string, string> {
  const changed = new Map<string, string>();
  for (const group of THEME_LAB_GROUPS) {
    const adjust = groupAdjust(draft, theme, group.id);
    for (const token of tokensFor(group, theme)) {
      const original = originals[token.name] ?? null;
      const base = draft.values[theme][token.name] ?? original;
      if (base == null) continue;
      const value = token.kind === "color" ? adjustHex(base, adjust) : base;
      if (value !== original) changed.set(token.name, value);
    }
  }
  return changed;
}

function describeAdjust(adjust: ColorAdjust): string {
  const sign = (value: number) => (value > 0 ? `+${value}` : String(value));
  return `lightness ${sign(Math.round(adjust.lightness * 100))}, intensity ${Math.round(adjust.chroma * 100)}%, hue ${sign(adjust.hue)}°`;
}

const SELECTORS: Record<LabTheme, string> = {
  light: ':root,\n[data-workspace-theme="light"]',
  dark: '.dark,\n[data-workspace-theme="dark"]',
};

/** CSS blocks holding only the changed tokens, grouped and ready for `src/index.css`. */
export function exportCss(draft: ThemeLabDraft, originals: ThemeOriginals): string {
  const blocks: string[] = [];
  for (const theme of LAB_THEMES) {
    const changed = changedTokens(draft, theme, originals[theme]);
    if (changed.size === 0) continue;
    const lines: string[] = [];
    for (const group of THEME_LAB_GROUPS) {
      const tokens = tokensFor(group, theme).filter((token) => changed.has(token.name));
      if (tokens.length === 0) continue;
      const adjust = groupAdjust(draft, theme, group.id);
      const note = isNoAdjust(adjust) ? "" : ` (${describeAdjust(adjust)})`;
      lines.push(`  /* ${group.label}${note} */`);
      for (const token of tokens) {
        const was = originals[theme][token.name] ?? "unset";
        lines.push(`  ${token.name}: ${changed.get(token.name)}; /* was ${was} */`);
      }
    }
    blocks.push(`${SELECTORS[theme]} {\n${lines.join("\n")}\n}`);
  }
  if (blocks.length === 0) return "";
  return `/* Pipper theme lab export — changed tokens only. */\n${blocks.join("\n\n")}\n`;
}

/** Reads a saved draft, dropping anything malformed. */
export function parseDraft(raw: string | null): ThemeLabDraft {
  const draft = emptyDraft();
  if (!raw) return draft;
  try {
    const parsed = JSON.parse(raw) as Partial<ThemeLabDraft>;
    for (const theme of LAB_THEMES) {
      for (const [name, value] of Object.entries(parsed.values?.[theme] ?? {})) {
        if (typeof value === "string") draft.values[theme][name] = value;
      }
      for (const [id, adjust] of Object.entries(parsed.adjust?.[theme] ?? {})) {
        if (
          adjust &&
          typeof adjust.lightness === "number" &&
          typeof adjust.chroma === "number" &&
          typeof adjust.hue === "number"
        ) {
          draft.adjust[theme][id] = adjust;
        }
      }
    }
  } catch {
    // A corrupt draft starts over rather than breaking the section.
  }
  return draft;
}
