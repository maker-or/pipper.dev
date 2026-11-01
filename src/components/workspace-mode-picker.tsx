import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { useUiModeStore, type UiMode } from "@/store/ui-mode-store";
import { PreviewOption } from "@/components/preview-option";

const MODE_OPTIONS: Array<{ value: UiMode; label: string }> = [
  { value: "basic", label: "Basic" },
  { value: "hybrid", label: "Hybrid" },
  { value: "advanced", label: "Advanced" },
];

type Surface = {
  bg: string;
  rail: string;
  card: string;
  panel: string;
  border: string;
  tabBar: string;
  tabActive: string;
};

/** Palette for the layout previews, following the resolved app theme. */
const SURFACES: Record<"light" | "dark", Surface> = {
  light: {
    bg: "#ffffff",
    rail: "#f0f0f1",
    card: "#e0e0e2",
    panel: "#f6f6f7",
    border: "#ececee",
    tabBar: "#e7e7e9",
    tabActive: "#ffffff",
  },
  dark: {
    bg: "#1b1b1d",
    rail: "#232325",
    card: "#343438",
    panel: "#202022",
    border: "#2c2c2e",
    tabBar: "#303034",
    tabActive: "#4d4d52",
  },
};

const AMBER_GLOW =
  "linear-gradient(to bottom, rgba(245,158,11,0.95) 0%, rgba(245,158,11,0.4) 55%, transparent 100%)";

/** The centered global tab bar shared by both layouts. */
function TabBar({ surface }: { surface: Surface }) {
  return (
    <div
      className="absolute left-1/2 top-[9%] h-[10%] w-[42%] -translate-x-1/2 rounded-full"
      style={{ backgroundColor: surface.tabBar }}
    >
      <span
        className="absolute bottom-[3px] left-[3px] top-[3px] w-[46%] rounded-full"
        style={{ backgroundColor: surface.tabActive }}
      />
    </div>
  );
}

/** Basic layout: a single centered global tab bar, nothing else. */
function BasicPreview({ scheme }: { scheme: "light" | "dark" }) {
  const surface = SURFACES[scheme];
  return (
    <div
      className="relative aspect-[7/5] w-full overflow-hidden"
      style={{ backgroundColor: surface.bg }}
    >
      <TabBar surface={surface} />
    </div>
  );
}

/** Advanced layout: workspace rail, centered tab bar, and control panel. */
function AdvancedPreview({ scheme }: { scheme: "light" | "dark" }) {
  const surface = SURFACES[scheme];
  return (
    <div
      className="relative aspect-[7/5] w-full overflow-hidden"
      style={{ backgroundColor: surface.bg }}
    >
      <div
        className="absolute inset-y-0 left-0 w-[25%]"
        style={{ backgroundColor: surface.rail, borderRight: `1px solid ${surface.border}` }}
      >
        <div className="absolute inset-x-[13%] inset-y-[12%] flex gap-[9%]">
          <div className="flex w-1/2 flex-col gap-[9%]">
            <span
              className="aspect-[4/5] w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
            <span
              className="aspect-square w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
            <span
              className="aspect-[5/4] w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
          </div>
          <div className="mt-[14%] flex w-1/2 flex-col gap-[9%]">
            <span
              className="aspect-square w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
            <span
              className="aspect-[4/5] w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
            <span
              className="aspect-square w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
          </div>
        </div>
      </div>
      <div
        className="absolute inset-y-0 right-0 w-[25%]"
        style={{ backgroundColor: surface.panel, borderLeft: `1px solid ${surface.border}` }}
      >
        <div className="absolute inset-x-0 top-0 h-[18%]" style={{ background: AMBER_GLOW }} />
      </div>
      <TabBar surface={surface} />
    </div>
  );
}

/** Hybrid layout: a rail of project cards and the centered tab bar, no panel. */
function HybridPreview({ scheme }: { scheme: "light" | "dark" }) {
  const surface = SURFACES[scheme];
  return (
    <div
      className="relative aspect-[7/5] w-full overflow-hidden"
      style={{ backgroundColor: surface.bg }}
    >
      <div
        className="absolute inset-y-0 left-0 w-[25%]"
        style={{ backgroundColor: surface.rail, borderRight: `1px solid ${surface.border}` }}
      >
        <div className="absolute inset-x-[13%] inset-y-[12%] flex gap-[9%]">
          <div className="flex w-1/2 flex-col gap-[9%]">
            <span
              className="aspect-[4/5] w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
            <span
              className="aspect-square w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
          </div>
          <div className="mt-[14%] flex w-1/2 flex-col gap-[9%]">
            <span
              className="aspect-square w-full rounded-[4px]"
              style={{ backgroundColor: surface.card }}
            />
          </div>
        </div>
      </div>
      <div className="absolute inset-y-0 left-[25%] right-0">
        <TabBar surface={surface} />
      </div>
    </div>
  );
}

/**
 * Visual layout chooser mirroring the theme picker.
 *
 * Uncontrolled by default: reads and writes the persisted UI mode store.
 * Pass `value`/`onChange` to drive a local selection instead — onboarding
 * uses this to defer committing the choice until the user continues.
 */
export function WorkspaceModePicker({
  className,
  value,
  onChange,
}: {
  className?: string;
  value?: UiMode;
  onChange?: (mode: UiMode) => void;
}) {
  const { mode: storedMode, setMode } = useUiModeStore();
  const { resolvedTheme } = useTheme();

  const mode = value ?? storedMode;
  const select = (next: UiMode) => {
    if (onChange) {
      onChange(next);
      return;
    }
    setMode(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Workspace mode"
      className={cn("flex items-start gap-4", className)}
    >
      {MODE_OPTIONS.map((option) => (
        <PreviewOption
          key={option.value}
          name="pipper-workspace-mode"
          value={option.value}
          label={option.label}
          selected={mode === option.value}
          onSelect={() => select(option.value)}
          className="min-w-0 flex-1"
        >
          {option.value === "basic" ? (
            <BasicPreview scheme={resolvedTheme} />
          ) : option.value === "hybrid" ? (
            <HybridPreview scheme={resolvedTheme} />
          ) : (
            <AdvancedPreview scheme={resolvedTheme} />
          )}
        </PreviewOption>
      ))}
    </div>
  );
}
