/** How long the user holds a destructive button before it confirms. */
export const HOLD_TO_CONFIRM_MS = 800;

/** With reduced motion the fill moves in this many steps instead of smoothly. */
export const REDUCED_MOTION_STEPS = 4;

/**
 * Press-and-hold timing for a destructive confirmation. The view starts it on
 * pointer down or Space/Enter, releases it on pointer up, leave or key up, and
 * calls `tick` every frame while held. Releasing early resets; completing
 * calls `onComplete` exactly once.
 */
export class HoldController {
  private startedAt: number | null = null;
  private done = false;
  private readonly options: {
    durationMs: number;
    now: () => number;
    onProgress: (progress: number) => void;
    onComplete: () => void;
  };

  constructor(options: HoldController["options"]) {
    this.options = options;
  }

  get holding(): boolean {
    return this.startedAt !== null;
  }

  get completed(): boolean {
    return this.done;
  }

  /** Begin a hold. A second start while holding (key repeat) changes nothing. */
  start(): void {
    if (this.done || this.startedAt !== null) return;
    this.startedAt = this.options.now();
    this.options.onProgress(0);
  }

  /** Let go. Before completion this cancels and drains the fill. */
  release(): void {
    if (this.done || this.startedAt === null) return;
    this.startedAt = null;
    this.options.onProgress(0);
  }

  tick(): void {
    if (this.done || this.startedAt === null) return;
    const progress = Math.min(1, (this.options.now() - this.startedAt) / this.options.durationMs);
    this.options.onProgress(progress);
    if (progress >= 1) {
      this.done = true;
      this.startedAt = null;
      this.options.onComplete();
    }
  }
}

/** The fill to draw: smooth, or in a few steps with reduced motion. */
export function displayedFill(progress: number, reducedMotion: boolean): number {
  if (!reducedMotion || progress >= 1) return progress;
  return Math.floor(progress * REDUCED_MOTION_STEPS) / REDUCED_MOTION_STEPS;
}
