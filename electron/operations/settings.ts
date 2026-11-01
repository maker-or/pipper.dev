import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AgentTaskConfig } from "../../contracts/agent-tasks.ts";
import type { BrowserConfig } from "../../contracts/acp.ts";
import { CONNECTOR_CATALOG } from "../../contracts/connector-catalog.ts";
import type { ConnectorSnapshot } from "../../contracts/connectors.ts";
import type { SettingChange, SettingChangeRecord, SettingValue } from "../../contracts/settings.ts";
import { defineOperation, OperationInputError, type Grant } from "./define.ts";

/**
 * Pipper's settings as agents see them: one object grouped by area, each
 * setting with its bounds, whether a change widens what agents can do (the
 * `grant` tier: the user confirms), and when it applies. The renderer's own
 * settings (theme, tab swipe) aren't here yet. See docs/capabilities/design.md.
 */

export interface SettingsDeps {
  getAgentTasks(): AgentTaskConfig;
  setAgentTasks(partial: Partial<AgentTaskConfig>): Promise<AgentTaskConfig>;
  getBrowser(): BrowserConfig;
  setBrowser(partial: Partial<BrowserConfig>): Promise<BrowserConfig>;
  getAutoInstall(): boolean;
  setAutoInstall(enabled: boolean): void;
  /** The user's connectors; absent until they load (and in tests that skip them). */
  connectors?: {
    list(): ConnectorSnapshot[];
    setEnabled(id: string, enabled: boolean): void;
  };
  changes: SettingChangeStore;
}

let deps: SettingsDeps | null = null;

export function configureSettingsOperations(next: SettingsDeps | null): void {
  deps = next;
}

function requireDeps(): SettingsDeps {
  if (!deps) throw new Error("Settings aren't ready yet.");
  return deps;
}

type Area = "agent_tasks" | "browser" | "workspaces";

interface SettingDef {
  area: Area;
  key: string;
  label: string;
  schema: z.ZodType<SettingValue>;
  get(d: SettingsDeps): SettingValue;
  set(d: SettingsDeps, value: SettingValue): Promise<void>;
  /** True when going from `from` to `to` lets agents do more. */
  widens(from: SettingValue, to: SettingValue): boolean;
  format(value: SettingValue): string;
  applies: "now" | "new_threads";
}

const onOff = (value: SettingValue) => (value ? "on" : "off");
const turnedOn = (from: SettingValue, to: SettingValue) => !from && Boolean(to);
const raised = (from: SettingValue, to: SettingValue) => Number(to) > Number(from);
const count = (unit: string) => (value: SettingValue) =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;
const int = (min: number, max: number, about: string) =>
  z.number().int().min(min).max(max).describe(about) as z.ZodType<SettingValue>;

function agentTask<K extends keyof AgentTaskConfig>(
  configKey: K,
  def: Omit<SettingDef, "area" | "get" | "set">,
): SettingDef {
  return {
    ...def,
    area: "agent_tasks",
    get: (d) => d.getAgentTasks()[configKey] as SettingValue,
    set: async (d, value) => {
      await d.setAgentTasks({ [configKey]: value } as Partial<AgentTaskConfig>);
    },
  };
}

function browser<K extends keyof BrowserConfig>(
  configKey: K,
  def: Omit<SettingDef, "area" | "get" | "set">,
): SettingDef {
  return {
    ...def,
    area: "browser",
    get: (d) => d.getBrowser()[configKey] as SettingValue,
    set: async (d, value) => {
      await d.setBrowser({ [configKey]: value } as Partial<BrowserConfig>);
    },
  };
}

