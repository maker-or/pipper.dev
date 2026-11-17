/**
 * Confirms an ACP agent actually works, rather than just trusting that a
 * binary was found on PATH: spawns it, performs a real `initialize` + a
 * throwaway `session/new`, classifies the result, then tears the process down.
 *
 * `probeAgentAvailability` (registry.ts) only proves a command *exists* — it
 * can still be the wrong binary (see the cursor-acp PATH collision fix) or
 * one that never responds. This is the signal onboarding and the agent panel
 * use to decide whether an agent needs an install/auth step before use.
 *
 * Auth is only proven by `session/new`. Advertising `authMethods` at
 * `initialize` is NOT a sign-in signal (signed-in agents advertise them too).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpAgentDescriptor, AgentProbeResult } from "../../contracts/acp.ts";
import { getAgentDescriptor, resolveAgentSpawn } from "./registry.ts";
import { ensureAntigravityInstalled } from "./antigravity-official.ts";
import { spawnProviderProcess, terminateProviderProcess } from "../provider-processes.ts";
import { shellPathReady } from "../shell-path.ts";
import { classifyAgentStartFailure, type AgentStartFailureReason } from "./start-failure.ts";
import {
  applyStartRecovery,
  npxPackageFor,
  planStartRecovery,
  withNpxPackageLock,
  type StartRecoveryReport,
} from "./start-recovery.ts";

/** Covers initialize + throwaway session/new (Codex init alone can take a few seconds). */
const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
/** npx may download the package on first run. */
const NPX_PROBE_TIMEOUT_MS = 120_000;

export interface ProbeOptions {
  timeoutMs?: number;
  /** App version for ACP `clientInfo`; callers pass `app.getVersion()`. */
  clientVersion?: string;
  /** Told about a check that needed a repair, once its outcome is known. */
  onRecovery?: (report: StartRecoveryReport) => void;
}

/**
 * True when an ACP request rejected with the protocol's `auth_required` error.
 * Mirrors the check used when the real app opens a session.
 *
 * Prefer `instanceof`, but also duck-type so a duplicated SDK graph (tests /
 * bundlers) cannot mis-classify auth failures as generic errors.
 */
function isAuthRequiredError(err: unknown): boolean {
  if (err instanceof acp.RequestError) {
    return err.code === -32000 && /auth(?:entication)?[\s_-]*required/i.test(err.message);
  }
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; message?: unknown; name?: unknown };
  if (candidate.name !== "RequestError" && typeof candidate.code !== "number") return false;
  return (
    candidate.code === -32000 &&
    typeof candidate.message === "string" &&
    /auth(?:entication)?[\s_-]*required/i.test(candidate.message)
  );
}

/** Tail of the probe chain per driver, so probes of one driver never overlap. */
const probeQueues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every earlier probe of the same driver has finished.
 *
 * Accounts of one driver launch the same command — for npx-backed drivers the
 * same `npx -y <pkg>`. Concurrent npx runs of one package race on the shared
 * npx cache and can leave it half-installed (e.g. Codex's platform binary
 * package without its package.json), which then breaks every later launch.
 * Different drivers stay parallel.
 */
function serializeByDriver<T>(driverId: string, task: () => Promise<T>): Promise<T> {
  const previous = probeQueues.get(driverId) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  probeQueues.set(driverId, tail);
  void tail.then(() => {
    if (probeQueues.get(driverId) === tail) probeQueues.delete(driverId);
  });
  return next;
}

/**
 * Spawns `descriptor`, runs ACP `initialize` + throwaway `session/new`, then
 * kills the process. Probes of the same driver run one at a time.
 */
export function probeAgentHandshake(
  descriptor: AcpAgentDescriptor,
  options: ProbeOptions = {},
): Promise<AgentProbeResult> {
  return serializeByDriver(descriptor.driverId ?? descriptor.id, async () => {
    await shellPathReady();
    const npmPackage = npxPackageFor(descriptor);
    // Chat connections of the same npx package take the same turns.
    return withNpxPackageLock(npmPackage, () => probeWithRecovery(descriptor, options, npmPackage));
  });
}

