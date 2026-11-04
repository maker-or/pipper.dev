import { existsSync, readFileSync, accessSync, constants, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { antigravityRelease, installedAntigravityPath } from "./antigravity-official.ts";
import { applyFullAccessEnv } from "./full-access.ts";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";

interface RegistryFile {
  agents: AcpAgentDescriptor[];
  defaultAgentId?: string;
}

/** Directory of this module (avoid naming `__dirname` — electron-vite injects that). */
const registryDir = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves a *provider instance* id (e.g. `codex-acp:work`) to a materialized
 * descriptor whose `id` is the instance id and whose `env` carries the
 * instance's isolated credential root. Installed by `agent-instances.ts` at
 * startup so this module stays free of a database dependency (and stays
 * unit-testable).
 */
export type AgentInstanceDescriptorProvider = (instanceId: string) => AcpAgentDescriptor | null;
let instanceDescriptorProvider: AgentInstanceDescriptorProvider | null = null;

export function setInstanceDescriptorProvider(
  provider: AgentInstanceDescriptorProvider | null,
): void {
  instanceDescriptorProvider = provider;
}

/** The driver id behind a descriptor (instance descriptors carry `driverId`). */
export function descriptorDriverId(descriptor: AcpAgentDescriptor): string {
  return descriptor.driverId ?? descriptor.id;
}

/** Built-in catalog — used when config.json is missing or incomplete. */
export const BUILTIN_ACP_AGENTS: AcpAgentDescriptor[] = [
  {
    id: "cursor-acp",
    name: "cursor",
    displayName: "Cursor",
    description: "Cursor CLI agent over ACP (stdio JSON-RPC).",
    command: "agent",
    args: ["--yolo", "acp"],
    icon: "cursor",
    docsUrl: "https://cursor.com/docs/cli/acp",
    authHint: "Run `agent login` in your terminal (or set CURSOR_API_KEY) before connecting.",
    installHint:
      "Install the Cursor CLI (no GUI needed): `curl https://cursor.com/install -fsS | bash`, then ensure `agent` is on your PATH.",
    installKind: "binary",
    detectCommands: ["agent"],
  },
  {
    id: "codex-acp",
    name: "codex-cli",
    displayName: "Codex",
    description: "OpenAI Codex via the official ACP adapter.",
    command: "codex-acp",
    args: [],
    icon: "openai-codex",
    docsUrl: "https://github.com/agentclientprotocol/codex-acp",
    authHint:
      "Run `codex` once and choose Sign in with ChatGPT (or set CODEX_API_KEY / OPENAI_API_KEY).",
    installHint:
      "Install the Codex CLI (no GUI needed): `curl -fsSL https://chatgpt.com/codex/install.sh | sh`, then run `codex` once to sign in. Pipper connects over ACP automatically.",
    installKind: "npx",
    npmPackage: "@agentclientprotocol/codex-acp",
    detectCommands: ["codex-acp"],
  },
  {
    id: "claude-agent-acp",
    name: "claude-code",
    displayName: "Claude",
    description: "Claude Agent SDK via the official ACP adapter.",
    command: "npx",
    args: [],
    icon: "anthropic",
    docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    authHint: "Run `claude` once and complete the login prompt (or set ANTHROPIC_API_KEY).",
    installHint:
      "Install the Claude CLI (no GUI needed): `curl -fsSL https://claude.ai/install.sh | bash` (native install auto-updates). Pipper connects over ACP automatically.",
    installKind: "npx",
    npmPackage: "@agentclientprotocol/claude-agent-acp",
    detectCommands: ["claude-agent-acp"],
  },
  {
    id: "opencode-acp",
    name: "opencode",
    displayName: "opencode",
    description: "opencode CLI in ACP mode (stdio JSON-RPC).",
    command: "opencode",
    args: ["acp"],
    icon: "opencode",
    docsUrl: "https://opencode.ai/docs/acp/",
    authHint: "Run `opencode auth login` to configure a provider before connecting.",
    installHint: "npm install -g opencode-ai  (or use npx on first launch)",
    installKind: "npx",
    npmPackage: "opencode-ai",
    detectCommands: ["opencode"],
  },
  {
    id: "grok-acp",
    name: "grok",
    displayName: "Grok",
    description: "Grok Build CLI in ACP mode (stdio JSON-RPC).",
    command: "grok",
    args: ["agent", "--always-approve", "stdio"],
    icon: "xai",
    docsUrl: "https://www.npmjs.com/package/@xai-official/grok",
    authHint:
      "Run `grok login` to sign in via browser (or `grok login --device-auth` on headless machines).",
    installHint:
      "Install the Grok CLI (no GUI needed): `curl -fsSL https://x.ai/cli/install.sh | bash`, then verify with `grok --version`.",
    installKind: "npx",
    npmPackage: "@xai-official/grok",
    detectCommands: ["grok"],
  },
  {
    id: "gemini-acp",
    name: "gemini-cli",
    displayName: "Gemini",
    description: "Gemini CLI in ACP mode (stdio JSON-RPC).",
    command: "gemini",
    args: ["--acp"],
    icon: "gemini",
    docsUrl: "https://geminicli.com/docs/cli/acp-mode/",
    authHint: "Sign in with your Google account on first run (or set GEMINI_API_KEY).",
    installHint: "npm install -g @google/gemini-cli  (or use npx on first launch)",
    installKind: "npx",
    npmPackage: "@google/gemini-cli",
    detectCommands: ["gemini"],
  },
  {
    id: "copilot-acp",
    name: "copilot-cli",
    displayName: "Copilot",
    description: "GitHub Copilot CLI as an ACP server (stdio JSON-RPC).",
    command: "copilot",
    args: ["--acp", "--stdio"],
    icon: "github-copilot",
    docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
    authHint: "Run `copilot` once to sign in with GitHub before connecting.",
    installHint: "npm install -g @github/copilot  (or use npx on first launch)",
    installKind: "npx",
    npmPackage: "@github/copilot",
    detectCommands: ["copilot"],
  },
  {
    id: "antigravity-acp",
    name: "antigravity",
    displayName: "Antigravity",
    description: "Google's official ACP agent, installed into Pipper's cache on first use.",
    command: "agy_acp_server.par",
    args: [],
    icon: "antigravity",
    docsUrl: "https://antigravity.google/docs/ide/extensions/zed/",
    authHint: "Sign in to Google Antigravity to continue.",
    installHint: "Pipper downloads Google's official ACP server on first use.",
    installKind: "binary",
    detectCommands: ["agy_acp_server.par", "agy_acp_server.exe"],
  },
  {
    id: "devin-acp",
    name: "devin",
    displayName: "Devin",
    description: "Devin CLI in ACP mode (stdio JSON-RPC).",
    command: "devin",
    args: ["acp"],
    icon: "devin",
    docsUrl: "https://docs.devin.ai/desktop/acp",
    authHint: "Run `/login` inside a `devin` session to authenticate before connecting.",
    installHint: "Install the Devin CLI, then ensure `devin` is on your PATH.",
    installKind: "binary",
    detectCommands: ["devin"],
  },
  {
    id: "pipper-mock",
    name: "pipper-mock",
    displayName: "Pipper Mock",
    description: "Local mock ACP agent for development and tests.",
    command: "node",
    args: [],
    icon: "robot",
    installKind: "mock",
    installHint: "Bundled with Pipper — always available.",
  },
];

function loadRegistryFile(): RegistryFile {
  const candidates = [
    join(registryDir, "config.json"),
    join(process.cwd(), "electron/agents/config.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as RegistryFile;
      if (Array.isArray(parsed.agents) && parsed.agents.length > 0) {
        return parsed;
      }
    } catch {
      // try next
    }
  }
  return {
    agents: BUILTIN_ACP_AGENTS,
    defaultAgentId: "cursor-acp",
  };
}

function pathDirs(): string[] {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const extras = [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".cursor", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  return [...new Set([...parts, ...extras])];
}

/** Resolve a binary on PATH (and common install locations). */
export function findExecutableOnPath(command: string): string | null {
  if (!command) return null;
  // Absolute path
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      if (existsSync(command)) return command;
      return null;
    }
  }

  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const candidate = join(dir, ext ? `${command}${ext.toLowerCase()}` : command);
      const alt = join(dir, ext ? `${command}${ext}` : command);
      for (const path of [candidate, alt]) {
        if (!existsSync(path)) continue;
        try {
          accessSync(path, constants.X_OK);
          return path;
        } catch {
          // On Windows, existence may be enough for .cmd/.bat
          if (process.platform === "win32") return path;
        }
      }
    }
  }

  // `which` fallback
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(whichCmd, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (out && existsSync(out)) return out;
  } catch {
    // not found
  }
  return null;
}

