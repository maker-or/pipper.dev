import { execFile } from "node:child_process";

/**
 * A Mac app opened from Finder or the Dock gets a minimal PATH, not the one
 * the user's terminal has. Node installed through nvm, Volta, fnm or asdf
 * lives in folders only the shell's startup files add, so `npx` — and every
 * agent launched through it — looks "not installed" to the packaged app.
 *
 * Read PATH from the user's login shell once, the way editors do, and merge
 * it into this process's PATH. Agent launches wait for it (`shellPathReady`).
 */

const START = "__PIPPER_PATH_START__";
const END = "__PIPPER_PATH_END__";
/** Heavy shell setups (nvm, conda) can take a second or two; never wait longer. */
const SHELL_TIMEOUT_MS = 5_000;

export type ShellRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultRunner: ShellRunner = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      shell,
      args,
      // No TTY and a short budget: an rc file that waits for input or never
      // returns must not hold up agent launches.
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

/** PATH from the marked block in shell output; rc files may print around it. */
export function parseMarkedPath(output: string): string | null {
  const start = output.lastIndexOf(START);
  const end = output.lastIndexOf(END);
  if (start < 0 || end <= start) return null;
  const value = output.slice(start + START.length, end).trim();
  return value || null;
}

/** Login-shell entries first (the user's own order), then any others we had. */
export function mergePathEntries(current: string, shellPath: string, delimiter = ":"): string {
  const out: string[] = [];
  for (const entry of [...shellPath.split(delimiter), ...current.split(delimiter)]) {
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out.join(delimiter);
}

/** Read the login shell's PATH; null when it can't be read. Never throws. */
export async function readLoginShellPath(
  options: { shell?: string; run?: ShellRunner; timeoutMs?: number } = {},
): Promise<string | null> {
  if (process.platform === "win32") return null;
  const shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
  // printf and $PATH work in sh, bash, zsh and fish alike (fish exports PATH
  // colon-joined to children, and `env` prints it the same everywhere).
  const command = `printf '%s' '${START}'; env | grep '^PATH=' | cut -d= -f2-; printf '%s' '${END}'`;
  try {
    const output = await (options.run ?? defaultRunner)(
      shell,
      ["-i", "-l", "-c", command],
      options.timeoutMs ?? SHELL_TIMEOUT_MS,
    );
    return parseMarkedPath(output);
  } catch {
    return null;
  }
}

/**
 * Merge the login shell's PATH into `process.env.PATH`. Returns true when
 * PATH gained entries.
 */
export async function applyLoginShellPath(options: { run?: ShellRunner } = {}): Promise<boolean> {
  const shellPath = await readLoginShellPath(options);
  if (!shellPath) return false;
  const before = process.env.PATH ?? "";
  const merged = mergePathEntries(before, shellPath);
  if (merged === before) return false;
  process.env.PATH = merged;
  return true;
}

let ready: Promise<boolean> | null = null;

/**
 * Started once at app launch; agent launches await it. Calling it before
 * launch has started also starts it, so callers never race a missing PATH.
 */
export function shellPathReady(): Promise<boolean> {
  ready ??= applyLoginShellPath();
  return ready;
}

/** Re-read the login shell (a recovery step); true when PATH changed. */
export async function refreshLoginShellPath(): Promise<boolean> {
  await shellPathReady();
  const changed = applyLoginShellPath();
  ready = changed;
  return changed;
}
