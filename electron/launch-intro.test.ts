import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_LAUNCH_INTRO_VERSION,
  LAUNCH_INTRO_VERSIONS,
  launchIntroArgs,
  introWindowLayout,
  macWindowCornerRadius,
  placeIntroLayout,
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

  test("a new user sees version 2", async () => {
    const argsFile = join(root, "args");
    const session = await startFirstLaunchIntro({
      platform: "darwin",
      env: {},
      userDataDir: join(root, "userData"),
      onboardingCompleted: false,
      helperPath: fakeHelper(`
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
emit({ type: "complete" });
`),
    });
    expect(await session?.finished).toBe("complete");
    expect(FIRST_LAUNCH_INTRO_VERSION).toBe(2);
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(launchIntroArgs(2));
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

  test("ends by closing into the window it is handed", async () => {
    const commandFile = join(root, "command");
    const session = startLaunchIntro({
      helperPath: fakeHelper(`
emit({ type: "complete" });
process.stdin.on("data", (data) => {
  fs.writeFileSync(${JSON.stringify(commandFile)}, String(data));
  process.exit(0);
});
`),
      log: () => {},
    });
    expect(await session.finished).toBe("complete");
    const target = {
      x: 240,
      y: 90,
      width: 960,
      height: 720,
      radius: 16,
      color: [23, 23, 23] as [number, number, number],
    };
    session.closeInto(target);
    await waitFor(() => existsSync(commandFile));
    const command = readFileSync(commandFile, "utf8").trim();
    expect(command.startsWith("close ")).toBe(true);
    expect(JSON.parse(command.slice("close ".length))).toEqual(target);
  });

  test("draws the window it is handed, without waiting on the helper", async () => {
    const commandFile = join(root, "layout");
    const session = startLaunchIntro({
      helperPath: fakeHelper(`
process.stdin.on("data", (data) => {
  fs.writeFileSync(${JSON.stringify(commandFile)}, String(data));
  emit({ type: "complete" });
});
`),
      log: () => {},
    });
    const layout = {
      window: {
        x: 240,
        y: 90,
        width: 960,
        height: 720,
        radius: 16,
        color: [23, 23, 23] as [number, number, number],
      },
      elements: [
        {
          kind: "shape" as const,
          group: 1,
          x: 300,
          y: 200,
          width: 340,
          height: 60,
          radius: 28,
          color: [38, 38, 38, 255] as [number, number, number, number],
        },
      ],
    };
    session.drawWindow(layout);
    expect(await session.finished).toBe("complete");
    const command = readFileSync(commandFile, "utf8").trim();
    expect(command.startsWith("layout ")).toBe(true);
    expect(JSON.parse(command.slice("layout ".length))).toEqual(layout);
  });

  test("places the measured page on screen, or nothing until the picker has loaded", () => {
    const card = {
      kind: "shape" as const,
      group: 1,
      x: 100,
      y: 50,
      width: 340,
      height: 59.3,
      radius: 29.6,
      color: [38, 38, 38, 255] as [number, number, number, number],
    };
    const heading = {
      kind: "text" as const,
      group: 0,
      x: 100,
      y: 20,
      width: 99,
      height: 12.2,
      radius: 0,
      color: null,
    };
    const placed = placeIntroLayout({
      page: { background: [23, 23, 23], elements: [heading, card] },
      windowBounds: { x: 240, y: 90, width: 960, height: 720 },
      contentBounds: { x: 240, y: 90 },
      zoom: 1,
      radius: 16,
    });
    expect(placed?.window).toEqual({
      x: 240,
      y: 90,
      width: 960,
      height: 720,
      radius: 16,
      color: [23, 23, 23],
    });
    // Page pixels from the window's content origin, to the nearest half point.
    expect(placed?.elements[1]).toEqual({ ...card, x: 340, y: 140, height: 59.5, radius: 29.5 });
    expect(placed?.elements[0]).toMatchObject({
      kind: "text",
      x: 340,
      y: 110,
      width: 99,
      height: 12,
    });
    // Zoomed pages scale with it.
    const zoomed = placeIntroLayout({
      page: { background: null, elements: [card] },
      windowBounds: { x: 0, y: 0, width: 960, height: 720 },
      contentBounds: { x: 0, y: 0 },
      zoom: 1.5,
      radius: 16,
    });
    expect(zoomed?.elements[0]).toMatchObject({ x: 150, y: 75, width: 510 });
    // A page with nothing to outline (sign-in, or cards still loading).
    expect(
      placeIntroLayout({
        page: { background: [23, 23, 23], elements: [heading] },
        windowBounds: { x: 0, y: 0, width: 960, height: 720 },
        contentBounds: { x: 0, y: 0 },
        zoom: 1,
        radius: 16,
      }),
    ).toBeNull();
  });

  test("hands over the window's frame alone before its page has loaded", () => {
    expect(introWindowLayout({ x: 240, y: 90, width: 960, height: 720 }, 16, "#171717")).toEqual({
      window: { x: 240, y: 90, width: 960, height: 720, radius: 16, color: [23, 23, 23] },
      elements: [],
    });
    expect(
      introWindowLayout({ x: 0, y: 0, width: 10, height: 10 }, 10, "none").window.color,
    ).toBeNull();
  });

  test("matches the window's rounder corners from macOS 26", () => {
    expect(macWindowCornerRadius("24.6.0")).toBe(10);
    expect(macWindowCornerRadius("25.0.0")).toBe(16);
    expect(macWindowCornerRadius("27.3.0")).toBe(16);
  });

  test("plays the version it was asked for", async () => {
    expect(LAUNCH_INTRO_VERSIONS).toEqual([1, 2, 3]);
    for (const version of LAUNCH_INTRO_VERSIONS) {
      const argsFile = join(root, `args-${version}`);
      const session = startLaunchIntro({
        helperPath: fakeHelper(`
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
emit({ type: "complete" });
setInterval(() => {}, 1000);
`),
        args: launchIntroArgs(version),
        log: () => {},
      });
      expect(await session.finished).toBe("complete");
      session.kill();
      expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
        "--intro-version",
        String(version),
      ]);
    }
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