function hasNpx(): boolean {
  return Boolean(findExecutableOnPath("npx") || findExecutableOnPath("npm"));
}

/**
 * Multiple unrelated CLIs install a binary literally named `agent` (e.g. Grok's CLI).
 * A bare PATH lookup can silently resolve to one of those instead of Cursor's CLI,
 * which then hangs forever because it doesn't speak ACP. Guard against that by only
 * trusting a candidate whose real (symlink-resolved) path identifies it as Cursor's.
 */
function looksLikeCursorAgentBinary(path: string): boolean {
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // not a symlink, or unreadable — fall back to the given path
  }
  return /cursor/i.test(resolved);
}

/** Find every `agent` on PATH, in PATH order, and return the first that is actually Cursor's CLI. */
function findCursorAgentBinary(): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const dir of pathDirs()) {
    for (const ext of exts) {
      for (const name of [`agent${ext.toLowerCase()}`, `agent${ext}`]) {
        const candidate = join(dir, name);
        if (!existsSync(candidate)) continue;
        try {
          accessSync(candidate, constants.X_OK);
        } catch {
          if (process.platform !== "win32") continue;
        }
        if (looksLikeCursorAgentBinary(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Probe availability for one catalog entry. */
export function probeAgentAvailability(agent: AcpAgentDescriptor): AcpAgentDescriptor {
  const base: AcpAgentDescriptor = {
    ...agent,
    args: agent.args ?? [],
  };

  if (base.installKind === "mock" || base.id === "pipper-mock") {
    return {
      ...base,
      available: true,
      resolvedCommand: "node",
      statusMessage: null,
    };
  }

  if (base.id === "antigravity-acp") {
    const release = antigravityRelease();
    return {
      ...base,
      available: Boolean(release),
      resolvedCommand: installedAntigravityPath(),
      statusMessage: release
        ? "Google's official ACP server downloads to Pipper's cache on first use."
        : `Official Antigravity ACP is not supported on ${process.platform} ${process.arch}.`,
    };
  }

  // Cursor's CLI binary is literally named `agent`, a name other unrelated CLIs also
  // install (e.g. Grok). A generic PATH lookup can silently pick one of those instead,
  // which then hangs forever because it doesn't speak ACP — so resolve it separately
  // with a check that the candidate is actually Cursor's CLI.
  if (base.id === "cursor-acp") {
    const found = findCursorAgentBinary();
    if (found) {
      return {
        ...base,
        available: true,
        command: found,
        args: ["--yolo", "acp"],
        resolvedCommand: found,
        statusMessage: null,
      };
    }
    return {
      ...base,
      available: false,
      resolvedCommand: null,
      statusMessage: base.installHint ?? `Install ${base.displayName} and ensure it is on PATH.`,
    };
  }

  // Prefer a globally installed binary when listed in detectCommands.
  // `base.args` holds the flags needed to enter ACP mode (e.g. `["--acp"]` for
  // Gemini, `[]` for adapters that speak ACP by default) — reused as-is here,
  // and prefixed with `-y <pkg>` below for the npx fallback.
  const detectList = base.detectCommands?.length ? base.detectCommands : [base.command];
  for (const cmd of detectList) {
    if (cmd === "npx" || cmd === "npm") continue;
    const found = findExecutableOnPath(cmd);
    if (found) {
      return {
        ...base,
        available: true,
        command: found,
        args: base.args ?? [],
        resolvedCommand: found,
        statusMessage: null,
      };
    }
  }

  // npx-backed agents: available if npx exists (package fetched on demand)
  if (base.installKind === "npx" || base.command === "npx") {
    if (hasNpx()) {
      const npx = findExecutableOnPath("npx") ?? "npx";
      const pkg = base.npmPackage ?? base.args.find((a) => a.startsWith("@")) ?? "";
      // `base.args` may already be a previously-probed result (resolveAgentSpawn
      // re-probes for fresh PATH resolution) — strip any prior `-y <pkg>` prefix
      // so re-probing stays idempotent instead of accumulating duplicates.
      const extraArgs = (base.args ?? []).filter((a) => a !== "-y" && a !== pkg);
      return {
        ...base,
        available: true,
        command: npx,
        args: pkg ? ["-y", pkg, ...extraArgs] : extraArgs,
        resolvedCommand: npx,
        statusMessage: pkg
          ? `Will launch via npx (${pkg}). First run may download the package.`
          : null,
      };
    }
    return {
      ...base,
      available: false,
      resolvedCommand: null,
      statusMessage: base.installHint ?? "Install Node.js / npm so npx is available.",
    };
  }

  // binary not found
  return {
    ...base,
    available: false,
    resolvedCommand: null,
    statusMessage: base.installHint ?? `Install ${base.displayName} and ensure it is on PATH.`,
  };
}

export function listRegisteredAgents(): AcpAgentDescriptor[] {
  const file = loadRegistryFile();
  // Merge config with builtins for any missing metadata fields
  const byId = new Map(BUILTIN_ACP_AGENTS.map((a) => [a.id, a]));
  const agents = file.agents.map((agent) => {
    const builtin = byId.get(agent.id);
    return {
      ...builtin,
      ...agent,
      args: agent.args ?? builtin?.args ?? [],
      detectCommands: agent.detectCommands ?? builtin?.detectCommands,
      docsUrl: agent.docsUrl ?? builtin?.docsUrl,
      authHint: agent.authHint ?? builtin?.authHint,
      installHint: agent.installHint ?? builtin?.installHint,
      installKind: agent.installKind ?? builtin?.installKind,
      npmPackage: agent.npmPackage ?? builtin?.npmPackage,
      description: agent.description ?? builtin?.description,
    } as AcpAgentDescriptor;
  });
  return agents.map(probeAgentAvailability);
}

export function getAgentDescriptor(agentId: string): AcpAgentDescriptor | null {
  const fromInstance = instanceDescriptorProvider?.(agentId);
  if (fromInstance) return fromInstance;
  // Once instance storage is configured, a miss means the instance is unknown
  // or disabled — do NOT fall back to the driver (that would re-enable a
  // disabled default account). The driver fallback is only for the
  // uninitialized/legacy state with no provider installed.
  if (instanceDescriptorProvider) return null;
  return listRegisteredAgents().find((a) => a.id === agentId) ?? null;
}

export function getDefaultAgentId(): string {
  const file = loadRegistryFile();
  const agents = listRegisteredAgents();
  if (file.defaultAgentId && agents.some((a) => a.id === file.defaultAgentId && a.available)) {
    return file.defaultAgentId;
  }
  // Prefer first available non-mock agent
  const preferred =
    agents.find((a) => a.available && a.installKind !== "mock") ??
    agents.find((a) => a.available) ??
    agents[0];
  return preferred?.id ?? "pipper-mock";
}

/** Resolve spawn command/args for process launch. */
export function resolveAgentSpawn(agent: AcpAgentDescriptor): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const env = { ...process.env, ...agent.env } as Record<string, string>;
  // Drop ambient provider credentials for isolated accounts so the child can't
  // authenticate as the machine's default login instead of the chosen account.
  for (const name of agent.unsetEnv ?? []) delete env[name];
  applyFullAccessEnv(descriptorDriverId(agent), env);
  // `bun run --bun` prepends a temp dir whose `node` symlinks to bun. npx-based
  // agents are `#!/usr/bin/env node` scripts; run under bun, npm derives its
  // global prefix from the bun binary (~/.bun) and fails with ENOENT on
  // ~/.bun/lib. Strip the shim so agents run under real node.
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  env[pathKey] = (env[pathKey] ?? env.PATH ?? "")
    .split(sep)
    .filter((dir) => !/[\\/]bun-node-[^\\/]+$/.test(dir))
    .join(sep);

  if (agent.id === "pipper-mock" || agent.installKind === "mock") {
    const mockPath = join(registryDir, "mock-agent.mjs");
    const alt = join(process.cwd(), "electron/agents/mock-agent.mjs");
    const script = existsSync(mockPath) ? mockPath : alt;
    return {
      command: process.execPath.includes("Electron") ? "node" : process.execPath,
      args: [script],
      env,
    };
  }

  if (descriptorDriverId(agent) === "antigravity-acp") {
    const binary = installedAntigravityPath();
    if (!binary || !existsSync(binary))
      throw new Error("Google Antigravity ACP is not installed in Pipper's cache yet.");
    delete env.AGY_EXTRA_ARGS;
    return {
      command: binary,
      args: [...(antigravityRelease()?.args ?? [])],
      env,
    };
  }

  // Re-probe so spawn uses latest PATH resolution. Probe the *driver*
  // descriptor (id = driverId) rather than the instance id, so driver-specific
  // binary resolution (e.g. Cursor's `agent` disambiguation) still applies;
  // the instance only contributes `env`.
  const probeBase: AcpAgentDescriptor = agent.driverId ? { ...agent, id: agent.driverId } : agent;
  const probed = probeAgentAvailability(probeBase);
  if (!probed.available) {
    throw new Error(
      probed.statusMessage ??
        `${agent.displayName} is not installed. ${agent.installHint ?? ""}`.trim(),
    );
  }

  return {
    command: probed.resolvedCommand ?? probed.command,
    args: probed.args ?? [],
    env,
  };
}
