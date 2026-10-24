import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  CircleNotch,
  WarningCircle,
} from "@phosphor-icons/react";
import { AgentAccountsSettings } from "@/components/agent-accounts-settings";
import { RemoteAccessSettings } from "@/components/remote-access-settings";
import { SleeplessControl } from "@/components/sleepless-control";
import { WorkspaceStateGallery } from "@/components/workspace-state-gallery";
import { ThemePicker } from "@/components/theme-picker";
import { WorkspaceModePicker } from "@/components/workspace-mode-picker";
import { createProviderLogoIcon } from "@/components/provider-logos";
import { Elevated } from "@/lib/elevated";
import type { IconComponent } from "@/lib/icon-context";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { useTabGestureStore } from "@/store/tab-gesture-store";
import type { AcpAgentDescriptor, BrowserConfig } from "../../contracts/acp.ts";
import type { WorkspaceDiskUsageReport } from "../../contracts/storage.ts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { SliderComfortable } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

function modifierSymbol(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
}

type SectionId =
  | "design"
  | "appearance"
  | "agents"
  | "browser"
  | "accounts"
  | "keyboard"
  | "power"
  | "remote"
  | "storage";

const NAV_ITEMS: Array<{ id: SectionId; label: string }> = [
  { id: "appearance", label: "Appearance" },
  { id: "design", label: "Design system" },
  { id: "agents", label: "Agents" },
  { id: "browser", label: "Browser" },
  { id: "accounts", label: "Account" },
  { id: "keyboard", label: "Keyboard & trackpad" },
  { id: "power", label: "Power" },
  { id: "storage", label: "Storage" },
  { id: "remote", label: "Remote" },
];

/**
 * Registry id → anchor on the marketing setup guide (`/docs/agents`).
 * Same mapping as onboarding (`agent-selector.tsx`) so a failed check in
 * Settings links to the same install / sign-in steps.
 */
const SETUP_GUIDE_BASE_URL = "https://www.pipper.dev/docs/agents";

const SETUP_GUIDE_DOC_IDS: Record<string, string> = {
  "cursor-acp": "cursor",
  "codex-acp": "codex",
  "claude-agent-acp": "claude",
  "opencode-acp": "opencode",
  "grok-acp": "grok",
  "gemini-acp": "gemini",
  "copilot-acp": "copilot",
  "antigravity-acp": "antigravity",
  "devin-acp": "devin",
};

function setupGuideUrl(agentId: string): string | null {
  const docId = SETUP_GUIDE_DOC_IDS[agentId];
  return docId ? `${SETUP_GUIDE_BASE_URL}#${docId}` : null;
}

function agentLogoKey(agent: AcpAgentDescriptor): string {
  return agent.icon ?? agent.id ?? agent.name;
}

function SettingRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: IconComponent;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[76px] items-center gap-4 px-4 py-3">
      {Icon && (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-muted-foreground shadow-surface-1">
          <Icon size={18} strokeWidth={1.8} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {description && (
          <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-surface-3 px-2 py-1 text-[11px] tabular-nums text-muted-foreground shadow-surface-1">
      {children}
    </span>
  );
}

function AgentCheckStatus({ agentId, displayName }: { agentId: string; displayName: string }) {
  const result = useAgentRegistryStore((s) => s.probeResults[agentId]);
  const probeAgents = useAgentRegistryStore((s) => s.probeAgents);

  const status = result?.status;
  const guideUrl = status === "ready" || status === undefined ? null : setupGuideUrl(agentId);

  const openSetupGuide = async () => {
    if (!guideUrl || !window.omni?.shell?.openExternal) return;
    try {
      await window.omni.shell.openExternal(guideUrl);
    } catch {
      // Link is a convenience — a blocked popup must never break Settings.
    }
  };

  if (!result || status === "probing") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <CircleNotch size={14} className="animate-spin" aria-label={`Checking ${displayName}`} />
        Checking…
      </span>
    );
  }

  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
        <CheckCircleIcon
          size={15}
          weight="fill"
          aria-label={`${displayName} is ready`}
          data-pipper-id={`settings-agent-ready-${agentId}`}
        />
        Ready
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span
        className="inline-flex max-w-[220px] items-center gap-1.5 text-[11px] leading-4 text-amber-500"
        title={result.message ?? undefined}
      >
        <WarningCircle size={14} weight="fill" className="shrink-0" />
        <span className="truncate">
          {status === "needs-auth"
            ? "Sign-in required"
            : status === "needs-install"
              ? "Install required"
              : (result.message ?? "Needs attention")}
        </span>
      </span>
      {guideUrl && (
        <button
          type="button"
          onClick={() => void openSetupGuide()}
          aria-label={`Open setup guide for ${displayName}`}
          data-pipper-id={`settings-agent-guide-${agentId}`}
          className="text-[11px] text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          Setup guide
        </button>
      )}
      <Button
        type="button"
        variant="tertiary"
        size="icon-sm"
        aria-label={`Retry ${displayName} check`}
        title={result.message ?? `Retry ${displayName} check`}
        data-pipper-id={`settings-agent-retry-${agentId}`}
        onClick={() => void probeAgents([agentId])}
      >
        <ArrowsClockwiseIcon size={16} />
      </Button>
    </span>
  );
}

