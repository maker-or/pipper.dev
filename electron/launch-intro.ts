import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * The first-launch intro is a native overlay (native/launch-intro): subtle
 * swells darken the display, "Welcome to Pipper Code" sharpens in, and a wave
 * from the middle opens the overlay onto the onboarding window. It reports on
 * stdout in JSON lines and reads commands on stdin; closing stdin makes it
 * exit, so it never outlives this process.
 *
 * The launch window stays hidden until the helper announces the reveal
 * (`revealing`), then appears under the overlay so the wave opens onto it.
 */

const HELPER_NAME = "pipper-launch-intro";
const MARKER_FILE = "launch-intro.json";
/** The intro runs about 8s; past this the helper is treated as stuck. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Time the helper gets to fade out before it is killed. */
const DISMISS_GRACE_MS = 2_000;
export type LaunchIntroOutcome = "complete" | "skipped" | "failed";

export interface LaunchIntroSession {
  /** Settles once; never rejects. */
  readonly finished: Promise<LaunchIntroOutcome>;
  /**
   * True once the intro is about to open onto the window underneath: show the
   * window now, under the overlay. False if it ends without getting there
   * (skipped, failed), so the window is simply shown as it fades.
   */
  readonly revealing: Promise<boolean>;
  /** Fades the overlay out and lets the helper exit. */
  dismiss(): void;
  /** Removes the overlay immediately. */
  kill(): void;
}

export function resolveLaunchIntroHelperPath(input: {
  isPackaged: boolean;
  execPath: string;
  appPath: string;
}): string {
  // Packaged: electron-builder copies it next to the app executable.
  if (input.isPackaged) return posix.join(posix.dirname(input.execPath), HELPER_NAME);
  return join(input.appPath, "native", "launch-intro", "dist", HELPER_NAME);
}

/** `PIPPER_LAUNCH_INTRO=always|never` overrides the first-launch rule. */
export function shouldPlayLaunchIntro(input: {
  platform: NodeJS.Platform;
  override: string | undefined;
  onboardingCompleted: boolean;
  alreadyShown: boolean;
}): boolean {
  if (input.platform !== "darwin") return false;
  if (input.override === "never") return false;
  if (input.override === "always") return true;
  return !input.onboardingCompleted && !input.alreadyShown;
}

export async function hasShownLaunchIntro(userDataDir: string): Promise<boolean> {
  try {
    await readFile(join(userDataDir, MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

/** Written before the intro starts, so a crashing helper can't replay forever. */
export async function markLaunchIntroShown(userDataDir: string, now = new Date()): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, MARKER_FILE),
    `${JSON.stringify({ shownAt: now.toISOString() })}\n`,
  );
}

export function startLaunchIntro(input: {
  helperPath: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}): LaunchIntroSession {
  const log = input.log ?? ((message: string) => console.log(`[LaunchIntro] ${message}`));
  let reveal!: (revealing: boolean) => void;
  const revealing = new Promise<boolean>((resolve) => {
    reveal = resolve;
  });
  let settle!: (outcome: LaunchIntroOutcome) => void;
  let settled = false;
  const finished = new Promise<LaunchIntroOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log(`finished: ${outcome}`);
      // An intro that never announced a reveal won't now.
      reveal(false);
      resolve(outcome);
    };
  });

  let child: ChildProcess | null = null;
  let exited = false;
  const kill = () => {
    if (child && !exited) child.kill("SIGKILL");
    settle("failed");
  };
  const timeout = setTimeout(() => {
    log(`no completion after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    kill();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref?.();

  try {
    child = spawn(input.helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    settle("failed");
    return {
      finished,
      revealing,
      dismiss: () => {},
      kill: () => {},
    };
  }

  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) handleEvent(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => log(`stderr: ${chunk.trim()}`));
  // The helper may exit before reading a dismiss; that is not an error here.
  child.stdin?.on("error", () => {});
  child.on("error", (error) => {
    log(`helper error: ${error.message}`);
    exited = true;
    settle("failed");
  });
  child.on("exit", (code, signal) => {
    exited = true;
    if (!settled) log(`helper exited early (code ${code}, signal ${signal})`);
    settle("failed");
  });

  function handleEvent(line: string) {
    let event: { type?: unknown; [key: string]: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      log(`unreadable event: ${line}`);
      return;
    }
    if (event.type === "complete" || event.type === "skipped") settle(event.type);
    else if (event.type === "reveal") {
      log("revealing the window");
      reveal(true);
    } else if (event.type === "error") log(`helper error: ${String(event.message)}`);
    else if (event.type === "started") log(`started (stage ${String(event.stage)})`);
    else if (typeof event.message === "string") log(`${String(event.type)}: ${event.message}`);
  }

  const send = (command: string, graceMs: number) => {
    if (!child || exited) return;
    child.stdin?.write(`${command}\n`);
    const grace = setTimeout(() => {
      if (!exited) child?.kill("SIGKILL");
    }, graceMs);
    grace.unref?.();
  };

  return {
    finished,
    revealing,
    kill,
    dismiss: () => send("dismiss", DISMISS_GRACE_MS),
  };
}

/** Starts the intro if this is the first launch and the helper is present. */
export async function startFirstLaunchIntro(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  userDataDir: string;
  onboardingCompleted: boolean;
  helperPath: string;
}): Promise<LaunchIntroSession | null> {
  const play = shouldPlayLaunchIntro({
    platform: input.platform,
    override: input.env.PIPPER_LAUNCH_INTRO,
    onboardingCompleted: input.onboardingCompleted,
    alreadyShown: await hasShownLaunchIntro(input.userDataDir),
  });
  if (!play) return null;
  if (!existsSync(input.helperPath)) {
    console.warn(`[LaunchIntro] helper missing at ${input.helperPath}; skipping intro`);
    return null;
  }
  try {
    await markLaunchIntroShown(input.userDataDir);
  } catch (error) {
    console.warn("[LaunchIntro] could not record the intro; skipping it", error);
    return null;
  }
  return startLaunchIntro({ helperPath: input.helperPath });
}