export const SETTINGS: SettingDef[] = [
  agentTask("enabled", {
    key: "enabled",
    label: "Pipper tools for agents",
    schema: z
      .boolean()
      .describe("Pipper's thread, workspace and settings tools.") as z.ZodType<SettingValue>,
    widens: turnedOn,
    format: onOff,
    applies: "new_threads",
  }),
  agentTask("allowedAgents", {
    key: "allowed_agents",
    label: "Agents that can run subthreads",
    schema: z
      .union([z.literal("all"), z.array(z.string().min(1))])
      .describe('"all" installed agents, or a list of agent ids.') as z.ZodType<SettingValue>,
    widens: (from, to) =>
      to === "all"
        ? from !== "all"
        : from !== "all" && (to as string[]).some((id) => !(from as string[]).includes(id)),
    format: (value) => (value === "all" ? "all agents" : (value as string[]).join(", ") || "none"),
    applies: "now",
  }),
  agentTask("startApproval", {
    key: "start_approval",
    label: "Starting subthreads",
    schema: z
      .enum(["ask", "allow"])
      .describe('"ask": the user approves each start.') as z.ZodType<SettingValue>,
    widens: (from, to) => from === "ask" && to === "allow",
    format: (value) => (value === "ask" ? "ask first" : "allowed"),
    applies: "now",
  }),
  agentTask("childPermissions", {
    key: "child_permissions",
    label: "Subthread permissions",
    schema: z
      .enum(["ask", "workspace"])
      .describe(
        '"workspace": a subthread reads and edits in its own workspace without asking.',
      ) as z.ZodType<SettingValue>,
    widens: (from, to) => from === "ask" && to === "workspace",
    format: (value) => (value === "ask" ? "ask for everything" : "free in own workspace"),
    applies: "now",
  }),
  agentTask("maxRunningPerThread", {
    key: "max_running_per_thread",
    label: "Running subthreads per thread",
    schema: int(1, 8, "Running subthreads one thread may have."),
    widens: raised,
    format: String,
    applies: "now",
  }),
  agentTask("maxRunningTotal", {
    key: "max_running_total",
    label: "Running subthreads in total",
    schema: int(1, 16, "Running subthreads across Pipper."),
    widens: raised,
    format: String,
    applies: "now",
  }),
  agentTask("maxDepth", {
    key: "max_depth",
    label: "Subthread depth",
    schema: int(1, 3, "How deep subthreads may nest."),
    widens: raised,
    format: count("level"),
    applies: "now",
  }),
  agentTask("maxAutomatedTurns", {
    key: "max_automated_turns",
    label: "Automated turns in a row",
    schema: int(1, 20, "Parent turns notes may start before they pause for the user."),
    widens: raised,
    format: String,
    applies: "now",
  }),
  {
    area: "agent_tasks",
    key: "turn_timeout_minutes",
    label: "Subthread turn limit",
    schema: int(1, 120, "Minutes one subthread turn may run before Pipper stops it."),
    get: (d) => Math.round(d.getAgentTasks().turnTimeoutMs / 60_000),
    set: async (d, value) => {
      await d.setAgentTasks({ turnTimeoutMs: Number(value) * 60_000 });
    },
    widens: raised,
    format: count("minute"),
    applies: "now",
  },
  agentTask("notifyParent", {
    key: "notify_parent",
    label: "Notes when a subthread stops",
    schema: z.boolean() as z.ZodType<SettingValue>,
    widens: () => false,
    format: onOff,
    applies: "now",
  }),
  browser("enabled", {
    key: "enabled",
    label: "Browser for agents",
    schema: z.boolean().describe("Offer browser tools to agents.") as z.ZodType<SettingValue>,
    widens: turnedOn,
    format: onOff,
    applies: "new_threads",
  }),
  browser("pagesPerSession", {
    key: "pages_per_session",
    label: "Browser pages per thread",
    schema: int(1, 8, "Pages one thread may have open."),
    widens: raised,
    format: count("page"),
    applies: "now",
  }),
  browser("idleMinutes", {
    key: "idle_minutes",
    label: "Close idle browser pages after",
    schema: int(1, 60, "Minutes without a tool call before a page closes."),
    widens: raised,
    format: count("minute"),
    applies: "now",
  }),
  browser("downloads", {
    key: "downloads",
    label: "Browser downloads",
    schema: z
      .enum(["ask", "block"])
      .describe(
        '"ask" prompts the user before a page downloads a file.',
      ) as z.ZodType<SettingValue>,
    widens: (from, to) => from === "block" && to === "ask",
    format: (value) => (value === "ask" ? "ask first" : "blocked"),
    applies: "now",
  }),
  {
    area: "workspaces",
    key: "install_dependencies",
    label: "Install dependencies in new workspaces",
    schema: z.boolean() as z.ZodType<SettingValue>,
    get: (d) => d.getAutoInstall(),
    set: async (d, value) => d.setAutoInstall(Boolean(value)),
    widens: () => false,
    format: onOff,
    applies: "now",
  },
];

