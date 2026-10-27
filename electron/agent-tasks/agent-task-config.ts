import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTaskConfig } from "../../contracts/agent-tasks.ts";

const FILE_NAME = "agent-tasks.json";

export const DEFAULT_AGENT_TASK_CONFIG: AgentTaskConfig = {
  enabled: true,
  allowedAgents: "all",
  maxRunningPerThread: 4,
  maxRunningTotal: 8,
  maxDepth: 1,
  startApproval: "ask",
  childPermissions: "workspace",
  turnTimeoutMs: 30 * 60_000,
  notifyParent: true,
  maxAutomatedTurns: 5,
};

export function agentTaskConfigPath(baseDir?: string): string {
  return join(baseDir ?? app.getPath("userData"), FILE_NAME);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/** Coerce arbitrary JSON into a valid config; unknown fields are dropped. */
export function sanitizeAgentTaskConfig(raw: unknown): AgentTaskConfig {
  const parsed = (raw ?? {}) as Partial<Record<keyof AgentTaskConfig, unknown>>;
  const defaults = DEFAULT_AGENT_TASK_CONFIG;
  const allowedAgents =
    parsed.allowedAgents === "all"
      ? ("all" as const)
      : Array.isArray(parsed.allowedAgents)
        ? parsed.allowedAgents.filter((id): id is string => typeof id === "string")
        : defaults.allowedAgents;
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
    allowedAgents,
    maxRunningPerThread: clamp(parsed.maxRunningPerThread, 1, 8, defaults.maxRunningPerThread),
    maxRunningTotal: clamp(parsed.maxRunningTotal, 1, 16, defaults.maxRunningTotal),
    maxDepth: clamp(parsed.maxDepth, 1, 3, defaults.maxDepth),
    startApproval: oneOf(parsed.startApproval, ["ask", "allow"], defaults.startApproval),
    childPermissions: oneOf(
      parsed.childPermissions,
      ["ask", "workspace"],
      defaults.childPermissions,
    ),
    turnTimeoutMs: clamp(parsed.turnTimeoutMs, 60_000, 120 * 60_000, defaults.turnTimeoutMs),
    notifyParent:
      typeof parsed.notifyParent === "boolean" ? parsed.notifyParent : defaults.notifyParent,
    maxAutomatedTurns: clamp(parsed.maxAutomatedTurns, 1, 20, defaults.maxAutomatedTurns),
  };
}

export async function readAgentTaskConfig(baseDir?: string): Promise<AgentTaskConfig> {
  try {
    const raw = await readFile(agentTaskConfigPath(baseDir), "utf-8");
    return sanitizeAgentTaskConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AGENT_TASK_CONFIG };
  }
}

export async function writeAgentTaskConfig(
  config: Partial<AgentTaskConfig>,
  baseDir?: string,
): Promise<AgentTaskConfig> {
  const current = await readAgentTaskConfig(baseDir);
  const next = sanitizeAgentTaskConfig({ ...current, ...config });
  const path = agentTaskConfigPath(baseDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
