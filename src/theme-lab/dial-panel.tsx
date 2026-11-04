import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { resolveTokenHex } from "@/theme-lab/resolve-color";
import { ArrowCounterClockwise, Copy, FloppyDisk, Moon, Sun } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SliderComfortable } from "@/components/ui/slider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Elevated } from "@/lib/elevated";
import { isNoAdjust, NO_ADJUST, parseHex, toHex, type ColorAdjust } from "@/lib/oklch";
import {
  groupAdjust,
  STATE_INTENSITY_GROUP,
  stateGroup,
  tokensFor,
  type LabTheme,
  type LabToken,
  type ThemeLabDraft,
} from "@/lib/theme-lab";
import { cn } from "@/lib/utils";
import { WORKSPACE_STATES, WORKSPACE_STATE_META, type HeaderTone } from "@/lib/workspace-tone";

type SetDraft = (update: (draft: ThemeLabDraft) => ThemeLabDraft) => void;

function withValue(
  draft: ThemeLabDraft,
  theme: LabTheme,
  name: string,
  value: string | null,
): ThemeLabDraft {
  const values = { ...draft.values[theme] };
  if (value === null) delete values[name];
  else values[name] = value;
  return { ...draft, values: { ...draft.values, [theme]: values } };
}

function HexField({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (hex: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const parsed = parseHex(text);
    if (parsed) onCommit(toHex(parsed));
    else setText(value);
  };
  return (
    <input
      aria-label={`${label} hex`}
      value={text}
      placeholder="auto"
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setText(value);
      }}
      className="h-6 w-[76px] rounded-md bg-transparent px-1.5 text-right font-mono text-[11px] text-muted-foreground outline-none hover:bg-hover focus:bg-hover focus:text-foreground"
    />
  );
}

