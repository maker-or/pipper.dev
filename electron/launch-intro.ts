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
/** The intro runs about 15s before it closes into the window; past this the helper is treated as stuck. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Time the helper gets to fade out before it is killed. */
const DISMISS_GRACE_MS = 2_000;
/** Time the helper gets to close into the window (about 1.7s) before it is killed. */
const CLOSE_GRACE_MS = 5_000;

export type LaunchIntroOutcome = "complete" | "skipped" | "failed";

/**
 * Version 1: bold ripples and the @ surfacing. Version 2: subtle ripples, the
 * Pipper name, the printed line and the printed window. Version 3: version 2
 * opening on a sakura bloom through a grid of discs instead of ripples.
 */
export type LaunchIntroVersion = 1 | 2 | 3;
export const LAUNCH_INTRO_VERSIONS: readonly LaunchIntroVersion[] = [1, 2, 3];

/** What a new user sees on their first launch. */
export const FIRST_LAUNCH_INTRO_VERSION: LaunchIntroVersion = 2;

/** Helper arguments that play `version`. */
export function launchIntroArgs(version: LaunchIntroVersion): string[] {
  return ["--intro-version", String(version)];
}

/**
 * The window the intro ends in: points with the origin at the top left of the
 * menu-bar display (Electron's window bounds), its corner radius, and its
 * background as 0–255 RGB.
 */
export interface LaunchIntroCloseTarget {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  color: [number, number, number] | null;
}

/**
 * A macOS window's corner radius in points: larger from macOS 26 (Darwin 25).
 * Approximate; the hand-over to the real window hides a point or two.
 */
export function macWindowCornerRadius(darwinRelease: string): number {
  const major = Number.parseInt(darwinRelease, 10);
  return Number.isFinite(major) && major >= 25 ? 16 : 10;
}

/** One element of the window the intro draws, as the page measured it. */
export interface LaunchIntroLayoutElement {
  /** `text` is drawn as a bar; `shape` is traced round its outline. */
  kind: "shape" | "text";
  /** A card and everything in it share a group; groups are drawn in turn. */
  group: number;
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  /** 0–255 RGBA, or null for no fill. */
  color: [number, number, number, number] | null;
}

/**
 * The window the intro ends by drawing (version 2): its frame, corners and
 * background, and every element marked `data-intro-outline` in it, all in
 * screen points from the top left of the menu-bar display.
 */
export interface LaunchIntroLayout {
  window: LaunchIntroCloseTarget;
  elements: LaunchIntroLayoutElement[];
}

/**
 * Runs in the launch window (hidden while the intro plays) and measures what
 * the intro will draw, in CSS pixels from the page's top left. Elements
 * marked `data-intro-outline`:
 * - `text`: the extent of its text, not its box;
 * - `card` (and its `[data-slot="card-media"]` icon tile) and `button`: its
 *   box, corners and background; each starts a new group;
 * - `toggle`: its track (`role="switch"`) and its round thumb.
 * Colours carry each element's opacity and its parents', so a disabled
 * (half-transparent) button is drawn as it looks.
 */
export const INTRO_LAYOUT_SCRIPT = `(async () => {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0, 0, 0, 0)";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  };
  // Opacity isn't part of a background colour, so fold in the element's and
  // its parents' (a disabled button is drawn at half opacity).
  const opacityOf = (el) => {
    let opacity = 1;
    for (let node = el; node instanceof Element; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity) || 0;
    }
    return opacity;
  };
  const fillOf = (el) => {
    const colour = rgba(getComputedStyle(el).backgroundColor);
    colour[3] = Math.round(colour[3] * opacityOf(el));
    return colour[3] > 0 ? colour : null;
  };
  const box = (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height });
  const shape = (el, group) => {
    const r = el.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return { kind: "shape", group, ...box(r), radius: Math.min(radius, r.width / 2, r.height / 2), color: fillOf(el) };
  };
  const elements = [];
  let group = 0;
  for (const el of document.querySelectorAll("[data-intro-outline]")) {
    const kind = el.dataset.introOutline;
    if (kind === "text") {
      const range = document.createRange();
      range.selectNodeContents(el);
      elements.push({ kind: "text", group, ...box(range.getBoundingClientRect()), radius: 0, color: null });
    } else if (kind === "toggle") {
      const track = el.querySelector('[role="switch"]') ?? el;
      elements.push(shape(track, group));
      const thumb = track.querySelector(".rounded-full");
      if (thumb) elements.push(shape(thumb, group));
    } else {
      group += 1;
      elements.push(shape(el, group));
      const media = kind === "card" ? el.querySelector('[data-slot="card-media"]') : null;
      if (media) elements.push(shape(media, group));
    }
  }
  let background = null;
  for (let el = document.elementFromPoint(innerWidth / 2, Math.min(24, innerHeight - 1)); el; el = el.parentElement) {
    const colour = rgba(getComputedStyle(el).backgroundColor);
    if (colour[3] === 255) { background = colour.slice(0, 3); break; }
  }
  return { background, elements: elements.filter((e) => e.width > 0 && e.height > 0) };
})()`;

