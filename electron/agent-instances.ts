import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { app, safeStorage } from "electron";
import type {
  AcpAgentDescriptor,
  AcpAgentInstance,
  AcpAgentInstanceEnvVar,
  AcpAgentInstanceInput,
  AgentAccountSchema,
} from "../contracts/acp.ts";
import { getDb } from "./db.ts";
import { listRegisteredAgents, setInstanceDescriptorProvider } from "./agents/registry.ts";

interface AgentInstanceRow {
  id: string;
  driver_id: string;
  display_name: string;
  enabled: number;
  env_json: string | null;
  config_json: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * The environment variable that points a given CLI at an isolated credential
 * root. Providers absent from this map are isolated with explicit keys/tokens
 * instead of a directory (e.g. Cursor's CURSOR_API_KEY).
 */
export const PROFILE_ENV_BY_DRIVER: Record<string, string> = {
  "codex-acp": "CODEX_HOME",
  "claude-agent-acp": "CLAUDE_CONFIG_DIR",
  "grok-acp": "GROK_HOME",
  "copilot-acp": "COPILOT_HOME",
  "opencode-acp": "XDG_DATA_HOME",
  "antigravity-acp": "AGY_HOME",
};

/**
 * Drivers that are isolated with an explicit key/token rather than a profile
 * directory. Used to prompt for a credential when adding an account.
 */
export const AUTH_ENV_BY_DRIVER: Record<string, string> = {
  "cursor-acp": "CURSOR_API_KEY",
};

/**
 * Ambient credentials a driver may pick up from the parent environment. For a
 * non-default (isolated) account these are removed before spawn so the child
 * cannot fall back to the machine's default login instead of the account the
 * user configured.
 */
const CREDENTIAL_ENV_BY_DRIVER: Record<string, string[]> = {
  "codex-acp": ["OPENAI_API_KEY", "CODEX_API_KEY"],
  "claude-agent-acp": ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  "grok-acp": ["XAI_API_KEY"],
  "copilot-acp": ["GH_TOKEN", "GITHUB_TOKEN"],
  "cursor-acp": ["CURSOR_API_KEY"],
  "antigravity-acp": ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
};

/**
 * Interactive sign-in command per driver, run once per account inside the
 * user's terminal (never in-process) so the CLI performs its own OAuth flow
 * and owns its credentials. Drivers that authenticate purely via an API key
 * are absent. Best-effort: verify against each CLI's current docs.
 */
export const LOGIN_COMMAND_BY_DRIVER: Record<string, string> = {
  "codex-acp": "codex login",
  "claude-agent-acp": "claude auth login",
  "grok-acp": "grok login",
  "copilot-acp": "copilot",
  "opencode-acp": "opencode auth login",
  "antigravity-acp": "agy",
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command a user runs to sign an account in, with its credential
 * root exported inline. Returns null when the driver has no interactive login
 * (API-key providers) so the UI can prompt for a key instead. Windows shells
 * don't accept the POSIX `VAR=value cmd` prefix, so build `set "VAR=value" && cmd`.
 */
export function buildInstanceLoginCommand(
  instance: AcpAgentInstance,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const login = LOGIN_COMMAND_BY_DRIVER[instance.driverId];
  if (!login) return null;
  const profileVar = PROFILE_ENV_BY_DRIVER[instance.driverId];
  if (!profileVar) return login;
  const entry = (instance.env ?? []).find((item) => item.name === profileVar);
  if (!entry?.value) return login;
  if (platform === "win32") {
    // cmd has no POSIX env prefix; create the dir and set the variable first.
    return `if not exist "${entry.value}" mkdir "${entry.value}" && set "${profileVar}=${entry.value}" && ${login}`;
  }
  // Create the credential root too: some CLIs (Codex) refuse to start when the
  // directory is missing, and this must work even for accounts created before
  // the app materialized the directory.
  return `mkdir -p ${shellQuote(entry.value)} && ${profileVar}=${shellQuote(entry.value)} ${login}`;
}

function parseEnv(raw: string | null): AcpAgentInstanceEnvVar[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AcpAgentInstanceEnvVar[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed.map((entry) =>
      entry.sensitive ? { ...entry, value: decryptSecret(entry.value) } : entry,
    );
  } catch {
    return undefined;
  }
}

/** Marker for values protected with the OS keychain via `safeStorage`. */
const ENC_PREFIX = "enc:";

function encryptSecret(value: string): string {
  if (!value) return value;
  let encrypted: Buffer | null = null;
  try {
    if (safeStorage?.isEncryptionAvailable()) encrypted = safeStorage.encryptString(value);
  } catch {
    encrypted = null;
  }
  if (!encrypted) {
    // Never silently downgrade to plaintext: refuse the write instead.
    throw new Error(
      "Secure credential storage is unavailable on this device; refusing to save the secret in plaintext.",
    );
  }
  return ENC_PREFIX + encrypted.toString("base64");
}

function decryptSecret(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return "";
  }
}

/** Encrypt sensitive values before they touch disk. */
function serializeEnv(env: AcpAgentInstanceEnvVar[] | undefined): string | null {
  if (!env?.length) return null;
  return JSON.stringify(
    env.map((entry) => (entry.sensitive ? { ...entry, value: encryptSecret(entry.value) } : entry)),
  );
}

function parseConfig(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rowToInstance(row: AgentInstanceRow): AcpAgentInstance {
  return {
    id: row.id,
    driverId: row.driver_id,
    displayName: row.display_name,
    enabled: row.enabled !== 0,
    env: parseEnv(row.env_json),
    config: parseConfig(row.config_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slug(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || "account";
}

/** Redact sensitive env values before sending an instance to the renderer. */
export function redactInstance(instance: AcpAgentInstance): AcpAgentInstance {
  if (!instance.env?.some((entry) => entry.sensitive)) return instance;
  return {
    ...instance,
    env: instance.env.map((entry) => (entry.sensitive ? { ...entry, value: "" } : entry)),
  };
}

export function listAgentInstances(): AcpAgentInstance[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_instances ORDER BY driver_id ASC, created_at ASC, rowid ASC")
    .all() as unknown as AgentInstanceRow[];
  return rows.map(rowToInstance);
}

/** Renderer-facing copy with sensitive env values redacted. */
export function listAgentInstancesForRenderer(): AcpAgentInstance[] {
  return listAgentInstances().map(redactInstance);
}

export function getAgentInstance(id: string): AcpAgentInstance | null {
  const row = getDb().prepare("SELECT * FROM agent_instances WHERE id = ?").get(id) as
    | AgentInstanceRow
    | undefined;
  return row ? rowToInstance(row) : null;
}

function instanceIdFor(driverId: string, label: string): string {
  const base = `${driverId}:${slug(label)}`;
  const db = getDb();
  let candidate = base;
  let suffix = 2;
  // Ids are the spawn routing key; collisions would alias two accounts.
  while (db.prepare("SELECT 1 FROM agent_instances WHERE id = ?").get(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

/** Directory an account's CLI should treat as its isolated credential root. */
export function profileDirForInstance(driverId: string, instanceId: string): string {
  return join(app.getPath("userData"), "accounts", driverId, slug(instanceId));
}

/**
 * Codex defaults to storing its session in the OS keychain on macOS
 * (`cli_auth_credentials_store = "auto"`), which the headless ACP adapter
 * Pipper spawns cannot read — so a successful `codex login` looks
 * unauthenticated to the app. Force file storage so the login writes
 * `auth.json` inside the account's CODEX_HOME and the adapter (and probe) see
 * it. The key is top-level, so it must precede any `[section]` header.
 */
const CODEX_CRED_STORE_LINE = 'cli_auth_credentials_store = "file"';

function ensureCodexFileStore(profileDir: string): void {
  try {
    const configPath = join(profileDir, "config.toml");
    let existing = "";
    try {
      existing = readFileSync(configPath, "utf8");
    } catch {
      existing = "";
    }
    if (/^\s*cli_auth_credentials_store\s*=/m.test(existing)) return;
    const prefix = existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`;
    writeFileSync(configPath, `${CODEX_CRED_STORE_LINE}\n${prefix}`, "utf8");
  } catch {
    // Surfaced by the CLI at login/spawn time with a clearer message.
  }
}

/**
 * Some CLIs (notably Codex) refuse to start when their credential-root env var
 * points at a path that doesn't exist yet. Create it eagerly on account
 * creation and again before spawn/login so older accounts self-heal. For Codex
 * also pin file-based credential storage in the account's config.
 */
export function ensureInstanceProfileDirs(instance: AcpAgentInstance): void {
  const profileVar = PROFILE_ENV_BY_DRIVER[instance.driverId];
  const entry = profileVar
    ? (instance.env ?? []).find((item) => item.name === profileVar)
    : undefined;
  if (!entry?.value) return;
  try {
    mkdirSync(entry.value, { recursive: true });
  } catch {
    // Surfaced by the CLI at login/spawn time with a clearer message.
  }
  if (instance.driverId === "codex-acp") ensureCodexFileStore(entry.value);
}

/**
 * Pin file-based credential storage in the ambient Codex home (the default
 * account, which has no isolated profile). Only call this on an explicit user
 * action (sign-in) — never at startup or in tests — so the machine's global
 * Codex config is not touched implicitly.
 */
export function ensureAmbientCodexFileStore(): void {
  const dir = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Surfaced by the CLI at login time.
  }
  ensureCodexFileStore(dir);
}

/**
 * Default env for a fresh non-default account: point the driver's credential
 * root at a Pipper-owned directory. Returns `[]` for key/token-based providers.
 */
export function suggestProfileEnv(driverId: string, instanceId: string): AcpAgentInstanceEnvVar[] {
  const envVar = PROFILE_ENV_BY_DRIVER[driverId];
  if (!envVar) return [];
  return [{ name: envVar, value: profileDirForInstance(driverId, instanceId), sensitive: false }];
}

export function createAgentInstance(input: AcpAgentInstanceInput): AcpAgentInstance {
  const driverId = input.driverId.trim();
  if (!driverId) throw new Error("driverId is required");
  if (!listRegisteredAgents().some((driver) => driver.id === driverId)) {
    throw new Error(`Unknown driverId: ${driverId}`);
  }
  const displayName = input.displayName.trim() || driverId;
  const id = (input.id?.trim() || instanceIdFor(driverId, displayName)).trim();
  // Additional accounts default to an isolated credential root so two logins
  // of the same driver cannot share the ambient config. The default instance
  // (id === driverId) intentionally keeps the ambient login.
  const env =
    input.env && input.env.length
      ? input.env
      : id === driverId
        ? undefined
        : suggestProfileEnv(driverId, id);
  const now = Date.now();
  const row: AgentInstanceRow = {
    id,
    driver_id: driverId,
    display_name: displayName,
    enabled: input.enabled === false ? 0 : 1,
    env_json: serializeEnv(env),
    config_json: input.config ? JSON.stringify(input.config) : null,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO agent_instances (id, driver_id, display_name, enabled, env_json, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.driver_id,
      row.display_name,
      row.enabled,
      row.env_json,
      row.config_json,
      row.created_at,
      row.updated_at,
    );
  const instance = rowToInstance(row);
  ensureInstanceProfileDirs(instance);
  return instance;
}

export function updateAgentInstance(
  id: string,
  input: Partial<AcpAgentInstanceInput>,
): AcpAgentInstance | null {
  const existing = getAgentInstance(id);
  if (!existing) return null;
  const updated: AcpAgentInstance = {
    ...existing,
    displayName: input.displayName?.trim() || existing.displayName,
    enabled: input.enabled ?? existing.enabled,
    // A redacted list response carries sensitive values as ""; treat an empty
    // sensitive value as "unchanged" so a round-trip edit can't erase the
    // stored credential. Omitting the entry still removes it.
    env: input.env
      ? input.env.map((entry) => {
          if (!entry.sensitive || entry.value) return entry;
          const prior = existing.env?.find((candidate) => candidate.name === entry.name);
          return prior ? { ...entry, value: prior.value } : entry;
        })
      : existing.env,
    config: input.config ?? existing.config,
    updatedAt: Date.now(),
  };
  getDb()
    .prepare(
      `UPDATE agent_instances SET display_name = ?, enabled = ?, env_json = ?, config_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      updated.displayName,
      updated.enabled ? 1 : 0,
      serializeEnv(updated.env),
      updated.config ? JSON.stringify(updated.config) : null,
      updated.updatedAt ?? Date.now(),
      id,
    );
  ensureInstanceProfileDirs(updated);
  return updated;
}

export function deleteAgentInstance(id: string): void {
  const existing = getAgentInstance(id);
  if (!existing) return;
  // The default instance (id === driver id) is structurally required: it backs
  // the driver's ambient login and legacy thread rows.
  if (existing.id === existing.driverId) {
    throw new Error("Cannot delete a driver's default instance");
  }
  const db = getDb();
  db.exec("BEGIN IMMEDIATE;");
  try {
    // Re-point threads/snapshots that referenced the removed account at the
    // driver's default instance so they stay resolvable (and become explicit
    // rather than silently falling back to whatever resolves first).
    db.prepare("UPDATE threads SET agent_id = ? WHERE agent_id = ?").run(existing.driverId, id);
    db.prepare("UPDATE thread_snapshots SET agent_id = ? WHERE agent_id = ?").run(
      existing.driverId,
      id,
    );
    db.prepare("DELETE FROM agent_instances WHERE id = ?").run(id);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/** True once the instance table has been seeded (initialized state). */
export function hasAgentInstances(): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM agent_instances LIMIT 1").get());
}

function driverDescriptorById(): Map<string, AcpAgentDescriptor> {
  return new Map(listRegisteredAgents().map((descriptor) => [descriptor.id, descriptor]));
}

function materialize(instance: AcpAgentInstance, driver: AcpAgentDescriptor): AcpAgentDescriptor {
  const env: Record<string, string> = { ...driver.env };
  for (const entry of instance.env ?? []) {
    if (entry.name) env[entry.name] = entry.value;
  }
  const descriptor: AcpAgentDescriptor = {
    ...driver,
    id: instance.id,
    driverId: instance.driverId,
    displayName: instance.displayName,
    env,
  };
  // Isolated accounts must not inherit the machine's ambient provider keys;
  // strip them unless the account explicitly sets that same variable.
  if (instance.id !== instance.driverId) {
    const setNames = new Set((instance.env ?? []).map((entry) => entry.name));
    const unsetEnv = (CREDENTIAL_ENV_BY_DRIVER[instance.driverId] ?? []).filter(
      (name) => !setNames.has(name),
    );
    if (unsetEnv.length) descriptor.unsetEnv = unsetEnv;
  }
  return descriptor;
}

/** Resolve an instance id to a spawnable descriptor with merged env. */
export function resolveAgentInstanceDescriptor(instanceId: string): AcpAgentDescriptor | null {
  const instance = getAgentInstance(instanceId);
  if (!instance || !instance.enabled) return null;
  const driver = driverDescriptorById().get(instance.driverId);
  if (!driver) return null;
  // Self-heal the credential root for accounts created before dirs were
  // materialized, so the CLI doesn't refuse to start.
  ensureInstanceProfileDirs(instance);
  return materialize(instance, driver);
}

/** Every enabled instance as a descriptor, for agent/account pickers. */
export function listAgentInstanceDescriptors(): AcpAgentDescriptor[] {
  const drivers = driverDescriptorById();
  const out: AcpAgentDescriptor[] = [];
  for (const instance of listAgentInstances()) {
    if (!instance.enabled) continue;
    const driver = drivers.get(instance.driverId);
    if (!driver) continue;
    out.push(materialize(instance, driver));
  }
  return out;
}

/** Per-driver account-creation capabilities, for the settings UI. */
export function listAgentAccountSchemas(): AgentAccountSchema[] {
  return listRegisteredAgents().map((driver) => ({
    driverId: driver.id,
    displayName: driver.displayName,
    icon: driver.icon,
    profileEnvVar: PROFILE_ENV_BY_DRIVER[driver.id] ?? null,
    authEnvVar: AUTH_ENV_BY_DRIVER[driver.id] ?? null,
    supportsMultipleAccounts: Boolean(
      PROFILE_ENV_BY_DRIVER[driver.id] ?? AUTH_ENV_BY_DRIVER[driver.id],
    ),
    supportsLogin: Boolean(LOGIN_COMMAND_BY_DRIVER[driver.id]),
  }));
}

/**
 * Backfill the required default instance for every known driver. The default
 * instance reuses the driver id so existing threads, selections, and ambient
 * CLI logins keep working with no migration.
 */
export function ensureDefaultAgentInstances(): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agent_instances (id, driver_id, display_name, enabled, env_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, NULL, NULL, ?, ?)`,
  );
  const now = Date.now();
  for (const driver of listRegisteredAgents()) {
    insert.run(driver.id, driver.id, driver.displayName, now, now);
  }
}

/**
 * Seed defaults and register the instance resolver with the registry. Call
 * once after the database is ready (agent-instances.ts owns the only writer).
 */
export function installAgentInstanceProvider(): void {
  ensureDefaultAgentInstances();
  // Materialize credential roots for every existing account so a directory
  // missed by an earlier version doesn't make the CLI refuse to start.
  for (const instance of listAgentInstances()) {
    ensureInstanceProfileDirs(instance);
  }
  setInstanceDescriptorProvider((instanceId) => resolveAgentInstanceDescriptor(instanceId));
}