const AREAS: Area[] = ["agent_tasks", "browser", "workspaces"];

const pathOf = (def: SettingDef) => `${def.area}.${def.key}`;

type ConnectorsUpdate = Record<string, { enabled: boolean }>;

type SettingsUpdate = Partial<Record<Area, Record<string, SettingValue | undefined>>> & {
  connectors?: ConnectorsUpdate;
};

export const SETTINGS_UPDATE_INPUT = z.strictObject({
  ...Object.fromEntries(
    AREAS.map((area) => [
      area,
      z
        .strictObject(
          Object.fromEntries(
            SETTINGS.filter((def) => def.area === area).map((def) => [
              def.key,
              def.schema.optional(),
            ]),
          ),
        )
        .optional(),
    ]),
  ),
  connectors: z
    .record(z.string().min(1), z.strictObject({ enabled: z.boolean() }))
    .optional()
    .describe("Turn connectors on or off, by the ids get_settings lists. Applies to new threads."),
}) as z.ZodType<SettingsUpdate>;

function sameValue(a: SettingValue, b: SettingValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface PlannedChange {
  change: SettingChange;
  apply(): Promise<void>;
}

const CONNECTOR_PATH = /^connectors\.(.+)\.enabled$/;

function requireConnectors(d: SettingsDeps): NonNullable<SettingsDeps["connectors"]> {
  if (!d.connectors) throw new OperationInputError("Connectors aren't ready yet.");
  return d.connectors;
}

/** Turning connectors on or off: `connectors.<id>.enabled`. */
function planConnectors(d: SettingsDeps, input: ConnectorsUpdate): PlannedChange[] {
  const connectors = requireConnectors(d);
  const all = connectors.list();
  return Object.entries(input).flatMap(([id, { enabled }]) => {
    const connector = all.find((candidate) => candidate.id === id);
    if (!connector) {
      throw new OperationInputError(
        `No connector with id "${id}". Connector ids: ${all.map((c) => c.id).join(", ") || "none"}.`,
      );
    }
    if (connector.enabled === enabled) return [];
    return [
      {
        change: {
          path: `connectors.${id}.enabled`,
          label: `${connector.name} connector`,
          from: connector.enabled,
          to: enabled,
          fromText: onOff(connector.enabled),
          toText: onOff(enabled),
          widens: enabled,
          applies: "new_threads" as const,
        },
        apply: async () => connectors.setEnabled(id, enabled),
      },
    ];
  });
}

/** The changes an update would make, skipping settings already at that value. */
function plan(d: SettingsDeps, input: SettingsUpdate): PlannedChange[] {
  const out: PlannedChange[] = [];
  for (const def of SETTINGS) {
    const to = input[def.area]?.[def.key];
    if (to === undefined) continue;
    const from = def.get(d);
    if (sameValue(from, to)) continue;
    out.push({
      apply: () => def.set(d, to),
      change: {
        path: pathOf(def),
        label: def.label,
        from,
        to,
        fromText: def.format(from),
        toText: def.format(to),
        widens: def.widens(from, to),
        applies: def.applies,
      },
    });
  }
  if (input.connectors) out.push(...planConnectors(d, input.connectors));
  return out;
}

/**
 * The user's connectors as agents see them: never a key, token or `env`
 * value. `status`: connected, needs_sign_in, error, not_checked, or local (a
 * server the agent starts itself, so Pipper can't tell).
 */
function connectorsView(d: SettingsDeps) {
  const connectors = d.connectors?.list() ?? [];
  const added = new Set(connectors.map((connector) => connector.catalogId));
  return {
    connectors: Object.fromEntries(
      connectors.map((connector) => [
        connector.id,
        {
          name: connector.name,
          catalog: connector.catalogId,
          kind: connector.transport === "stdio" ? "local" : "remote",
          enabled: connector.enabled,
          status:
            connector.transport === "stdio"
              ? "local"
              : connector.status === "unknown"
                ? "not_checked"
                : connector.status,
          tools: connector.transport === "stdio" ? null : connector.tools.length,
        },
      ]),
    ),
    connector_catalog: CONNECTOR_CATALOG.filter((entry) => !added.has(entry.id)).map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      sign_in: entry.auth.kind === "oauth" ? "browser" : entry.auth.kind,
    })),
  };
}