/**
 * The window alone, as soon as it exists, long before its page has
 * loaded: the intro needs the frame for the window it grows.
 * `background` is the window's `#rrggbb` background colour.
 */
export function introWindowLayout(
  bounds: { x: number; y: number; width: number; height: number },
  radius: number,
  background: string,
): LaunchIntroLayout {
  const hex = /^#?([0-9a-f]{6})/i.exec(background)?.[1];
  const value = hex ? Number.parseInt(hex, 16) : null;
  return {
    window: {
      ...bounds,
      radius,
      color: value === null ? null : [(value >> 16) & 255, (value >> 8) & 255, value & 255],
    },
    elements: [],
  };
}

/** What INTRO_LAYOUT_SCRIPT returns. */
export interface MeasuredIntroPage {
  background: [number, number, number] | null;
  elements: LaunchIntroLayoutElement[];
}

/**
 * Places a measured page on screen: page pixels × zoom from the window's
 * content origin. Null when there is nothing to draw (the page isn't the
 * onboarding picker yet, or its cards haven't loaded).
 */
export function placeIntroLayout(input: {
  page: MeasuredIntroPage;
  windowBounds: { x: number; y: number; width: number; height: number };
  contentBounds: { x: number; y: number };
  zoom: number;
  radius: number;
}): LaunchIntroLayout | null {
  const { page, contentBounds, zoom } = input;
  if (!page.elements.some((element) => element.kind === "shape")) return null;
  // Half points: steady enough to tell a settled page from one still moving.
  const round = (value: number) => Math.round(value * 2) / 2;
  return {
    window: {
      ...input.windowBounds,
      radius: input.radius,
      color: page.background,
    },
    elements: page.elements.map((element) => ({
      ...element,
      x: round(contentBounds.x + element.x * zoom),
      y: round(contentBounds.y + element.y * zoom),
      width: round(element.width * zoom),
      height: round(element.height * zoom),
      radius: round(element.radius * zoom),
    })),
  };
}

export interface LaunchIntroSession {
  /** Settles once; never rejects. */
  readonly finished: Promise<LaunchIntroOutcome>;
  /** Fades the overlay out and lets the helper exit. */
  dismiss(): void;
  /**
   * Draws the dark in to `target` and hands over to that window, which must
   * already be showing under the overlay. Falls back to a fade if the helper
   * can't place it.
   */
  closeInto(target: LaunchIntroCloseTarget): void;
  /**
   * The window to draw before closing into it. Ignored by the helper if it
   * arrives after the drawing would have started.
   */
  drawWindow(layout: LaunchIntroLayout): void;
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
    return {
      finished,
      dismiss: () => {},
      closeInto: () => {},
      drawWindow: () => {},
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
    else if (event.type === "error") log(`helper error: ${String(event.message)}`);
    else if (event.type === "started") log(`started (stage ${String(event.stage)})`);
    else if (event.type === "layout") log(`drawing the window (${String(event.shapes)} shapes)`);
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
    kill,
    dismiss: () => send("dismiss", DISMISS_GRACE_MS),
    closeInto: (target) => send(`close ${JSON.stringify(target)}`, CLOSE_GRACE_MS),
    drawWindow: (layout) => {
      if (child && !exited) child.stdin?.write(`layout ${JSON.stringify(layout)}\n`);
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
  return startLaunchIntro({
    helperPath: input.helperPath,
    args: launchIntroArgs(FIRST_LAUNCH_INTRO_VERSION),
  });
}
