import type * as acp from "@agentclientprotocol/sdk";

/**
 * Every Pipper thread runs with its harness's full auto-approve ("YOLO")
 * setting. Each harness names it differently, so this records, per driver,
 * how to turn it on:
 *
 * - `option`: the session config option (and value) to set after every
 *   `session/new`, `session/load` and `session/resume`. Agents that only
 *   report ACP `modes` take the same id through `session/set_mode`.
 * - `applyFullAccessEnv`: spawn environment, for opencode.
 * - `approvePrompts`: Pipper allows the harness's permission requests itself,
 *   for whatever its own setting still asks about.
 *
 * Mode ids come from each agent's `session/new` result (Gemini's from its
 * ACP source). Cursor and Grok take a launch flag instead, in their args in
 * `registry.ts` and `config.json`: `agent --yolo acp` (Cursor's `--force`,
 * "run everything") and `grok agent --always-approve stdio`. Cursor's ACP
 * server still asks before every web search whatever its settings, so Pipper
 * answers those.
 */
interface FullAccessProfile {
  option?: { configId: string; value: string };
  approvePrompts?: boolean;
}

const PROFILES: Record<string, FullAccessProfile> = {
  "claude-agent-acp": { option: { configId: "mode", value: "bypassPermissions" } },
  "codex-acp": { option: { configId: "mode", value: "agent-full-access" } },
  "devin-acp": { option: { configId: "mode", value: "bypass" } },
  "antigravity-acp": { option: { configId: "mode", value: "yolo" } },
  "gemini-acp": { option: { configId: "mode", value: "yolo" } },
  // Copilot's `autopilot` mode also changes how long it runs; `allow_all` only
  // stops the prompts.
  "copilot-acp": { option: { configId: "allow_all", value: "on" } },
  // Cursor's ACP modes are agent/plan/ask, and opencode's build/plan: neither
  // has an auto-approve one.
  "cursor-acp": { approvePrompts: true },
  // `opencode acp` takes no `--auto`. See `fullAccessEnv` for its setting.
  "opencode-acp": { approvePrompts: true },
  "grok-acp": { approvePrompts: true },
};

export function fullAccessOption(driverId: string): { configId: string; value: string } | null {
  return PROFILES[driverId]?.option ?? null;
}

/**
 * Put a harness in full access through its spawn environment. opencode reads
 * `OPENCODE_CONFIG_CONTENT` last of the user's configs, and its rules are
 * last-match-wins, so `"permission": "allow"` there outranks the asks it
 * ships (`external_directory`, `doom_loop`, `.env` reads) and the user's own
 * opencode.json, for Pipper's process only. Inline config the user already
 * set is kept.
 */
export function applyFullAccessEnv(driverId: string, env: Record<string, string>): void {
  if (driverId !== "opencode-acp") return;
  let inline: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      inline = parsed as Record<string, unknown>;
    }
  } catch {
    /* unreadable inline config: replace it */
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...inline, permission: "allow" });
}

/**
 * Pipper's own answer to a permission request from a driver that has no
 * auto-approve setting: the allow option, once. Null for every other driver,
 * and when the request offers no allow option.
 */
export function fullAccessPermissionResponse(
  driverId: string,
  params: acp.RequestPermissionRequest,
): acp.RequestPermissionResponse | null {
  if (!PROFILES[driverId]?.approvePrompts) return null;
  const options = params.options ?? [];
  const allow =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : null;
}
