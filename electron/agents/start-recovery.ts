import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { refreshLoginShellPath } from "../shell-path.ts";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import { resolveAgentSpawn } from "./registry.ts";
import type { AgentStartFailureReason } from "./start-failure.ts";

/**
 * One repair-and-retry for an agent that failed to start, picked from why it
 * failed (start-failure.ts). Chat connections and readiness checks share it,
 * so an agent that recovers in one recovers in the other.
 *
 * Each start gets at most one recovery: a second failure is reported as is.
 * Failures a retry can't fix (sign-in, protocol errors) get none.
 */
export type StartRecoveryAction =
  /** Re-read PATH from the login shell (Node from nvm/Volta/fnm), then retry. */
  | "refresh_path"
  /** Delete the npx cache folder holding this one package, then retry. */
  | "purge_npx_cache"
  /** A network error while npm downloaded: wait briefly, then retry. */
  | "wait_and_retry"
  /** No reply in time (often a first-run download): retry with twice the time. */
  | "retry_longer"
  /** The process died for no known reason: retry once. */
  | "retry";

const NETWORK =
  /\bE(?:NOTFOUND|AI_AGAIN|CONNRESET|CONNREFUSED|TIMEDOUT|NETUNREACH)\b|socket hang up|network/i;
/** npx refusing the folder it runs in: no retry or cache purge fixes that. */
const WRONG_FOLDER = /EBADDEVENGINES/;

export function planStartRecovery(input: {
  reason: AgentStartFailureReason;
  stderr?: string;
  message?: string;
  npmPackage: string | null;
}): StartRecoveryAction | null {
  const text = `${input.message ?? ""}\n${input.stderr ?? ""}`;
  switch (input.reason) {
    case "not_installed":
      return "refresh_path";
    case "package_install_failed":
      if (WRONG_FOLDER.test(text)) return null;
      if (NETWORK.test(text)) return "wait_and_retry";
      return input.npmPackage ? "purge_npx_cache" : null;
    case "timeout":
      return "retry_longer";
    case "exited_early":
      return "retry";
    default:
      return null;
  }
}

/**
 * One repair attempt, start to finish: what the user's agent hit, what was
 * tried, and whether it got the agent started. Sent as `agent_start_recovery`.
 */
export interface StartRecoveryReport {
  /** Why the first launch failed: the failure the user would have faced. */
  failureReason: AgentStartFailureReason;
  action: StartRecoveryAction;
  outcome: "recovered" | "failed";
  /** False when the repair found nothing to change, so no retry was made. */
  retried: boolean;
  /** Why the retry failed too, when the outcome is "failed". */
  finalFailureReason?: AgentStartFailureReason;
  /** The first launch's exit code, when it exited. */
  exitCode: number | null;
  /** From the first failure to the outcome. */
  durationMs: number;
}

/** Analytics properties for a report (categories and numbers only). */
export function startRecoveryProperties(
  report: StartRecoveryReport,
  context: "connection" | "readiness_check",
): {
  failure_reason: AgentStartFailureReason;
  recovery_action: StartRecoveryAction;
  recovery_outcome: "recovered" | "failed";
  recovery_retried: boolean;
  final_failure_reason?: AgentStartFailureReason;
  exit_code?: number;
  total_duration_ms: number;
  start_context: "connection" | "readiness_check";
} {
  return {
    failure_reason: report.failureReason,
    recovery_action: report.action,
    recovery_outcome: report.outcome,
    recovery_retried: report.retried,
    ...(report.finalFailureReason && { final_failure_reason: report.finalFailureReason }),
    ...(report.exitCode != null && { exit_code: report.exitCode }),
    total_duration_ms: report.durationMs,
    start_context: context,
  };
}

/** Where npm keeps its cache (npx installs live in `<cache>/_npx/<hash>`). */
export function npmCacheDir(): string {
  if (process.env.npm_config_cache) return process.env.npm_config_cache;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache");
  }
  return join(homedir(), ".npm");
}

/** `@scope/name@1.2.3` → `@scope/name`. */
function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * Delete the npx install folders that hold `npmPackage`, and nothing else:
 * only direct children of `<cache>/_npx` whose node_modules has the package.
 * npx reinstalls it on the next launch. Returns how many were removed.
 */
export function purgeNpxPackageCache(npmPackage: string, cacheDir = npmCacheDir()): number {
  const npxRoot = resolve(cacheDir, "_npx");
  const name = packageName(npmPackage);
  let entries: string[];
  try {
    entries = readdirSync(npxRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const dir = resolve(npxRoot, entry);
    // Never leave _npx, whatever an entry's name is.
    if (!dir.startsWith(npxRoot + sep)) continue;
    if (!existsSync(join(dir, "node_modules", ...name.split("/")))) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A file in use (Windows) or a permission problem; the retry reports it.
    }
  }
  return removed;
}

/** Apply a repair; true when a retry is worth making. */
export async function applyStartRecovery(
  action: StartRecoveryAction,
  context: { npmPackage: string | null; waitMs?: number },
): Promise<boolean> {
  switch (action) {
    case "refresh_path":
      return refreshLoginShellPath();
    case "purge_npx_cache":
      return context.npmPackage ? purgeNpxPackageCache(context.npmPackage) > 0 : false;
    case "wait_and_retry":
      await new Promise((done) => setTimeout(done, context.waitMs ?? 2_000));
      return true;
    case "retry_longer":
    case "retry":
      return true;
  }
}

/** The npm package an `npx -y <pkg>` launch runs, or null for other launches. */
export function npxPackageOf(command: string, args: readonly string[]): string | null {
  if (!/(?:^|[\\/])npx(?:\.cmd)?$/i.test(command)) return null;
  const index = args.indexOf("-y");
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

/** The npm package an agent launches through npx, or null; never throws. */
export function npxPackageFor(descriptor: AcpAgentDescriptor): string | null {
  try {
    const { command, args } = resolveAgentSpawn(descriptor);
    return npxPackageOf(command, args);
  } catch {
    return null;
  }
}

const packageLocks = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier start of the same npm package has finished
 * its handshake. Parallel `npx -y` runs of one package race on the shared
 * npx cache and can leave it half-installed, breaking every later launch, so
 * chat connections and readiness checks of one package take turns. Other
 * packages, and non-npx agents, run in parallel.
 */
export function withNpxPackageLock<T>(
  npmPackage: string | null,
  task: () => Promise<T>,
): Promise<T> {
  if (!npmPackage) return task();
  const key = packageName(npmPackage);
  const previous = packageLocks.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  packageLocks.set(key, tail);
  void tail.then(() => {
    if (packageLocks.get(key) === tail) packageLocks.delete(key);
  });
  return next;
}
