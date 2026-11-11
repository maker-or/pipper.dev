import { afterAll, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

vi.mock("electron", () => ({ app: { getPath: () => process.env.TMPDIR ?? "/tmp" } }));
vi.mock("./agents/registry.ts", () => ({
  resolveAgentSpawn: (descriptor: { args: string[] }) => ({
    command: process.execPath,
    args: descriptor.args,
    env: { ...process.env },
  }),
}));

import { ConnectionLifecycle, type ConnectionLifecycleDeps } from "./connection-lifecycle.ts";
import {
  killAllProviderProcessesSync,
  runningProviderProcesses,
  spawnProviderProcess,
} from "./provider-processes.ts";
import type { AcpAgentDescriptor } from "../contracts/acp.ts";
import type { TerminalManager } from "./terminal-manager.ts";

const root = mkdtempSync(join(tmpdir(), "pipper-provider-reaping-"));
const mockAgentUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "agents/mock-agent.mjs"),
).href;
// A provider that starts a helper in its process group which ignores SIGTERM
// (like a CLI or server a real provider runs), then either serves ACP or
// ignores SIGTERM itself and never answers the handshake.
const fixture = join(root, "provider.mjs");
writeFileSync(
  fixture,
  `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, pidFile, agentUrl] = process.argv.slice(2);
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, String(helper.pid));
if (mode === "agent") await import(agentUrl);
else {
  process.on("SIGTERM", () => {});
  process.stdin.resume();
  setInterval(() => {}, 1000);
}
`,
);

afterAll(() => {
  killAllProviderProcessesSync();
  rmSync(root, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function helperPid(pidFile: string): Promise<number> {
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
  return Number(readFileSync(pidFile, "utf8"));
}

function descriptor(id: string, mode: "agent" | "stubborn"): AcpAgentDescriptor {
  return {
    id,
    name: id,
    displayName: id,
    command: process.execPath,
    args: [fixture, mode, join(root, `${id}.pid`), mockAgentUrl],
  };
}

function makeLifecycle(): ConnectionLifecycle {
  return new ConnectionLifecycle({
    terminal: {} as TerminalManager,
    clientVersion: "test",
    hooks: {
      onSessionUpdate: async () => {},
      onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onReadTextFile: async () => ({ content: "" }),
      onWriteTextFile: async () => ({}),
      assertWithinWorkspace: () => {},
    },
    getMonitorObserver: () => null,
    getActiveThreadId: () => null,
    getRunningThreadIds: () => [],
    getSessionsByAgent: () => [],
    invalidateAgentSessions: () => {},
  } satisfies ConnectionLifecycleDeps);
}

describe.skipIf(process.platform === "win32")("provider process reaping", () => {
  test("terminateAll reaps connected and mid-handshake providers with their process groups", async () => {
    const lifecycle = makeLifecycle();
    const connected = await lifecycle.acquire(descriptor("connected", "agent"));
    // Never answers initialize, so it is not in the connection map yet.
    const handshaking = lifecycle.acquire(descriptor("handshaking", "stubborn"));
    handshaking.catch(() => {});
    const helpers = [
      await helperPid(join(root, "connected.pid")),
      await helperPid(join(root, "handshaking.pid")),
    ];
    const providers = runningProviderProcesses().map((child) => child.pid!);
    expect(providers).toContain(connected.process.pid);
    expect(providers).toHaveLength(2);

    await lifecycle.terminateAll();

    for (const pid of [...providers, ...helpers]) await waitFor(() => !isAlive(pid), 2_000);
    expect(runningProviderProcesses()).toEqual([]);
    // Shutdown refuses new providers instead of starting one nobody reaps.
    await expect(lifecycle.acquire(descriptor("late", "agent"))).rejects.toThrow("shut down");
    expect(runningProviderProcesses()).toEqual([]);
  }, 15_000);

  test("closing a provider that is still starting stops it and never caches it", async () => {
    const lifecycle = makeLifecycle();
    // Never answers initialize, so close() lands mid-handshake.
    const starting = lifecycle.acquire(descriptor("closed-starting", "stubborn"));
    const outcome = starting.then(
      () => "connected",
      (error: Error) => error.message,
    );
    const helper = await helperPid(join(root, "closed-starting.pid"));
    const [provider] = runningProviderProcesses();
    expect(provider).toBeDefined();

    await lifecycle.close("closed-starting");

    expect(await outcome).toMatch(/closed while it was starting/);
    expect(lifecycle.getCached("closed-starting")).toBeUndefined();
    await waitFor(() => !isAlive(provider!.pid!) && !isAlive(helper), 2_000);
    expect(runningProviderProcesses()).toEqual([]);

    // The agent can be started again afterwards.
    const fresh = await lifecycle.acquire(descriptor("closed-starting", "agent"));
    expect(lifecycle.getCached("closed-starting")).toBe(fresh);
    await lifecycle.terminateAll();
  }, 15_000);

  test("the synchronous last-resort kill stops a provider that ignores SIGTERM and its group", async () => {
    const pidFile = join(root, "sync.pid");
    const child = spawnProviderProcess(process.execPath, [fixture, "stubborn", pidFile], {
      env: { ...process.env },
    });
    const helper = await helperPid(pidFile);
    expect(runningProviderProcesses()).toContain(child);

    expect(killAllProviderProcessesSync()).toBe(1);

    await waitFor(() => !isAlive(child.pid!) && !isAlive(helper), 2_000);
    await waitFor(() => !runningProviderProcesses().includes(child), 2_000);
  });
});