/** Every setting's current value, grouped by area. */
export function currentSettings(
  d: SettingsDeps = requireDeps(),
): Record<Area, Record<string, SettingValue>> {
  const out = Object.fromEntries(AREAS.map((area) => [area, {}])) as Record<
    Area,
    Record<string, SettingValue>
  >;
  for (const def of SETTINGS) out[def.area][def.key] = def.get(d);
  return out;
}

export const getSettings = defineOperation({
  id: "settings.get",
  tier: "read",
  input: z.strictObject({}),
  async run() {
    return { ...currentSettings(), ...connectorsView(requireDeps()) };
  },
});

export interface SettingsUpdateResult {
  /** Null when nothing changed. */
  changeId: string | null;
  changes: SettingChange[];
}

export const updateSettings = defineOperation({
  id: "settings.update",
  tier: "local",
  input: SETTINGS_UPDATE_INPUT,

  async grant(input): Promise<Grant | null> {
    const widening = plan(requireDeps(), input).filter(({ change }) => change.widens);
    if (widening.length === 0) return null;
    return {
      title: "Change Pipper settings",
      changes: widening.map(
        ({ change }) => `${change.label}: ${change.fromText} → ${change.toText}`,
      ),
    };
  },

  async run(input, ctx): Promise<SettingsUpdateResult> {
    const d = requireDeps();
    const planned = plan(d, input);
    for (const { apply } of planned) await apply();
    const changes = planned.map(({ change }) => change);
    if (changes.length === 0 || ctx.caller.kind !== "agent") {
      return { changeId: null, changes };
    }
    const record = d.changes.insert(ctx.caller.threadId, changes);
    return { changeId: record.changeId, changes };
  },
});

/** The user's undo on a settings-change line: put every setting back. */
export const undoSettingsChange = defineOperation({
  id: "settings.undo",
  tier: "local",
  input: z.strictObject({ change: z.string().min(1) }),
  async run({ change }, ctx): Promise<SettingChangeRecord> {
    if (ctx.caller.kind !== "user") {
      throw new OperationInputError("Only the user can undo a settings change.");
    }
    const d = requireDeps();
    const record = d.changes.get(change);
    if (!record) throw new OperationInputError("That settings change no longer exists.");
    if (record.undone) return record;
    for (const item of record.changes) {
      const connector = CONNECTOR_PATH.exec(item.path);
      if (connector) {
        // A connector removed since then has nothing to put back.
        const connectors = requireConnectors(d);
        if (connectors.list().some((candidate) => candidate.id === connector[1])) {
          connectors.setEnabled(connector[1]!, Boolean(item.from));
        }
        continue;
      }
      const def = SETTINGS.find((candidate) => pathOf(candidate) === item.path);
      if (def) await def.set(d, item.from);
    }
    d.changes.markUndone(change);
    return d.changes.get(change)!;
  },
});

export function ensureSettingChangeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setting_changes (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      changes TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
}

interface RawChange {
  id: string;
  thread_id: string;
  changes: string;
  undone: number;
  created_at: number;
}

/** Settings changes agents made, for the line in their thread and its undo. */
export class SettingChangeStore {
  private readonly db: () => DatabaseSync;

  constructor(db: () => DatabaseSync) {
    this.db = db;
  }

  insert(threadId: string, changes: SettingChange[], now = Date.now()): SettingChangeRecord {
    const id = randomUUID();
    this.db()
      .prepare(
        "INSERT INTO setting_changes (id, thread_id, changes, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, threadId, JSON.stringify(changes), now);
    return this.get(id)!;
  }

  get(id: string): SettingChangeRecord | null {
    const raw = this.db().prepare("SELECT * FROM setting_changes WHERE id = ?").get(id) as
      | RawChange
      | undefined;
    if (!raw) return null;
    return {
      changeId: raw.id,
      threadId: raw.thread_id,
      changes: JSON.parse(raw.changes) as SettingChange[],
      undone: raw.undone === 1,
      createdAt: raw.created_at,
    };
  }

  markUndone(id: string): void {
    this.db().prepare("UPDATE setting_changes SET undone = 1 WHERE id = ?").run(id);
  }
}