/** One colour: name, hex, and a swatch that opens the picker. */
function ColorRow({
  token,
  base,
  shown,
  edited,
  onChange,
  onReset,
}: {
  token: LabToken;
  /** The value before the state's dials: the edit, else the stylesheet's. */
  base: string | null;
  /** The hex to show: the edit, else what the token resolves to now. */
  shown: string | null;
  edited: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const rgba = base ? parseHex(base) : null;
  return (
    <div className="group/row flex h-8 items-center gap-1 pl-2" data-theme-lab-token={token.name}>
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
        {token.label}
        {edited ? <span className="ml-1 text-muted-foreground">•</span> : null}
      </span>
      <button
        type="button"
        aria-label={`Reset ${token.label}`}
        disabled={!edited}
        onClick={onReset}
        className="grid size-6 place-items-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-hover hover:text-foreground focus-visible:opacity-100 disabled:hidden group-hover/row:opacity-100"
      >
        <ArrowCounterClockwise size={12} />
      </button>
      <HexField value={shown ?? ""} label={token.label} onCommit={onChange} />
      <label
        className={cn(
          "relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border",
          !base && "bg-[repeating-linear-gradient(45deg,transparent_0_3px,var(--border)_3px_4px)]",
        )}
        // The swatch shows the live result, dials included.
        style={base ? { backgroundColor: `var(${token.name})` } : undefined}
        title={base ? undefined : "Unset: falls back to the accent"}
      >
        <input
          type="color"
          aria-label={token.label}
          value={rgba ? toHex({ ...rgba, a: 1 }) : "#808080"}
          onChange={(event) => {
            const picked = parseHex(event.target.value);
            // The picker has no alpha; keep the token's own.
            if (picked) onChange(toHex({ ...picked, a: rgba?.a ?? 1 }));
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function Dials({
  adjust,
  onChange,
}: {
  adjust: ColorAdjust;
  onChange: (next: ColorAdjust) => void;
}) {
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  return (
    <div className="flex flex-col gap-1.5">
      <SliderComfortable
        variant="scrubber"
        label="Lightness"
        min={-30}
        max={30}
        step={1}
        value={Math.round(adjust.lightness * 100)}
        onChange={(value) => onChange({ ...adjust, lightness: value / 100 })}
        formatValue={signed}
      />
      <SliderComfortable
        variant="scrubber"
        label="Saturation"
        min={0}
        max={200}
        step={5}
        value={Math.round(adjust.chroma * 100)}
        onChange={(value) => onChange({ ...adjust, chroma: value / 100 })}
        formatValue={(value) => `${value}%`}
      />
      <SliderComfortable
        variant="scrubber"
        label="Hue"
        min={-180}
        max={180}
        step={1}
        value={adjust.hue}
        onChange={(value) => onChange({ ...adjust, hue: value })}
        formatValue={(value) => `${signed(value)}°`}
      />
    </div>
  );
}

function percentNumber(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface DialPanelProps {
  theme: LabTheme;
  onThemeChange: (theme: LabTheme) => void;
  tone: HeaderTone;
  onToneChange: (tone: HeaderTone) => void;
  draft: ThemeLabDraft;
  setDraft: SetDraft;
  originals: Record<string, string | null>;
  /** Tokens changed per state group id, for the picker's markers. */
  changedByGroup: Record<string, number>;
  changeCount: number;
  unsaved: boolean;
  canCopy: boolean;
  copyLabel: string;
  onSave: () => void;
  onCopy: () => void;
  onReset: () => void;
}

/** The DialKit-style panel: theme, git state, then that state's colours and dials. */
export function DialPanel({
  theme,
  onThemeChange,
  tone,
  onToneChange,
  draft,
  setDraft,
  originals,
  changedByGroup,
  changeCount,
  unsaved,
  canCopy,
  copyLabel,
  onSave,
  onCopy,
  onReset,
}: DialPanelProps) {
  const group = stateGroup(tone);
  const adjust = groupAdjust(draft, theme, group.id);
  // What each colour resolves to right now, dials and derived tokens included;
  // read from inside the edited scope after every change.
  const liveProbe = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState<Record<string, string | null>>({});
  useLayoutEffect(() => {
    const probe = liveProbe.current;
    if (!probe) return;
    const next: Record<string, string | null> = {};
    for (const token of tokensFor(group, theme))
      next[token.name] = resolveTokenHex(probe, token.name);
    setLive(next);
  }, [draft, theme, group]);
  const setAdjust = (next: ColorAdjust) =>
    setDraft((current) => ({
      ...current,
      adjust: { ...current.adjust, [theme]: { ...current.adjust[theme], [group.id]: next } },
    }));
  const setValue = (name: string, value: string | null) =>
    setDraft((current) =>
      withValue(current, theme, name, value !== null && value === originals[name] ? null : value),
    );

  return (
    <Elevated
      offset={1}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70"
      data-pipper-id="theme-lab-panel"
    >
      <span ref={liveProbe} aria-hidden className="hidden" />
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <span className="text-[13px] font-semibold text-foreground">Git state colours</span>
        <div className="ml-auto flex items-center gap-0.5" role="group" aria-label="Theme">
          {(
            [
              ["light", Sun],
              ["dark", Moon],
            ] as const
          ).map(([value, Icon]) => (
            <Button
              key={value}
              size="icon-sm"
              variant={theme === value ? "secondary" : "ghost"}
              aria-label={value === "light" ? "Edit light theme" : "Edit dark theme"}
              aria-pressed={theme === value}
              onClick={() => onThemeChange(value)}
            >
              <Icon size={14} />
            </Button>
          ))}
        </div>
      </div>

      <div
        className="flex shrink-0 flex-col gap-0.5 px-2 pb-2"
        role="radiogroup"
        aria-label="Git state"
      >
        {WORKSPACE_STATES.map((value) => {
          const count = changedByGroup[stateGroup(value).id] ?? 0;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={tone === value}
              onClick={() => onToneChange(value)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[12px] outline-none transition-colors duration-80 focus-visible:ring-1 focus-visible:ring-ring",
                tone === value
                  ? "bg-active text-foreground"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: `var(--workspace-tone-${value})` }}
              />
              <span className="flex-1 truncate font-medium">
                {WORKSPACE_STATE_META[value].label}
              </span>
              {count > 0 ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <ScrollArea className="min-h-0 flex-1 border-t border-border/70" scrollFade cueSize="tight">
        <Accordion
          type="multiple"
          defaultValue={["colours", "dials", "intensity"]}
          className="px-1 py-1"
        >
          <AccordionItem value="colours" index={0}>
            <AccordionTrigger>Colours</AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col">
                {tokensFor(group, theme).map((token) => (
                  <ColorRow
                    key={token.name}
                    token={token}
                    base={draft.values[theme][token.name] ?? originals[token.name] ?? null}
                    shown={draft.values[theme][token.name] ?? live[token.name] ?? null}
                    edited={token.name in draft.values[theme]}
                    onChange={(hex) => setValue(token.name, hex)}
                    onReset={() => setValue(token.name, null)}
                  />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="dials" index={1}>
            <AccordionTrigger>Dials</AccordionTrigger>
            <AccordionContent>
              <Dials adjust={adjust} onChange={setAdjust} />
              {isNoAdjust(adjust) ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-1"
                  leadingIcon={ArrowCounterClockwise}
                  onClick={() => setAdjust(NO_ADJUST)}
                >
                  Reset dials
                </Button>
              )}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="intensity" index={2}>
            <AccordionTrigger>Intensity · all states</AccordionTrigger>
            <AccordionContent>
              <div className="flex flex-col gap-1.5">
                {tokensFor(STATE_INTENSITY_GROUP, theme).map((token) => (
                  <SliderComfortable
                    key={token.name}
                    variant="scrubber"
                    label={token.label}
                    min={0}
                    max={100}
                    step={1}
                    value={percentNumber(draft.values[theme][token.name] ?? originals[token.name])}
                    onChange={(value) => setValue(token.name, `${value}%`)}
                    formatValue={(value) => `${value}%`}
                    data-theme-lab-token={token.name}
                  />
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </ScrollArea>

      <div className="flex shrink-0 items-center gap-1 border-t border-border/70 p-2">
        <span
          className="flex-1 truncate pl-1 text-[11px] tabular-nums text-muted-foreground"
          role="status"
        >
          {changeCount === 1 ? "1 change" : `${changeCount} changes`}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Reset this theme"
          title="Reset this theme"
          onClick={onReset}
          disabled={changeCount === 0}
        >
          <ArrowCounterClockwise size={14} />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={FloppyDisk}
          onClick={onSave}
          disabled={!unsaved}
        >
          {unsaved ? "Save" : "Saved"}
        </Button>
        <Button size="sm" variant="primary" leadingIcon={Copy} onClick={onCopy} disabled={!canCopy}>
          {copyLabel}
        </Button>
      </div>
    </Elevated>
  );
}