/**
 * Probe once; when the launch failed for a reason a repair can fix (the same
 * repairs chat connections use, agents/start-recovery.ts), repair and probe
 * once more. Sign-in problems are answers, not failures, and get no retry.
 */
async function probeWithRecovery(
  descriptor: AcpAgentDescriptor,
  options: ProbeOptions,
  npmPackage: string | null,
): Promise<AgentProbeResult> {
  const failure: ProbeFailure = {};
  const first = await runProbe(descriptor, options, failure);
  if (first.status === "ready" || first.status === "needs-auth" || !failure.error) return first;
  const reason = classifyAgentStartFailure({
    error: failure.error,
    stderr: failure.stderr,
    exitCode: failure.exitCode,
  });
  const action = planStartRecovery({
    reason,
    stderr: failure.stderr,
    message: failure.error instanceof Error ? failure.error.message : String(failure.error),
    npmPackage,
  });
  if (!action) return first;
  const failedAt = Date.now();
  const report = (
    outcome: "recovered" | "failed",
    retried: boolean,
    finalFailureReason?: AgentStartFailureReason,
  ) =>
    options.onRecovery?.({
      failureReason: reason,
      action,
      outcome,
      retried,
      ...(finalFailureReason && { finalFailureReason }),
      exitCode: failure.exitCode ?? null,
      durationMs: Date.now() - failedAt,
    });
  if (!(await applyStartRecovery(action, { npmPackage }))) {
    report("failed", false);
    return first;
  }
  const timeoutMs =
    action === "retry_longer"
      ? (options.timeoutMs ?? (npmPackage ? NPX_PROBE_TIMEOUT_MS : DEFAULT_PROBE_TIMEOUT_MS)) * 2
      : options.timeoutMs;
  // Availability was decided before the repair (e.g. before PATH changed);
  // let the retry resolve the command afresh.
  const retryFailure: ProbeFailure = {};
  const retry = () =>
    runProbe({ ...descriptor, available: undefined }, { ...options, timeoutMs }, retryFailure);
  const retryPackage = npxPackageFor(descriptor);
  const second = await (retryPackage && retryPackage !== npmPackage
    ? withNpxPackageLock(retryPackage, retry)
    : retry());
  // Signed in or not, an agent that answered has started: the repair worked.
  if (second.status === "ready" || second.status === "needs-auth") {
    report("recovered", true);
  } else {
    report(
      "failed",
      true,
      retryFailure.error
        ? classifyAgentStartFailure({
            error: retryFailure.error,
            stderr: retryFailure.stderr,
            exitCode: retryFailure.exitCode,
          })
        : undefined,
    );
  }
  return second;
}

/** What a failed probe saw, read locally to pick a repair. */
interface ProbeFailure {
  error?: unknown;
  stderr?: string;
  exitCode?: number | null;
}

