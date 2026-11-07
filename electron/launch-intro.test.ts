import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveLaunchIntroHelperPath,
  shouldPlayLaunchIntro,
  startFirstLaunchIntro,
  startLaunchIntro,
} from "./launch-intro.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pipper-launch-intro-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in helper: a node script speaking the same stdout/stdin protocol. */
function fakeHelper(body: string): string {
  const path = join(root, "pipper-launch-intro");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function playsThenWaitsForDismiss(dismissFile: string): string {
  return `
emit({ type: "started", stage: "none" });
setTimeout(() => emit({ type: "complete" }), 20);
process.stdin.on("data", (data) => {
  if (String(data).includes("dismiss")) {
    fs.writeFileSync(${JSON.stringify(dismissFile)}, "dismissed");
    process.exit(0);
  }
});
`;
}

describe("when the intro plays", () => {
  test("only on the first launch on macOS, unless overridden", () => {
    const firstLaunch = { onboardingCompleted: false, alreadyShown: false, override: undefined };
    expect(shouldPlayLaunchIntro({ ...firstLaunch, platform: "darwin" })).toBe(true);
    expect(shouldPlayLaunchIntro({ ...firstLaunch, platform: "win32" })).toBe(false);
    expect(shouldPlayLaunchIntro({ ...firstLaunch, platform: "darwin", alreadyShown: true })).toBe(
      false,
    );
    expect(
      shouldPlayLaunchIntro({ ...firstLaunch, platform: "darwin", onboardingCompleted: true }),
    ).toBe(false);
    expect(
      shouldPlayLaunchIntro({
        platform: "darwin",
        onboardingCompleted: true,
        alreadyShown: true,
        override: "always",
      }),
    ).toBe(true);
    expect(shouldPlayLaunchIntro({ ...firstLaunch, platform: "darwin", override: "never" })).toBe(
      false,
    );
  });

  test("never twice, even if the first run fails", async () => {
    const helperPath = fakeHelper(`process.exit(3);`);
    const input = {
      platform: "darwin" as const,
      env: {},
      userDataDir: join(root, "userData"),
      onboardingCompleted: false,
      helperPath,
    };

    const first = await startFirstLaunchIntro(input);
    expect(await first?.finished).toBe("failed");
    expect(await startFirstLaunchIntro(input)).toBeNull();
  });

  test("is skipped when the helper isn't built", async () => {
    const session = await startFirstLaunchIntro({
      platform: "darwin",
      env: {},
      userDataDir: join(root, "userData"),
      onboardingCompleted: false,
      helperPath: join(root, "missing"),
    });
    expect(session).toBeNull();
    // Nothing played, so a later launch with the helper may still show it.
    expect(existsSync(join(root, "userData", "launch-intro.json"))).toBe(false);
  });

  test("finds the helper next to the packaged app, or in the dev build output", () => {
    expect(
      resolveLaunchIntroHelperPath({
        isPackaged: true,
        execPath: "/Applications/Pipper.app/Contents/MacOS/Pipper",
        appPath: "/ignored",
      }),
    ).toBe("/Applications/Pipper.app/Contents/MacOS/pipper-launch-intro");
    expect(
      resolveLaunchIntroHelperPath({ isPackaged: false, execPath: "/ignored", appPath: "/repo" }),
    ).toBe(join("/repo", "native", "launch-intro", "dist", "pipper-launch-intro"));
  });
});

describe("a running intro", () => {
  test("finishes when the helper completes, and leaves when dismissed", async () => {
    const dismissFile = join(root, "dismissed");
    const session = startLaunchIntro({
      helperPath: fakeHelper(playsThenWaitsForDismiss(dismissFile)),
      log: () => {},
    });

    expect(await session.finished).toBe("complete");
    session.dismiss();
    await waitFor(() => existsSync(dismissFile));
    expect(readFileSync(dismissFile, "utf8")).toBe("dismissed");
  });

  test("finishes when the user skips it", async () => {
    const session = startLaunchIntro({
      helperPath: fakeHelper(`emit({ type: "skipped" }); setInterval(() => {}, 1000);`),
      log: () => {},
    });
    expect(await session.finished).toBe("skipped");
    session.kill();
  });

  test("never holds the launch window back when the helper crashes or hangs", async () => {
    const crashed = startLaunchIntro({ helperPath: fakeHelper(`process.exit(1);`), log: () => {} });
    expect(await crashed.finished).toBe("failed");

    const hung = startLaunchIntro({
      helperPath: fakeHelper(`emit({ type: "started" }); setInterval(() => {}, 1000);`),
      timeoutMs: 100,
      log: () => {},
    });
    expect(await hung.finished).toBe("failed");

    const missing = startLaunchIntro({ helperPath: join(root, "nope"), log: () => {} });
    expect(await missing.finished).toBe("failed");
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
