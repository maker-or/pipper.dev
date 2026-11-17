import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { signalProcessGroup, terminateChildProcess } from "./child-process.ts";

/**
 * Every ACP provider process this app started that is still running. It is
 * independent of connection bookkeeping, so shutdown can reap a provider no
 * connection owns any more: one mid-handshake, one whose transport closed
 * while the process stayed up, or a handshake probe.
 */
const running = new Set<ChildProcessWithoutNullStreams>();

/** POSIX providers lead their own process group so their helpers stop with them. */
const useProcessGroups = process.platform !== "win32";

export interface ProviderSpawnOptions {
  env: NodeJS.ProcessEnv;
  /** Windows `.cmd` shims must run through the shell. */
  shell?: boolean;
  /** Process cwd; defaults to the user's home directory. */
  cwd?: string;
}

/** Spawn an ACP provider over stdio pipes and track it until it exits. */
export function spawnProviderProcess(
  command: string,
  args: readonly string[],
  options: ProviderSpawnOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(command, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
    // Never inherit the app's own cwd: in development that is this repo, whose
    // package.json (devEngines: bun) makes `npx` refuse to launch npx-backed
    // providers (EBADDEVENGINES). Workspaces reach the agent through ACP
    // session cwd, never through the process cwd.
    cwd: options.cwd ?? homedir(),
    ...(options.shell && { shell: true }),
    // Own process group (POSIX): terminating the provider also stops the CLIs
    // and servers it started. Providers talk over pipes, so losing the
    // controlling terminal changes nothing; a packaged app has none anyway.
    detached: useProcessGroups,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  if (child.pid === undefined) {
    // Spawn failed (the "error" event follows); there is nothing to reap.
    return child;
  }
  running.add(child);
  child.once("exit", () => {
    running.delete(child);
    // A provider that exits on its own must not leave its helpers behind.
    if (useProcessGroups) signalProcessGroup(child, "SIGTERM");
  });
  return child;
}

/** SIGTERM the provider (and its group), SIGKILL after a grace period. */
export async function terminateProviderProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  try {
    await terminateChildProcess(child, { processGroup: useProcessGroups });
  } finally {
    if (child.exitCode != null || child.signalCode != null) running.delete(child);
  }
}

/**
 * Last resort when shutdown cannot wait: SIGKILL every running provider and
 * its process group synchronously. Returns how many were signalled.
 */
export function killAllProviderProcessesSync(): number {
  let signalled = 0;
  for (const child of running) {
    if (child.exitCode != null || child.signalCode != null) {
      running.delete(child);
      continue;
    }
    signalled++;
    if (useProcessGroups && signalProcessGroup(child, "SIGKILL")) continue;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  return signalled;
}

/** Running provider processes; for diagnostics and tests. */
export function runningProviderProcesses(): ChildProcessWithoutNullStreams[] {
  return [...running];
}