async function runProbe(
  descriptor: AcpAgentDescriptor,
  options: ProbeOptions,
  failure: ProbeFailure = {},
): Promise<AgentProbeResult> {
  if (descriptor.available === false) {
    failure.error = new Error(`${descriptor.displayName} is not installed`);
    return {
      agentId: descriptor.id,
      status: "needs-install",
      message:
        descriptor.installHint ?? `Install ${descriptor.displayName} and ensure it is on PATH.`,
    };
  }

  let child: ChildProcessWithoutNullStreams;
  let spawnCommand = "";
  try {
    if (descriptor.id === "antigravity-acp") await ensureAntigravityInstalled();
    const { command, args, env } = resolveAgentSpawn(descriptor);
    spawnCommand = command;
    const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
    child = spawnProviderProcess(command, args, { env, shell: useShell });
  } catch (err) {
    failure.error = err;
    return {
      agentId: descriptor.id,
      status: "needs-install",
      message: err instanceof Error ? err.message : `Unable to launch ${descriptor.displayName}.`,
    };
  }

  let stderrText = "";
  const onStderr = (buf: Buffer) => {
    stderrText += buf.toString("utf8");
  };
  child.stderr.on("data", onStderr);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let probeCwd: string | null = null;
  let authMethods: acp.AuthMethod[] = [];
  let canCloseSession = false;
  /** Once true, exit/error listeners must not reject — teardown kill is expected. */
  let settled = false;

  try {
    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const connection = acp.client({ name: "pipper" }).connect(stream);

    const exitedEarly = new Promise<never>((_, reject) => {
      const fail = (err: Error) => {
        if (!settled) reject(err);
      };
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (settled || code === 0) return;
        fail(
          new Error(
            stderrText.trim() ||
              `${descriptor.displayName} exited (code ${code}${
                signal ? `, signal ${signal}` : ""
              }) before responding.`,
          ),
        );
      });
    });

    const timedOut = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => {
          if (settled) return;
          reject(new Error("__pipper_probe_timeout__"));
        },
        options.timeoutMs ??
          (/\bnpx(?:\.cmd)?$/i.test(spawnCommand)
            ? NPX_PROBE_TIMEOUT_MS
            : DEFAULT_PROBE_TIMEOUT_MS),
      );
    });

    const run = async () => {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: {
          name: "pipper",
          title: "Pipper",
          version: options.clientVersion ?? "0.0.0",
        },
      });
      authMethods = initialized.authMethods ?? [];
      canCloseSession = Boolean(initialized.agentCapabilities?.sessionCapabilities?.close);

      // Throwaway session proves the agent will accept work in Pipper — including
      // that the user is authenticated when the agent requires it. No prompt is
      // sent; success is "session/new returned", not "model replied".
      probeCwd = mkdtempSync(join(tmpdir(), "pipper-probe-session-"));
      const created = (await connection.agent.request(acp.methods.agent.session.new, {
        cwd: probeCwd,
        mcpServers: [],
      })) as { sessionId?: string };

      const sessionId = created?.sessionId;
      if (sessionId && canCloseSession) {
        try {
          await connection.agent.request(acp.methods.agent.session.close, { sessionId });
        } catch {
          // Best-effort cleanup; process kill in finally is the hard guarantee.
        }
      }
    };

    await Promise.race([run(), exitedEarly, timedOut]);
    settled = true;
    return { agentId: descriptor.id, status: "ready" };
  } catch (err) {
    settled = true;
    if (isAuthRequiredError(err)) {
      return {
        agentId: descriptor.id,
        status: "needs-auth",
        message:
          descriptor.authHint ??
          `${descriptor.displayName} requires authentication. Sign in from your terminal first.`,
        authMethods,
      };
    }
    failure.error = err;
    failure.stderr = stderrText;
    failure.exitCode = child.exitCode;
    const message = err instanceof Error ? err.message : String(err);
    if (message === "__pipper_probe_timeout__") {
      return {
        agentId: descriptor.id,
        status: "error",
        message: `${descriptor.displayName} did not respond in time. It may be misconfigured.`,
      };
    }
    return { agentId: descriptor.id, status: "error", message };
  } finally {
    settled = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    child.stderr.off("data", onStderr);
    // The exit/error listeners above are inert once settled; they stay
    // attached because the provider registry listens for exit too. This also
    // stops anything the agent started (its process group).
    void terminateProviderProcess(child);
    // probeCwd is intentionally left on disk briefly; OS temp cleaner removes it.
    // Avoid recursive rm here so a hostile agent cannot trick us into deleting more.
    void probeCwd;
  }
}

/** Looks up `agentId` in the registry, then probes it. */
export async function probeAgentById(
  agentId: string,
  options: ProbeOptions = {},
): Promise<AgentProbeResult> {
  // Availability is decided at lookup, so look up with the full PATH.
  await shellPathReady();
  const descriptor = getAgentDescriptor(agentId);
  if (!descriptor) {
    return { agentId, status: "error", message: "Unknown agent." };
  }
  return probeAgentHandshake(descriptor, options);
}
