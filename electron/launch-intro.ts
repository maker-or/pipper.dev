import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * The first-launch intro is a native overlay (native/launch-intro) that darkens
 * the whole display. It reports on stdout in JSON lines and reads commands on
 * stdin; closing stdin makes it exit, so it never outlives this process.
 *
 * The launch window stays hidden until the intro finishes, then appears under
 * the overlay while it fades out.
 */

const HELPER_NAME = "pipper-launch-intro";
const MARKER_FILE = "launch-intro.json";
/** The intro runs about 4.3s; past this the helper is treated as stuck. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Time the helper gets to fade out before it is killed. */
const DISMISS_GRACE_MS = 2_000;

export type LaunchIntroOutcome = "complete" | "skipped" | "failed";

export interface LaunchIntroSession {
  /** Settles once; never rejects. */
  readonly finished: Promise<LaunchIntroOutcome>;
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
  args?: string[];
  timeoutMs?: number;
  log?: (message: string) => void;
}): LaunchIntroSession {
  const log = input.log ?? ((message: string) => console.log(`[LaunchIntro] ${message}`));
  let settle!: (outcome: LaunchIntroOutcome) => void;
  let settled = false;
  const finished = new Promise<LaunchIntroOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      log(`finished: ${outcome}`);
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
    child = spawn(input.helperPath, input.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    settle("failed");
    return { finished, dismiss: () => {}, kill: () => {} };
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
    else if (event.type === "error") log(`helper error: ${String(event.message)}`);
    else if (event.type === "started") log(`started (stage ${String(event.stage)})`);
  }

  return {
    finished,
    kill,
    dismiss() {
      if (!child || exited) return;
      child.stdin?.write("dismiss\n");
      const grace = setTimeout(() => {
        if (!exited) child?.kill("SIGKILL");
      }, DISMISS_GRACE_MS);
      grace.unref?.();
    },
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