function AgentSettingsRow({ agent }: { agent: AcpAgentDescriptor }) {
  const selected = useAgentRegistryStore((s) => s.selectedAgentIds.includes(agent.id));
  const toggleAgent = useAgentRegistryStore((s) => s.toggleAgent);
  const probeAgents = useAgentRegistryStore((s) => s.probeAgents);
  const BrandIcon = useMemo(
    () => createProviderLogoIcon(agentLogoKey(agent), agent.displayName),
    [agent.id, agent.icon, agent.name, agent.displayName],
  );

  return (
    <div className="flex min-h-[76px] items-center gap-4 px-4 py-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-muted-foreground shadow-surface-1">
        <BrandIcon size={18} strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{agent.displayName}</div>
        {selected && (
          <div className="mt-1.5">
            <AgentCheckStatus agentId={agent.id} displayName={agent.displayName} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        <Switch
          label={selected ? `Disable ${agent.displayName}` : `Enable ${agent.displayName}`}
          checked={selected}
          onToggle={() => {
            void (async () => {
              await toggleAgent(agent.id);
              const nowSelected = useAgentRegistryStore
                .getState()
                .selectedAgentIds.includes(agent.id);
              // Toggling on activates the agent; the handshake check runs in
              // the background so the row flips immediately to Checking….
              if (nowSelected) void probeAgents([agent.id]);
            })();
          }}
          // Hide only the text label (last child span). Do not target the
          // switch root — Base UI renders it as a span too.
          className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
          data-pipper-id={`settings-agent-switch-${agent.id}`}
        />
      </div>
    </div>
  );
}

function AgentsSettingsSection() {
  const agents = useAgentRegistryStore((s) => s.agents);
  const selectedAgentIds = useAgentRegistryStore((s) => s.selectedAgentIds);
  const probeResults = useAgentRegistryStore((s) => s.probeResults);
  const load = useAgentRegistryStore((s) => s.load);
  const probeAgents = useAgentRegistryStore((s) => s.probeAgents);
  const error = useAgentRegistryStore((s) => s.error);
  const probedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void load();
  }, [load]);

  // Background checks: whenever the activated set changes, probe any
  // activated agent we haven't checked yet. Never blocks the toggle.
  useEffect(() => {
    const pending = selectedAgentIds.filter(
      (id) => !probedRef.current.has(id) && probeResults[id]?.status !== "probing",
    );
    if (pending.length === 0) return;
    pending.forEach((id) => probedRef.current.add(id));
    void probeAgents(pending);
  }, [selectedAgentIds, probeResults, probeAgents]);

  const visibleAgents = useMemo(() => {
    const visible = agents.filter((agent) => {
      if (agent.installKind !== "mock") return true;
      const anyReady = agents.some((a) => a.available && a.installKind !== "mock");
      return !anyReady;
    });
    // Activated first, then the rest toggled off — one group.
    return [...visible].sort((a, b) => {
      const aOn = selectedAgentIds.includes(a.id) ? 0 : 1;
      const bOn = selectedAgentIds.includes(b.id) ? 0 : 1;
      return aOn - bOn;
    });
  }, [agents, selectedAgentIds]);

  if (agents.length === 0) {
    return (
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
          {error ?? "No ACP agents in the registry."}
        </div>
      </Elevated>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="px-1 text-[11px] leading-4 text-muted-foreground">
        {selectedAgentIds.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{selectedAgentIds.length} activated</span>{" "}
            · checks run in the background after you toggle an agent on
          </>
        ) : (
          "Toggle an agent on to activate it — its check runs in the background."
        )}
      </div>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <div className="divide-y divide-border/70">
          {visibleAgents.map((agent) => (
            <AgentSettingsRow key={agent.id} agent={agent} />
          ))}
        </div>
      </Elevated>
      {error && (
        <p className="px-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SECTION_META: Record<SectionId, { title: string; blurb: string }> = {
  storage: {
    title: "Storage",
    blurb: "Control dependency installs and see what each workspace uses on disk.",
  },
  design: {
    title: "Workspace design system",
    blurb: "Git-state colors, surfaces, and controls in light and dark mode.",
  },
  appearance: {
    title: "Appearance",
    blurb: "Control how Pipper Code looks and the layout it opens with.",
  },
  agents: {
    title: "Agents",
    blurb: "Choose which coding agents Pipper can use.",
  },
  browser: {
    title: "Agent browser",
    blurb: "Headless pages your agents can open to read docs and test web apps.",
  },
  accounts: {
    title: "Account",
    blurb: "",
  },
  keyboard: {
    title: "Keyboard & trackpad",
    blurb: "Configure tab gestures and find shortcuts for moving around Pipper.",
  },
  power: {
    title: "Power",
    blurb: "Keep agents running when your Mac would rather sleep.",
  },
  remote: {
    title: "Remote access",
    blurb: "Pair your phone to drive Pipper from anywhere.",
  },
};

function AppearanceView() {
  return (
    <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
      <div className="divide-y divide-border/70">
        <SettingRow title="Theme">
          <ThemePicker />
        </SettingRow>
        <div className="px-4 py-4">
          <div className="text-[13px] font-medium text-foreground">Workspace mode</div>
          <WorkspaceModePicker className="mt-3" />
        </div>
      </div>
    </Elevated>
  );
}

function AccountsView() {
  return (
    <Elevated offset={1} className="overflow-hidden rounded-xl bg-transparent shadow-none">
      <AgentAccountsSettings />
    </Elevated>
  );
}

function KeyboardView() {
  const mod = modifierSymbol();
  const swipeEnabled = useTabGestureStore((state) => state.swipeEnabled);
  const setSwipeEnabled = useTabGestureStore((state) => state.setSwipeEnabled);
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return (
    <div className="flex flex-col gap-4">
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <SettingRow
          title="Swipe between tabs"
          description={
            isMac
              ? "Uses your macOS ‘Swipe between pages’ gesture. Swipe left for the next tab or right for the previous tab."
              : "Trackpad tab navigation is available on macOS."
          }
        >
          <Switch
            label="Swipe between tabs"
            checked={swipeEnabled}
            onToggle={() => setSwipeEnabled(!swipeEnabled)}
            disabled={!isMac}
            className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
            data-pipper-id="settings-tab-swipe-switch"
          />
        </SettingRow>
      </Elevated>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70 px-1 py-1">
        <Table>
          <TableBody>
            <TableRow index={0}>
              <TableCell>
                <span className="font-medium text-foreground">Switch tabs</span>
                <span className="mt-0.5 block text-[11px] leading-4">
                  From the left of the tab bar, {mod}1 opens the first tab through {mod}9.
                </span>
              </TableCell>
              <TableCell className="w-[1%] text-right whitespace-nowrap">
                <Kbd>
                  {mod}1–{mod}9
                </Kbd>
              </TableCell>
            </TableRow>
            <TableRow index={1}>
              <TableCell>
                <span className="font-medium text-foreground">New tab</span>
                <span className="mt-0.5 block text-[11px] leading-4">
                  Opens a new thread. The composer stays a draft until you send the first message.
                </span>
              </TableCell>
              <TableCell className="w-[1%] text-right whitespace-nowrap">
                <Kbd>{mod}T</Kbd>
              </TableCell>
            </TableRow>
            <TableRow index={2}>
              <TableCell>
                <span className="font-medium text-foreground">New terminal</span>
                <span className="mt-0.5 block text-[11px] leading-4">
                  Opens a terminal in the current workspace.
                </span>
              </TableCell>
              <TableCell className="w-[1%] text-right whitespace-nowrap">
                <Kbd>{mod === "⌘" ? "⌘⇧T" : "Ctrl+Shift+T"}</Kbd>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Elevated>
    </div>
  );
}

function PowerView() {
  return (
    <>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <SleeplessControl variant="settings" />
      </Elevated>
      <Accordion type="single" collapsible className="mt-2 w-full">
        <AccordionItem value="power-requirements">
          <AccordionTrigger>System requirements</AccordionTrigger>
          <AccordionContent>
            Requires the Sleepless helper and Login Items permission on macOS.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Per-workspace disk usage, split into source and regenerable output. The
 * scan reads every file's size, so it only runs when the user asks.
 */
function WorkspaceUsagePanel() {
  const [report, setReport] = useState<WorkspaceDiskUsageReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      setReport(await window.omni.storage.workspaceUsage());
    } catch {
      setError("Could not measure workspace disk usage.");
    } finally {
      setScanning(false);
    }
  };
  const workspaces = useMemo(
    () =>
      [...(report?.workspaces ?? [])].sort(
        (a, b) => b.dependencyBytes + b.buildBytes - (a.dependencyBytes + a.buildBytes),
      ),
    [report],
  );
  return (
    <>
      <Elevated offset={1} className="mt-3 overflow-hidden rounded-xl border border-border/70">
        <SettingRow
          title="Workspace disk usage"
          description="Shows each workspace’s own files separately from dependencies and build output, which an install or build can recreate. Git history is shared between workspaces and not counted. Nothing is deleted."
        >
          <Button
            disabled={scanning}
            onClick={() => void scan()}
            data-pipper-id="settings-workspace-usage-scan"
          >
            {scanning ? "Measuring…" : report ? "Measure again" : "Measure"}
          </Button>
        </SettingRow>
        {report && workspaces.length > 0 && (
          <Table data-pipper-id="settings-workspace-usage-table">
            <TableBody>
              {workspaces.map((workspace, index) => (
                <TableRow key={workspace.path} index={index}>
                  <TableCell>
                    <span className="font-medium text-foreground">{workspace.name}</span>
                    <span
                      className="mt-0.5 block truncate text-[11px] leading-4"
                      title={workspace.path}
                    >
                      {workspace.projectName}
                      {workspace.isProjectRoot ? " · main checkout" : ""}
                      {workspace.truncated ? " · partial scan" : ""}
                    </span>
                  </TableCell>
                  <TableCell className="w-[1%] text-right text-[11px] whitespace-nowrap">
                    <span className="block text-foreground">
                      {formatBytes(workspace.sourceBytes)} source
                    </span>
                    <span className="block">
                      {formatBytes(workspace.dependencyBytes)} dependencies ·{" "}
                      {formatBytes(workspace.buildBytes)} build
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Elevated>
      {report && workspaces.length === 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground" role="status">
          No Git workspaces found.
        </p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function StorageView() {
  const [autoInstall, setAutoInstall] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactionMessage, setCompactionMessage] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    window.omni.worktrees
      .getAutoInstall()
      .then((value) => {
        if (!disposed) setAutoInstall(value);
      })
      .catch(() => {
        if (!disposed) setError("Could not load storage settings.");
      });
    return () => {
      disposed = true;
    };
  }, []);
  const toggle = async () => {
    if (autoInstall === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      setAutoInstall(await window.omni.worktrees.setAutoInstall(!autoInstall));
    } catch {
      setError("Could not save storage settings.");
    } finally {
      setSaving(false);
    }
  };
  const compact = async () => {
    if (compacting) return;
    setCompacting(true);
    setError(null);
    setCompactionMessage(null);
    try {
      const result = await window.omni.storage.compactDatabase();
      const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
      setCompactionMessage(
        result.status === "busy"
          ? "Pipper is busy. Space is reclaimed once running agents finish; try again then."
          : result.status === "insufficient-space"
            ? `Not enough free disk space. Free about ${mib((result.requiredFreeBytes ?? 0) - (result.availableFreeBytes ?? 0))} MiB and try again.`
            : result.checkpointBusy
              ? "Database compacted. Some disk space can be reclaimed after current database reads finish."
              : `${mib(result.reclaimedBytes)} MiB reclaimed. Your projects, conversations and diagnostics are kept.`,
      );
    } catch {
      setError("Could not compact the database. Finish current tasks and try again.");
    } finally {
      setCompacting(false);
    }
  };
  return (
    <>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <SettingRow
          title="Install dependencies automatically"
          description="Each new workspace gets its own dependencies. Turn this off to save disk space, then run your package manager’s install command in a workspace when needed. Existing workspaces are kept."
        >
          <Switch
            label="Install dependencies automatically"
            checked={autoInstall ?? false}
            disabled={autoInstall === null || saving}
            onToggle={() => void toggle()}
            className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
            data-pipper-id="settings-worktree-auto-install"
          />
        </SettingRow>
        <SettingRow
          title="Reclaim unused database space"
          description="Return space freed by old records to disk. This keeps your conversations and workspaces and may take a moment."
        >
          <Button
            disabled={compacting}
            onClick={() => void compact()}
            data-pipper-id="settings-compact-database"
          >
            {compacting ? "Compacting…" : "Reclaim space"}
          </Button>
        </SettingRow>
      </Elevated>
      {compactionMessage && (
        <p className="mt-2 text-[11px] text-muted-foreground" role="status">
          {compactionMessage}
        </p>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <WorkspaceUsagePanel />
    </>
  );
}

const IDLE_MINUTE_CHOICES = [1, 2, 5, 10, 15, 30, 60];
const SAVE_DEBOUNCE_MS = 300;

function closestIndex(choices: number[], value: number): number {
  let best = 0;
  for (let i = 1; i < choices.length; i++) {
    if (Math.abs(choices[i] - value) < Math.abs(choices[best] - value)) best = i;
  }
  return best;
}

function BrowserView() {
  const [config, setConfig] = useState<BrowserConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Partial<BrowserConfig>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    window.omni.browser
      .getConfig()
      .then((value) => {
        if (!disposed) setConfig(value);
      })
      .catch(() => {
        if (!disposed) setError("Could not load browser settings.");
      });
    return () => {
      disposed = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Sliders report every step while dragging; save once they settle.
  const update = (partial: Partial<BrowserConfig>, immediate = false) => {
    setConfig((current) => (current ? { ...current, ...partial } : current));
    pending.current = { ...pending.current, ...partial };
    if (timer.current) clearTimeout(timer.current);
    const save = () => {
      const changes = pending.current;
      pending.current = {};
      setError(null);
      window.omni.browser
        .setConfig(changes)
        .then(setConfig)
        .catch(() => setError("Could not save browser settings."));
    };
    if (immediate) save();
    else timer.current = setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  const disabled = config === null;
  return (
    <>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <div className="divide-y divide-border/70">
          <SettingRow
            title="Let agents use a browser"
            description="New agent sessions get tools to open pages, read them, click, type and take screenshots. Turning this off closes open pages."
          >
            <Switch
              label="Let agents use a browser"
              checked={config?.enabled ?? false}
              disabled={disabled}
              onToggle={() => config && update({ enabled: !config.enabled }, true)}
              className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
              data-pipper-id="settings-browser-enabled"
            />
          </SettingRow>
          <SettingRow
            title="Ask before downloading"
            description="Show a prompt in the thread before a page saves a file. When off, downloads are blocked."
          >
            <Switch
              label="Ask before downloading"
              checked={config?.downloads === "ask"}
              disabled={disabled || !config?.enabled}
              onToggle={() =>
                config && update({ downloads: config.downloads === "ask" ? "block" : "ask" }, true)
              }
              className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
              data-pipper-id="settings-browser-downloads"
            />
          </SettingRow>
          <div className="px-4 py-3">
            <SliderComfortable
              value={config?.pagesPerSession ?? 4}
              onChange={(value) => update({ pagesPerSession: value })}
              min={1}
              max={8}
              step={1}
              variant="pips"
              label="Pages per session"
              formatValue={(value) => String(value)}
              disabled={disabled || !config?.enabled}
              data-pipper-id="settings-browser-pages"
            />
          </div>
          <div className="px-4 py-3">
            <SliderComfortable
              value={closestIndex(IDLE_MINUTE_CHOICES, config?.idleMinutes ?? 5)}
              onChange={(index) => update({ idleMinutes: IDLE_MINUTE_CHOICES[index] ?? 5 })}
              min={0}
              max={IDLE_MINUTE_CHOICES.length - 1}
              step={1}
              variant="pips"
              label="Close idle pages after"
              formatValue={(index) => `${IDLE_MINUTE_CHOICES[index] ?? 5} min`}
              disabled={disabled || !config?.enabled}
              data-pipper-id="settings-browser-idle"
            />
          </div>
        </div>
      </Elevated>
      {error && (
        <p className="mt-2 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <Accordion type="single" collapsible className="mt-2 w-full">
        <AccordionItem value="browser-safety">
          <AccordionTrigger>What agents can and can't open</AccordionTrigger>
          <AccordionContent>
            Each session browses in its own private storage, so agents never share cookies with each
            other or with you. Websites and local dev servers work. Local files, browser settings
            pages and Pipper itself are blocked, and camera, microphone and location requests are
            denied.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}

function RemoteView() {
  return (
    <>
      <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
        <RemoteAccessSettings />
      </Elevated>
      <Accordion type="single" collapsible className="mt-2 w-full">
        <AccordionItem value="remote-requirements">
          <AccordionTrigger>How phone access works</AccordionTrigger>
          <AccordionContent>
            Pairing codes work once and expire after 5 minutes. Each paired phone gets its own
            access, which stops working when you remove it here or after 30 days without use.
            Read-only phones can follow tasks but can't start new work.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}

export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("appearance");
  const meta = SECTION_META[section];

  return (
    <SidebarProvider defaultOpen width="15rem">
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-1 text-foreground">
        <header
          className="flex h-[52px] shrink-0 items-center justify-center border-b border-border/60 select-none"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        ></header>

        <div className="flex min-h-0 flex-1">
          <Sidebar collapsible="none" rail={false} variant="sidebar" side="left">
            <SidebarHeader></SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {NAV_ITEMS.map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          isActive={section === item.id}
                          onClick={() => setSection(item.id)}
                        >
                          {item.label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <div className="px-2 pb-1 text-[10px] leading-4 text-muted-foreground/60">
                Small preferences that shape how Pipper Code feels.
              </div>
            </SidebarFooter>
          </Sidebar>

          <SidebarInset className="bg-surface-1">
            <ScrollArea className="h-full min-h-0 flex-1" scrollFade cueSize="tight">
              <main
                className={`mx-auto w-full min-w-0 flex-1 px-7 py-8 pb-12 ${section === "design" ? "max-w-[1200px]" : "max-w-[640px]"}`}
              >
                <div className="mb-5">
                  <h1 className="text-[26px] font-semibold tracking-[-0.035em] text-foreground">
                    {meta.title}
                  </h1>
                  {meta.blurb ? (
                    <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{meta.blurb}</p>
                  ) : null}
                </div>

                {section === "design" && <WorkspaceStateGallery />}
                {section === "appearance" && <AppearanceView />}
                {section === "agents" && <AgentsSettingsSection />}
                {section === "browser" && <BrowserView />}
                {section === "accounts" && <AccountsView />}
                {section === "keyboard" && <KeyboardView />}
                {section === "power" && <PowerView />}
                {section === "storage" && <StorageView />}
                {section === "remote" && <RemoteView />}
              </main>
            </ScrollArea>
          </SidebarInset>
        </div>
      </div>
    </SidebarProvider>
  );
}
