import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  helperFailureOutput,
  SleeplessController,
  resolveSleeplessHelperPath,
} from "./sleepless-controller.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pipper-sleepless-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths() {
  const helperPath = join(root, "omni-sleeplessctl");
  const settingsPath = join(root, "settings", "sleepless.json");
  writeFileSync(helperPath, "test helper");
  return { helperPath, settingsPath };
}

describe("SleeplessController", () => {
  test("stays disabled and unsupported by default off macOS", async () => {
    const { helperPath, settingsPath } = paths();
    const broadcast = vi.fn();
    const runHelper = vi.fn(async () => JSON.stringify({ status: "enabled" }));
    const controller = new SleeplessController({
      platform: "linux",
      helperPath,
      settingsPath,
      broadcast,
      runHelper,
    });

    const status = await controller.initialize();

    expect(status.supported).toBe(false);
    expect(status.serviceStatus).toBe("unsupported");
    expect(status.phase).toBe("disabled");
    expect(status.preferences.enabled).toBe(false);
    expect(runHelper).not.toHaveBeenCalled();
    await controller.dispose();
  });

  test("registers only after opt-in and persists safe preferences", async () => {
    const { helperPath, settingsPath } = paths();
    const commands: string[] = [];
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath,
      settingsPath,
      broadcast: vi.fn(),
      runHelper: async (_path, command) => {
        commands.push(command);
        return JSON.stringify({ status: command === "status" ? "not-registered" : "enabled" });
      },
    });

    await controller.initialize();
    expect(commands).toEqual(["status"]);

    const status = await controller.setEnabled(true);

    expect(commands).toEqual(["status", "register"]);
    expect(status.serviceStatus).toBe("enabled");
    expect(status.phase).toBe("disarmed");
    expect(status.preferences).toMatchObject({ enabled: true, acOnly: true, batteryFloor: 20 });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({ enabled: true });
    await controller.dispose();
  });

  test("clamps persisted safety values before exposing or saving them", async () => {
    const { helperPath, settingsPath } = paths();
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath,
      settingsPath,
      broadcast: vi.fn(),
      runHelper: async () => JSON.stringify({ status: "enabled" }),
    });
    await controller.initialize();

    const status = await controller.setPreferences({
      acOnly: false,
      batteryFloor: 2,
      maxDurationMinutes: 10_000,
    });

    expect(status.preferences).toEqual({
      enabled: false,
      acOnly: false,
      batteryFloor: 10,
      maxDurationMinutes: 720,
    });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(status.preferences);
    await controller.dispose();
  });

  test("reports a missing packaged helper without attempting registration", async () => {
    const settingsPath = join(root, "sleepless.json");
    const runHelper = vi.fn(async () => JSON.stringify({ status: "enabled" }));
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath: join(root, "missing-helper"),
      settingsPath,
      broadcast: vi.fn(),
      runHelper,
    });

    await controller.initialize();
    const status = await controller.setEnabled(true);

    expect(status.serviceStatus).toBe("not-found");
    expect(status.phase).toBe("error");
    expect(status.preferences.enabled).toBe(false);
    expect(status.error).toContain("helper is missing");
    expect(runHelper).not.toHaveBeenCalled();
    await controller.dispose();
  });

  test("does not run the privileged helper when the feature is unavailable in development", async () => {
    const { helperPath, settingsPath } = paths();
    const runHelper = vi.fn(async () => JSON.stringify({ status: "enabled" }));
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath,
      settingsPath,
      unavailableReason: "Lid-closed execution requires a packaged macOS app.",
      broadcast: vi.fn(),
      runHelper,
    });

    const initial = await controller.initialize();
    const enabled = await controller.setEnabled(true);

    expect(initial.supported).toBe(false);
    expect(enabled.serviceStatus).toBe("unsupported");
    expect(enabled.phase).toBe("error");
    expect(enabled.preferences.enabled).toBe(false);
    expect(enabled.error).toContain("packaged macOS app");
    expect(runHelper).not.toHaveBeenCalled();
    await controller.dispose();
  });

  test("surfaces the native installer error when registration exits non-zero", async () => {
    const { helperPath, settingsPath } = paths();
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath,
      settingsPath,
      broadcast: vi.fn(),
      runHelper: async (_path, command) =>
        JSON.stringify(
          command === "register"
            ? { status: "not-registered", error: "The administrator denied access." }
            : { status: "not-registered" },
        ),
    });

    await controller.initialize();
    const status = await controller.setEnabled(true);

    expect(status.preferences.enabled).toBe(false);
    expect(status.phase).toBe("error");
    expect(status.error).toBe("The administrator denied access.");
    await controller.dispose();
  });
});

/** A stand-in for the native daemon: answers every request, records ARMs. */
async function startFakeDaemon(socketPath: string) {
  const clients = new Set<Socket>();
  const commands: string[] = [];
  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const { id, command } = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          command: string;
        };
        buffer = buffer.slice(newline + 1);
        commands.push(command);
        socket.write(`${JSON.stringify({ id, ok: true, armedAt: Date.now() })}\n`);
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    commands,
    /** The daemon restarts: every client connection drops. */
    dropClients: () => {
      for (const client of clients) client.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test.skipIf(process.platform === "win32")(
  "stays armed for a paired phone with no tasks when the daemon connection drops",
  async () => {
    const { helperPath, settingsPath } = paths();
    const socketPath = join(root, "d.sock");
    const daemon = await startFakeDaemon(socketPath);
    mkdirSync(join(root, "settings"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ enabled: true }));
    const controller = new SleeplessController({
      platform: "darwin",
      helperPath,
      settingsPath,
      socketPath,
      broadcast: vi.fn(),
      runHelper: async () => JSON.stringify({ status: "enabled" }),
    });
    try {
      await controller.initialize();
      expect(controller.getStatus().phase).toBe("disarmed");

      controller.setRemoteActive(true);
      await vi.waitFor(() => expect(controller.getStatus().phase).toBe("armed"));
      const armsBefore = daemon.commands.filter((command) => command === "ARM").length;

      daemon.dropClients();

      await vi.waitFor(() => expect(controller.getStatus().phase).toBe("connecting"));
      await vi.waitFor(() => expect(controller.getStatus().phase).toBe("armed"), {
        timeout: 5_000,
      });
      expect(daemon.commands.filter((command) => command === "ARM").length).toBe(armsBefore + 1);
    } finally {
      await controller.dispose();
      await daemon.close();
    }
  },
  10_000,
);

test("helperFailureOutput preserves native JSON emitted with a non-zero exit", () => {
  const output = JSON.stringify({ status: "not-registered", error: "Administrator denied." });
  expect(helperFailureOutput({ stdout: output })).toBe(output);
  expect(helperFailureOutput(new Error("Command failed"))).toBeNull();
});

test("resolveSleeplessHelperPath places the helper beside the app executable", () => {
  expect(resolveSleeplessHelperPath("/Applications/Pipper.app/Contents/MacOS/Pipper")).toBe(
    "/Applications/Pipper.app/Contents/MacOS/omni-sleeplessctl",
  );
});
