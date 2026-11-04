import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  changedTokens,
  emptyDraft,
  exportCss,
  LAB_THEMES,
  parseDraft,
  THEME_LAB_GROUPS,
  tokensFor,
  type LabTheme,
  type ThemeLabDraft,
  type ThemeOriginals,
} from "@/lib/theme-lab";
import type { HeaderTone } from "@/lib/workspace-tone";
import { DialPanel } from "@/theme-lab/dial-panel";
import { resolveTokenHex } from "@/theme-lab/resolve-color";
import { ShellPreview } from "@/theme-lab/shell-preview";

const DRAFT_KEY = "pipper.themeLab.draft";

function readSavedDraft(): ThemeLabDraft {
  try {
    return parseDraft(window.localStorage.getItem(DRAFT_KEY));
  } catch {
    return emptyDraft();
  }
}

/**
 * The stylesheet's own token values per theme, read from probes that sit
 * outside the edited scope, so edits are always compared with what
 * `index.css` ships.
 */
function useOriginals(): { originals: ThemeOriginals | null; probes: ReactNode } {
  const refs = useRef<Record<LabTheme, HTMLDivElement | null>>({ light: null, dark: null });
  const [originals, setOriginals] = useState<ThemeOriginals | null>(null);
  useLayoutEffect(() => {
    const next: ThemeOriginals = { light: {}, dark: {} };
    for (const theme of LAB_THEMES) {
      const scope = refs.current[theme];
      const probe = scope?.firstElementChild as HTMLElement | null;
      if (!scope || !probe) continue;
      const declared = getComputedStyle(scope);
      for (const group of THEME_LAB_GROUPS) {
        for (const token of tokensFor(group, theme)) {
          const raw = declared.getPropertyValue(token.name).trim();
          // Unset tokens (null) are on purpose: the components fall back to the accent.
          next[theme][token.name] =
            token.kind === "percent" ? raw || null : resolveTokenHex(probe, token.name);
        }
      }
    }
    setOriginals(next);
  }, []);
  const probes = (
    <div aria-hidden className="pointer-events-none invisible fixed size-0 overflow-hidden">
      {LAB_THEMES.map((theme) => (
        <div
          key={theme}
          ref={(node) => {
            refs.current[theme] = node;
          }}
          data-workspace-theme={theme}
        >
          <span />
        </div>
      ))}
    </div>
  );
  return { originals, probes };
}

function initialTheme(): LabTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The theme lab window: the shell on the left, a DialKit-style panel on the
 * right. The whole window takes the theme being edited, and every edit
 * applies live to both sides.
 */
export function ThemeLabApp() {
  const { originals, probes } = useOriginals();
  const [draft, setDraftState] = useState<ThemeLabDraft>(readSavedDraft);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(readSavedDraft()));
  const [theme, setTheme] = useState<LabTheme>(initialTheme);
  const [tone, setTone] = useState<HeaderTone>("ready");
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const setDraft = (update: (current: ThemeLabDraft) => ThemeLabDraft) => {
    setDraftState(update);
    setCopied("idle");
  };

  const changes = useMemo(
    () => (originals ? changedTokens(draft, theme, originals[theme]) : new Map<string, string>()),
    [draft, originals, theme],
  );
  const changedByGroup = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of THEME_LAB_GROUPS) {
      counts[group.id] = tokensFor(group, theme).filter((token) => changes.has(token.name)).length;
    }
    return counts;
  }, [changes, theme]);
  const css = useMemo(() => (originals ? exportCss(draft, originals) : ""), [draft, originals]);
  const draftJson = JSON.stringify(draft);
  const unsaved = draftJson !== savedJson;

  const save = () => {
    try {
      window.localStorage.setItem(DRAFT_KEY, draftJson);
      setSavedJson(draftJson);
    } catch {
      // Storage full or blocked: the draft stays in memory.
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(css);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  const resetTheme = () =>
    setDraft((current) => ({
      values: { ...current.values, [theme]: {} },
      adjust: { ...current.adjust, [theme]: {} },
    }));

  return (
    <>
      {probes}
      <div
        className="flex h-screen flex-col bg-surface-1 text-foreground"
        // Redeclaring the theme here makes derived tokens (dark's accent and
        // badges come from one base colour) resolve against the edits below.
        data-workspace-theme={theme}
        style={Object.fromEntries(changes) as CSSProperties}
        data-pipper-id="theme-lab"
      >
        <div
          className="flex h-11 shrink-0 items-center justify-center text-[12px] font-medium text-muted-foreground select-none"
          style={{ WebkitAppRegion: "drag" } as CSSProperties}
        >
          Theme lab
        </div>
        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
          <div className="min-w-0 flex-1">
            <ShellPreview tone={tone} />
          </div>
          <div className="w-[320px] shrink-0">
            {originals ? (
              <DialPanel
                theme={theme}
                onThemeChange={setTheme}
                tone={tone}
                onToneChange={setTone}
                draft={draft}
                setDraft={setDraft}
                originals={originals[theme]}
                changedByGroup={changedByGroup}
                changeCount={changes.size}
                unsaved={unsaved}
                canCopy={css.length > 0}
                copyLabel={
                  copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy CSS"
                }
                onSave={save}
                onCopy={() => void copy()}
                onReset={resetTheme}
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
