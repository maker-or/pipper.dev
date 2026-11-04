import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { GitBranch, Worktree } from "../contracts/worktrees.ts";

/**
 * Worktree ("workspace") support — Phase 1: create + list.
 *
 * Git is the source of truth: every worktree is reported by
 * `git worktree list --porcelain` and persisted in `.git/worktrees/`. This
 * module is deliberately electron-free (only node builtins) so it can be unit
 * tested without mocking the app, and stateless (plain functions, matching
 * `projects.ts`/`threads.ts`) — there is no app-only state to hold this phase.
 *
 * Every Git and setup-script process runs asynchronously with a deadline so a
 * slow remote, a credential helper or a stuck script can never freeze the
 * Electron main process. Mutations are serialized per repository (see
 * `withRepositoryLock`); unrelated repositories proceed independently.
 */

/** Default gitignored files seeded into a fresh worktree. */
const DEFAULT_INCLUDE_GLOBS = [".env*"];

/**
 * Never copied during the env seed even if a custom include list matches them —
 * these are the setup script's job (it may symlink them into the main checkout).
 */
const SEED_EXCLUSIONS = new Set(["node_modules", "dist", "out", "build", ".git", ".cache"]);
const GENERATED_BRANCH_PREFIX = "pipper/";

/**
 * Git hooks export repository-local state for the repository being committed.
 * Worktree commands may target a different repository, so those variables must
 * not leak into child Git processes. Shared by every module that spawns git
 * (worktrees, workspace git panel, file tree) so the sanitation stays in one
 * place.
 */
export function foreignGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "GIT_ALTERNATE_OBJECT_DIRECTORIES" ||
      key === "GIT_COMMON_DIR" ||
      key === "GIT_DIR" ||
      key === "GIT_GRAFT_FILE" ||
      key === "GIT_IMPLICIT_WORK_TREE" ||
      key === "GIT_INDEX_FILE" ||
      key === "GIT_OBJECT_DIRECTORY" ||
      key === "GIT_PREFIX" ||
      key === "GIT_REPLACE_REF_BASE" ||
      key === "GIT_SHALLOW_FILE" ||
      key === "GIT_WORK_TREE" ||
      key.startsWith("GIT_CONFIG")
    ) {
      delete env[key];
    }
  }
  return env;
}

export interface CreateWorktreeOptions {
  /** The project's repo root — the `git worktree add` anchor. */
  projectPath: string;
  /** Stable, fs-safe project identity (its `id`), used for the on-disk slug. */
  projectId: string;
  /** Human label; derives the leaf dir name and the auto branch. */
  name: string;
  /** Explicit branch name; auto-generated Conductor-style when omitted. */
  branch?: string;
  /**
   * Override the gitignored-file include list. Precedence otherwise:
   * `.worktreeinclude` (repo root) → this → default `.env*`.
   * Custom patterns *replace* the default (they don't merge).
   */
  includeGlobs?: string[];
  /**
   * Trusted, user-authored command run once after create with
   * `WORKSPACE_PATH` / `ROOT_PATH` / `WORKSPACE_NAME` in env. May deliberately
   * reach into the main checkout (e.g. symlink `node_modules`).
   */
  setupScript?: string;
  /** Deadline for `setupScript`; its whole process group is stopped after it. */
  setupScriptTimeoutMs?: number;
}

/**
 * Root under which all worktrees live: `~/.pipper/worktrees` (Conductor style),
 * overridable via `PIPPER_WORKTREES_PATH`. A home dotdir, distinct from the
 * app's self-update library (`~/Library/pipper` on macOS) — no collision.
 */
export function getWorktreesRoot(): string {
  return process.env.PIPPER_WORKTREES_PATH || join(homedir(), ".pipper", "worktrees");
}

/** Lowercase, fs-safe slug; falls back to "workspace" when nothing survives. */
function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "workspace";
}

/** `<root>/<projectId>/<name-slug>` — outside the main working tree. */
export function worktreePathFor(projectId: string, name: string): string {
  return join(getWorktreesRoot(), projectId, slugify(name));
}

const GIT_CANDIDATES =
  process.platform === "win32"
    ? [
        join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "cmd", "git.exe"),
        join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "bin", "git.exe"),
        join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "cmd", "git.exe"),
      ]
    : ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git", "/bin/git"];

let cachedGitBinary: { pathEnv: string; value: string } | null = null;

/**
 * Absolute git binary: PATH-independent so GUI launches work too.
 * Memoized per PATH value — this runs before *every* git spawn and the probe
 * walks the filesystem. A PATH edit (dependency installer prepending Homebrew
 * etc.) invalidates the cache; a failed probe is never cached so a mid-session
 * git install is still picked up.
 */
export function gitBinary(): string {
  const pathEnv = process.env.PATH ?? "";
  if (cachedGitBinary && cachedGitBinary.pathEnv === pathEnv) return cachedGitBinary.value;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const exe = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(normalize(dir), exe);
    try {
      if (existsSync(candidate)) {
        cachedGitBinary = { pathEnv, value: candidate };
        return candidate;
      }
    } catch {
      /* keep probing */
    }
  }
  for (const candidate of GIT_CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        cachedGitBinary = { pathEnv, value: candidate };
        return candidate;
      }
    } catch {
      /* keep probing */
    }
  }
  // Last resort: let the OS resolve it (throws ENOENT with a clear message).
  return "git";
}

/**
 * Deadlines for child processes. Local Git commands finish in milliseconds;
 * anything near the limit is stuck (a lock held by a crashed process, a
 * filesystem that stopped responding). Remote commands get the long-standing
 * one-minute budget. Setup scripts are user-authored and may install
 * dependencies, so they get the same ten minutes as the dependency installer.
 */
const commandTimeouts = {
  gitMs: 30_000,
  gitNetworkMs: 60_000,
  setupScriptMs: 10 * 60_000,
};

/** Test hook: shorten deadlines so a hung command can be observed quickly. */
export function setWorktreeCommandTimeoutsForTests(
  overrides: Partial<typeof commandTimeouts>,
): () => void {
  const previous = { ...commandTimeouts };
  Object.assign(commandTimeouts, overrides);
  return () => Object.assign(commandTimeouts, previous);
}

/** Grace period between SIGTERM and SIGKILL for a timed-out process group. */
export const KILL_GRACE_MS = 2_000;
/** Keep only the tail of stderr: enough to explain a failure, bounded memory. */
const STDERR_TAIL_BYTES = 8 * 1024;
/** Listings are proportional to branches/worktrees; refuse pathological output. */
const STDOUT_LIMIT_BYTES = 64 * 1024 * 1024;

export type WorktreeCommandFailure = "exit" | "timeout" | "spawn" | "output-limit";

/**
 * A Git or setup-script process that did not succeed. `kind` distinguishes a
 * non-zero exit from a deadline, a binary that could not start, and runaway
 * output, so callers and logs never have to parse the message.
 */
export class WorktreeCommandError extends Error {
  readonly kind: WorktreeCommandFailure;
  /** `git <subcommand>` or `setup script` — never the script body. */
  readonly operation: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timeoutMs: number;

  constructor(details: {
    kind: WorktreeCommandFailure;
    operation: string;
    cwd: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    timeoutMs: number;
    cause?: unknown;
  }) {
    const stderr = (details.stderr ?? "").trim();
    const reason =
      details.kind === "timeout"
        ? `timed out after ${details.timeoutMs} ms`
        : details.kind === "spawn"
          ? `could not start${details.cause instanceof Error ? `: ${details.cause.message}` : ""}`
          : details.kind === "output-limit"
            ? "produced too much output"
            : details.signal
              ? `was terminated by ${details.signal}`
              : `exited with code ${details.exitCode}`;
    super(`${details.operation} ${reason}${stderr ? `\n${stderr}` : ""}`, {
      cause: details.cause,
    });
    this.name = "WorktreeCommandError";
    this.kind = details.kind;
    this.operation = details.operation;
    this.cwd = details.cwd;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = stderr;
    this.timeoutMs = details.timeoutMs;
  }
}

/**
 * Stop a child and everything it started, resolving once the tree is down.
 * POSIX children are spawned as process-group leaders so a shell's own
 * children (`sleep`, a hook, a package manager) die with it; Windows uses
 * `taskkill /T /F` for the same tree semantics.
 */
function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve());
    });
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
    }
  };
  // `close` fires once the leader exited and every holder of its stdio pipes
  // (the children that could still be writing) has gone.
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    child.once("close", () => resolve());
  });
  const within = (ms: number) =>
    Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, ms).unref())]);
  signalGroup("SIGTERM");
  return within(KILL_GRACE_MS).then(() => {
    // Always signal the group: the leader may exit on SIGTERM while children
    // that ignore it keep running.
    signalGroup("SIGKILL");
    return within(KILL_GRACE_MS);
  });
}

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  operation: string;
  stdout: "pipe" | "ignore";
}

/**
 * Run a process without blocking the event loop. Resolves with stdout on exit
 * code 0; otherwise rejects with a `WorktreeCommandError`. On timeout (or the
 * output limit) the promise rejects only after the whole process group was
 * stopped (SIGTERM, then SIGKILL after `KILL_GRACE_MS`), so callers can roll
 * back or release the repository queue without a hook still writing.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let stopping = false;
    const settle = (error: WorktreeCommandError | null, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    };
    const fail = (
      kind: WorktreeCommandFailure,
      extra: { exitCode?: number | null; signal?: NodeJS.Signals | null; cause?: unknown } = {},
    ) =>
      new WorktreeCommandError({
        kind,
        operation: options.operation,
        cwd: options.cwd,
        stderr: stderrTail,
        timeoutMs: options.timeoutMs,
        ...extra,
      });

    let stderrTail = "";
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", options.stdout, "pipe"],
        // Own process group (POSIX) so a timeout can stop the whole tree. It
        // also drops the controlling terminal, so Git can never block on a
        // `/dev/tty` credential prompt nobody will answer.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(fail("spawn", { cause: error }));
      return;
    }

    const stop = (error: WorktreeCommandError) => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      void killProcessTree(child).then(() => settle(error));
    };
    const timer = setTimeout(() => stop(fail("timeout")), options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        stop(fail("output-limit"));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("error", (error) => {
      if (!stopping) settle(fail("spawn", { cause: error }));
    });
    child.on("close", (exitCode, signal) => {
      // A stopped command settles with its timeout/limit error once the tree is down.
      if (stopping) return;
      if (exitCode === 0) settle(null, Buffer.concat(stdoutChunks).toString("utf8"));
      else settle(fail("exit", { exitCode, signal }));
    });
  });
}

/**
 * Run git against `cwd` and return trimmed stdout. stderr is captured (not
 * inherited): several probes below expect failure and catch it — inheriting
 * would spam the app log with `fatal:` noise.
 */
async function git(
  cwd: string,
  args: string[],
  timeoutMs = commandTimeouts.gitMs,
): Promise<string> {
  const stdout = await runCommand(gitBinary(), args, {
    cwd,
    env: foreignGitEnv(),
    timeoutMs,
    operation: `git ${args[0] ?? ""}`.trim(),
    stdout: "pipe",
  });
  return stdout.trim();
}

/** True when the git command exits 0; any failure (including a timeout) is false. */
async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repository identity for mutation ordering: the shared Git directory, so two
 * projects registered at different subdirectories (or linked worktrees) of one
 * repository still take turns. Cached because it cannot change for a path
 * without the repository being replaced; failures fall back to the path.
 */
const repositoryKeyCache = new Map<string, string>();

async function repositoryKey(projectPath: string): Promise<string> {
  const pathKeyValue = worktreeCacheKey(projectPath);
  const cached = repositoryKeyCache.get(pathKeyValue);
  if (cached) return cached;
  try {
    const commonDir = await git(projectPath, ["rev-parse", "--git-common-dir"]);
    const key = canonical(resolve(projectPath, commonDir));
    repositoryKeyCache.set(pathKeyValue, key);
    return key;
  } catch {
    return pathKeyValue;
  }
}

const repositoryQueues = new Map<string, Promise<void>>();

/**
 * Run `task` after every earlier mutation of the same repository has settled.
 * Git guards its refs and `.git/worktrees` with lock files and fails (rather
 * than waits) on contention, so two concurrent mutations of one repository
 * would race into spurious errors and half-rolled-back state. Different
 * repositories never wait on each other, and reads do not take this lock.
 *
 * Tasks must not call another locked entry point (that would deadlock); the
 * public functions below lock once and use unlocked helpers inside. Workspace
 * Git mutations (commit, merge, init in `git-workspace.ts`) take the same lock.
 */
export async function withRepositoryLock<T>(
  projectPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = await repositoryKey(projectPath);
  const previous = repositoryQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  repositoryQueues.set(key, tail);
  void tail.then(() => {
    if (repositoryQueues.get(key) === tail) repositoryQueues.delete(key);
  });
  return run;
}

/**
 * The project's location inside its checkout, relative to the worktree root
 * (`""` when the project *is* the root). A project registered at
 * `repo/packages/app` must map to `<worktree>/packages/app` in every linked
 * worktree — the checkout is always the whole repository, but the agent,
 * terminals and dependency detection must run in the project directory.
 */
async function projectSubpath(projectPath: string): Promise<string> {
  const key = worktreeCacheKey(projectPath);
  const cached = projectSubpathCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const toplevel = await git(projectPath, ["rev-parse", "--show-toplevel"]);
    const rel = relative(canonical(toplevel), canonical(projectPath));
    const value = rel === "." ? "" : rel;
    projectSubpathCache.set(key, { expiresAt: Date.now() + PROJECT_GIT_META_TTL_MS, value });
    return value;
  } catch {
    // Never cache a failure: a transient git error would otherwise pin the
    // empty subpath for the TTL and point every linked worktree at its
    // checkout root instead of the project subdirectory.
    return "";
  }
}

/**
 * Root of the checkout containing `path` — what `git worktree remove` needs.
 * Walks up when the project subdirectory itself is missing from the checkout
 * (a branch that predates it) so removal still finds the worktree.
 */
async function worktreeRootOf(path: string): Promise<string> {
  let probe = path;
  for (;;) {
    if (existsSync(probe)) {
      try {
        return await git(probe, ["rev-parse", "--show-toplevel"]);
      } catch {
        return path;
      }
    }
    const parent = dirname(probe);
    if (parent === probe) return path;
    probe = parent;
  }
}

/**
 * The repo's default branch to base new worktrees on. Refresh and use the
 * remote-tracking default branch when origin advertises one; local branch
 * names are ambiguous to Git and can silently select a stale local branch.
 */
async function resolveBaseBranch(projectPath: string): Promise<string> {
  const prefix = "refs/remotes/origin/";
  const usable = (ref: string) =>
    gitSucceeds(projectPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  let cached: string | null = null;
  try {
    const ref = await git(projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (ref.startsWith(prefix) && (await usable(ref))) cached = ref;
  } catch {
    // Origin may have no local HEAD yet.
  }
  try {
    // Ask the remote: the local symbolic ref can outlive a default-branch rename.
    const advertised = await git(
      projectPath,
      ["ls-remote", "--symref", "origin", "HEAD"],
      commandTimeouts.gitNetworkMs,
    );
    const branch = /^ref: refs\/heads\/(.+)	HEAD$/m.exec(advertised)?.[1];
    if (branch) {
      await git(projectPath, ["check-ref-format", `refs/heads/${branch}`]);
      const tracking = `${prefix}${branch}`;
      await git(
        projectPath,
        ["fetch", "origin", `+refs/heads/${branch}:${tracking}`],
        commandTimeouts.gitNetworkMs,
      );
      if (await usable(tracking)) {
        // Only point origin/HEAD at a tracking ref that now exists.
        await git(projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD", tracking]);
        return tracking;
      }
    }
  } catch {
    // Offline/authentication/timeout: use only a verified cached or local commit.
  }
  if (cached) return cached;
  const current = await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const local = current && current !== "HEAD" ? `refs/heads/${current}` : "HEAD";
  if (await usable(local)) return local;
  throw new Error("No usable base commit for this workspace.");
}

/** True when a branch ref already exists locally. */
function branchExists(projectPath: string, branch: string): Promise<boolean> {
  return gitSucceeds(projectPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/**
 * Auto branch name, Conductor style: `pipper/<name-slug>`, suffixed `-2`, `-3`…
 * on collision. The agent renames it on first chat.
 */
async function resolveBranchName(projectPath: string, name: string): Promise<string> {
  const base = `${GENERATED_BRANCH_PREFIX}${slugify(name)}`;
  if (!(await branchExists(projectPath, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await branchExists(projectPath, candidate))) return candidate;
  }
  throw new Error(`Could not find a free branch name for "${name}".`);
}

/** Convert a gitignore-ish glob (only `*`/`?`) to an anchored regex. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * The gitignored-file include list. Precedence: `.worktreeinclude` (repo root,
 * one gitignore-style pattern per line, `#` comments) → explicit override →
 * default `.env*`. Custom patterns replace the default.
 */
function resolveIncludeGlobs(projectPath: string, override?: string[]): string[] {
  const file = join(projectPath, ".worktreeinclude");
  if (existsSync(file)) {
    try {
      const patterns = readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (patterns.length > 0) return patterns;
    } catch {
      // fall through to override/default
    }
  }
  if (override && override.length > 0) return override;
  return DEFAULT_INCLUDE_GLOBS;
}

let cachedUserSid: string | null = null;

const WORKTREE_CACHE_TTL_MS = 500;
const worktreeCache = new Map<string, { expiresAt: number; value: Worktree[] }>();
const worktreeListsInFlight = new Map<string, Promise<Worktree[]>>();
/** Bumped by every invalidation so an in-flight read cannot cache stale data. */
const worktreeCacheGeneration = new Map<string, number>();

/**
 * Slow-moving per-project git facts (the project's subpath inside its repo,
 * the origin default branch). Each used to cost a git spawn on every fresh
 * `listWorktrees` — three subprocesses per sidebar refresh instead of one.
 * A modest TTL keeps external changes (e.g. a re-pointed origin/HEAD) visible
 * without paying for them on every poll; worktree mutations invalidate
 * immediately.
 */
const PROJECT_GIT_META_TTL_MS = 30_000;
const projectSubpathCache = new Map<string, { expiresAt: number; value: string }>();
const remoteDefaultBranchCache = new Map<string, { expiresAt: number; value: string | null }>();

function worktreeCacheKey(projectPath: string): string {
  return normalize(resolve(projectPath));
}

function invalidateWorktreeCache(projectPath: string): void {
  const key = worktreeCacheKey(projectPath);
  worktreeCache.delete(key);
  worktreeListsInFlight.delete(key);
  worktreeCacheGeneration.set(key, (worktreeCacheGeneration.get(key) ?? 0) + 1);
  projectSubpathCache.delete(key);
  remoteDefaultBranchCache.delete(key);
}

/** The current user's SID (`S-1-5-…`). Cached: it cannot change mid-process. */
function currentUserSid(): string {
  if (cachedUserSid) return cachedUserSid;
  // `whoami /user /fo csv /nh` prints `"HOST\user","S-1-5-21-…"`.
  const stdout = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The SID is the trailing field; take the last match so an exotic host or
  // account name in the leading `HOST\user` field can't shadow it.
  const sid = stdout.match(/S-1-[\d-]+/g)?.at(-1);
  if (!sid) throw new Error("Could not resolve the current user's SID");
  cachedUserSid = sid;
  return sid;
}

/**
 * Restrict a file to its owner: no other *user* of the machine can read it.
 *
 * POSIX spells this as mode 0600. Windows has no POSIX mode bits — `chmod`
 * there only toggles the read-only flag, and `stat` reports 0o666 whatever you
 * do — so a seeded secret would otherwise keep the ACEs it inherited from the
 * parent directory. The equivalent is an explicit DACL: drop the inherited
 * ACEs, then grant this user.
 *
 * SYSTEM and Administrators survive this, because the file is created with the
 * process token's default DACL and those entries are explicit rather than
 * inherited. That is deliberate: an administrator can take ownership of any
 * file regardless of its DACL, so removing them buys nothing and would break
 * backup and antimalware services. Mode 0600 does not exclude root either.
 *
 * The owner gets full control rather than a literal read/write analogue of
 * 0600: `(R,W)` alone withholds DELETE, which would break the user's own tools
 * rewriting the file.
 *
 * Throws when the restriction cannot be applied, so the caller can delete the
 * file rather than leave a secret readable.
 */
function restrictToOwner(filePath: string): void {
  if (process.platform !== "win32") {
    chmodSync(filePath, 0o600);
    return;
  }
  // Grant against the SID rather than the account name: it is unambiguous
  // across domains and immune to the localized names icacls prints. Numeric
  // SIDs must carry the `*` prefix. Exit status, not the localized stdout, is
  // what signals failure here.
  execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `*${currentUserSid()}:(F)`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Copy gitignored files matching the include list from the project root into the
 * worktree: allowlist-driven, top-level only, restricted to the owner,
 * destination asserted inside the worktree root, symlinked sources not
 * followed, existing (tracked) files never clobbered.
 */
function seedGitignoredFiles(projectPath: string, worktreePath: string, override?: string[]): void {
  const globs = resolveIncludeGlobs(projectPath, override).map(globToRegExp);
  const worktreeReal = resolve(worktreePath);

  let entries: string[];
  try {
    entries = readdirSync(projectPath);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SEED_EXCLUSIONS.has(entry)) continue;
    if (!globs.some((re) => re.test(entry))) continue;

    const src = join(projectPath, entry);
    // Never follow a symlinked source: it could resolve outside the project and
    // hand the worktree a writable path back into another tree.
    let stat;
    try {
      stat = lstatSync(src);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // skips symlinks and directories

    const dest = join(worktreePath, entry);
    // Assert the destination stays inside the worktree root.
    const rel = relative(worktreeReal, resolve(dest));
    if (rel.startsWith("..") || rel === "") continue;
    // Don't clobber blindly — a tracked file of the same name is already present.
    if (existsSync(dest)) continue;

    let created = false;
    try {
      const contents = readFileSync(src);
      // Create the destination owner-only *before* the secret lands in it, and
      // write through the handle: `copyFileSync` would reset the mode to the
      // source's, leaving the secret briefly world-readable. `wx` also makes
      // the no-clobber rule above atomic rather than check-then-act.
      const fd = openSync(dest, "wx", 0o600);
      created = true;
      try {
        writeFileSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      // Windows ignores the mode above; this is what actually restricts it
      // there, and normalizes an unusual umask on POSIX.
      restrictToOwner(dest);
    } catch {
      // Fail closed: a secret we could not restrict to its owner must not be
      // left behind. One bad file still doesn't abort the create.
      if (created) {
        try {
          rmSync(dest, { force: true });
        } catch {
          // nothing further we can do for this file
        }
      }
    }
  }
}

/** How a worktree's dependencies get installed, detected from its lockfile. */
export interface WorktreeInstallCommand {
  /** Package manager binary (resolved via PATH). */
  command: string;
  args: string[];
  /** Display name for progress UI. */
  manager: "bun" | "pnpm" | "yarn" | "npm";
}

/**
 * The install command for a freshly created worktree, or null when the project
 * has no Node dependency manifest (non-JS projects install nothing). Lockfile
 * wins over any default so the install matches how the project is actually
 * managed; a bare `package.json` falls back to npm. Project dependencies are
 * owned by the project and are not installed by Pipper.
 */
export function resolveInstallCommand(worktreePath: string): WorktreeInstallCommand | null {
  const has = (file: string) => existsSync(join(worktreePath, file));
  if (!has("package.json")) return null;
  if (has("bun.lock") || has("bun.lockb")) {
    return { command: "bun", args: ["install"], manager: "bun" };
  }
  if (has("pnpm-lock.yaml")) {
    return { command: "pnpm", args: ["install"], manager: "pnpm" };
  }
  if (has("yarn.lock")) {
    return { command: "yarn", args: ["install"], manager: "yarn" };
  }
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) {
    return { command: "npm", args: ["install"], manager: "npm" };
  }
  return { command: "npm", args: ["install"], manager: "npm" };
}

async function runSetupScript(
  script: string,
  ctx: { worktreePath: string; rootPath: string; name: string; timeoutMs: number },
): Promise<void> {
  await runCommand(process.platform === "win32" ? "cmd" : "/bin/sh", ["-c", script], {
    cwd: ctx.worktreePath,
    env: {
      ...foreignGitEnv(),
      WORKSPACE_PATH: ctx.worktreePath,
      ROOT_PATH: ctx.rootPath,
      WORKSPACE_NAME: ctx.name,
    },
    timeoutMs: ctx.timeoutMs,
    operation: "Workspace setup script",
    // Output is not shown anywhere; only the stderr tail explains a failure.
    stdout: "ignore",
  });
}

/**
 * Undo a create that failed part-way, touching only what this create made:
 * the worktree registration and directory (the path was verified absent
 * before `git worktree add`) and the branch (verified absent too). Never
 * throws — cleanup must not mask the original failure. Caller holds the
 * repository lock.
 */
async function rollBackCreatedWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  invalidateWorktreeCache(projectPath);
  try {
    await git(projectPath, ["worktree", "remove", worktreePath, "--force"]);
  } catch {
    // Best effort cleanup of worktree registration (it may never have been added).
  }
  try {
    await git(projectPath, ["branch", "-D", branch]);
  } catch {
    // Best effort cleanup of branch
  }
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Best effort cleanup of directory
  }
  invalidateWorktreeCache(projectPath);
}

/**
 * Create a worktree off `projectPath`: add the git worktree on a fresh branch,
 * seed gitignored files (`.env*`), then run the optional setup script.
 *
 * The returned `path` is the *project's* directory inside the new checkout —
 * identical to the checkout root unless the project is registered at a
 * repository subdirectory (see `projectSubpath`).
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const { projectPath, projectId, name } = options;
  // A project can be registered as a subdirectory of a repository, so the
  // Git directory may live above projectPath (and may be a file for a
  // linked worktree). Ask Git instead of inspecting only projectPath/.git.
  if (!(await gitSucceeds(projectPath, ["rev-parse", "--git-dir"]))) {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  const worktreePath = worktreePathFor(projectId, name);
  // Branch choice, base refresh and `worktree add` are one repository
  // mutation: holding the lock keeps a concurrent create from claiming the
  // same branch or path between the existence checks and the add.
  const { branch, projectDir } = await withRepositoryLock(projectPath, async () => {
    if (existsSync(worktreePath)) {
      throw new Error(`A worktree already exists at ${worktreePath}`);
    }
    const branch = options.branch ?? (await resolveBranchName(projectPath, name));
    if (await branchExists(projectPath, branch)) {
      throw new Error(`Branch already exists: ${branch}`);
    }
    const base = await resolveBaseBranch(projectPath);
    // Where the project lives inside the new checkout: everything after the
    // checkout itself (env seed, setup script, the returned path) targets it.
    const projectDir = join(worktreePath, await projectSubpath(projectPath));

    // `git worktree add` needs the leaf absent but the parent present.
    mkdirSync(dirname(worktreePath), { recursive: true });

    try {
      // The base is a starting point, not this feature branch's push
      // destination. Remote bases otherwise inherit tracking to origin/main.
      await git(projectPath, ["worktree", "add", "--no-track", worktreePath, "-b", branch, base]);
    } catch (err) {
      // A failed or timed-out add can leave the branch, the registration or
      // a partial checkout behind; all three were verified absent above.
      await rollBackCreatedWorktree(projectPath, worktreePath, branch);
      throw err;
    }
    invalidateWorktreeCache(projectPath);
    return { branch, projectDir };
  });

  try {
    // 2. Seed gitignored files (untrusted data, allowlisted, contained).
    seedGitignoredFiles(projectPath, projectDir, options.includeGlobs);

    // 3. Setup script (trusted, user-authored, may touch the main checkout).
    // It runs outside the repository lock: it may take minutes and only
    // touches the new checkout, so other workspaces of this repository need
    // not wait for it.
    if (options.setupScript) {
      await runSetupScript(options.setupScript, {
        worktreePath: projectDir,
        rootPath: projectPath,
        name,
        timeoutMs: options.setupScriptTimeoutMs ?? commandTimeouts.setupScriptMs,
      });
    }
  } catch (err) {
    await withRepositoryLock(projectPath, () =>
      rollBackCreatedWorktree(projectPath, worktreePath, branch),
    );
    throw err;
  }

  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  // Same canonical form `listWorktrees` returns, so callers can match/exclude
  // entries from `git worktree list`.
  return { path: canonical(projectDir), branch, head, createdAtMs: Date.now() };
}

/**
 * Best-effort removal of a worktree created for a request that later failed
 * (e.g. agent spawn/prompt error). Never throws — cleanup must not mask the
 * original failure. `worktreePath` may be the project directory inside the
 * checkout; removal always targets the checkout root.
 */
export async function removeWorktreeBestEffort(
  projectPath: string,
  worktreePath: string,
  branch: string | null,
): Promise<void> {
  try {
    await withRepositoryLock(projectPath, async () => {
      const root = await worktreeRootOf(worktreePath);
      try {
        await git(projectPath, ["worktree", "remove", root, "--force"]);
      } catch {
        // Best effort cleanup of worktree registration
      }
      if (branch) {
        try {
          await git(projectPath, ["branch", "-D", branch]);
        } catch {
          // Best effort cleanup of branch
        }
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // Best effort cleanup of directory
      }
    });
  } catch {
    // Never throws (see above).
  }
  invalidateWorktreeCache(projectPath);
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreePorcelain(stdout: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let path: string | null = null;
  let head = "";
  let branch: string | null = null;
  let prunable = false;

  const flush = () => {
    if (path) worktrees.push({ path, head, branch, missing: prunable });
    path = null;
    head = "";
    branch = null;
    prunable = false;
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      // A new record starts; flush any in-progress one (defensive vs missing blank line).
      if (path) flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      // e.g. "branch refs/heads/main" → "main"
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      branch = null;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      // Git's own verdict that this checkout is gone; the reason follows on
      // the same line for some causes (e.g. "gitdir file points to non-existent
      // location"). Either way the entry is unusable.
      prunable = true;
    }
  }
  flush();
  return worktrees;
}

/**
 * List worktrees from a short-lived cache. Includes the main tree.
 *
 * Every `path` is the *project's* directory inside that checkout: for a
 * project registered at a repository subdirectory the entries point at the
 * same subdirectory of each worktree, so the root entry is the project path
 * itself and linked entries are where the agent/terminals should run.
 */
export async function listWorktrees(projectPath: string): Promise<Worktree[]> {
  const cacheKey = worktreeCacheKey(projectPath);
  const cached = worktreeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  // Sidebar, title bar and git panel refresh together: share one Git read
  // instead of spawning a listing per caller.
  const inFlight = worktreeListsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const generation = worktreeCacheGeneration.get(cacheKey) ?? 0;
  const listing = readWorktrees(projectPath).finally(() => {
    if (worktreeListsInFlight.get(cacheKey) === listing) worktreeListsInFlight.delete(cacheKey);
  });
  worktreeListsInFlight.set(cacheKey, listing);
  const result = await listing;
  // A mutation that finished while this read ran invalidated the cache; its
  // result may predate that mutation, so it must not repopulate the cache.
  if ((worktreeCacheGeneration.get(cacheKey) ?? 0) === generation) {
    worktreeCache.set(cacheKey, { expiresAt: Date.now() + WORKTREE_CACHE_TTL_MS, value: result });
  }
  return result;
}

async function readWorktrees(projectPath: string): Promise<Worktree[]> {
  const [stdout, subpath] = await Promise.all([
    git(projectPath, ["worktree", "list", "--porcelain"]),
    projectSubpath(projectPath),
  ]);
  const projectRoot = pathKey(projectPath);
  // Canonicalize up front so every path this module hands out is in one form.
  // Git reports POSIX separators and long names on Windows; callers compare
  // these against `createWorktree` results and stored paths, so the two must
  // agree exactly.
  const worktrees = parseWorktreePorcelain(stdout).map((worktree) => {
    // A linked worktree checked out on a branch that predates the project
    // subdirectory has no such dir — fall back to the checkout root rather
    // than handing out a path that doesn't exist (git status, terminals and
    // thread cwds would all fail on it).
    const nested = subpath ? join(worktree.path, subpath) : worktree.path;
    const path = canonical(existsSync(nested) ? nested : worktree.path);
    return {
      ...worktree,
      path,
      // Git only marks an entry prunable once it notices; a directory removed
      // out from under it reads as present until then.
      missing: worktree.missing || !existsSync(path),
    };
  });
  // git lists the main working tree first; use it as the root when the project
  // path still doesn't canonical-match any entry (defensive: keeps exactly one
  // root so the UI can always resolve a current workspace).
  const rootEntry =
    worktrees.find((worktree) => pathKey(worktree.path) === projectRoot) ?? worktrees[0];
  const rootLabel = rootEntry
    ? await resolveRepositoryDefaultBranch(projectPath, rootEntry.branch)
    : null;

  return (
    worktrees
      // A checkout that is gone is not a workspace: nothing can run there, and
      // git keeps listing it until `git worktree prune`. Drop it so it never
      // reaches the sidebar, a thread cwd, or a git status read. The root is
      // never dropped — the UI must always resolve exactly one.
      .filter((worktree) => !worktree.missing || worktree === rootEntry)
      .map((worktree) => {
        // Identity, not path comparison: guarantees exactly one root entry even when
        // canonicalization differs, so the UI always resolves a current workspace.
        const isProjectRoot = worktree === rootEntry;
        return {
          ...worktree,
          isProjectRoot,
          workspaceName: isProjectRoot
            ? (rootLabel ?? worktree.branch ?? "main")
            : (worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "worktree"),
          // Git lists linked worktrees in readdir order (arbitrary) — stamp the
          // directory creation time so UIs can sort newest-first deterministically.
          createdAtMs: isProjectRoot ? undefined : dirBirthMs(worktree.path),
        };
      })
  );
}

/**
 * Directory creation time for newest-first workspace sorting. Prefers
 * birthtime; falls back to ctime on filesystems without it. Undefined when
 * the path cannot be stated (sorts last).
 */
function dirBirthMs(path: string): number | undefined {
  try {
    const stat = statSync(path);
    const birth = stat.birthtimeMs;
    if (birth > 0) return birth;
    if (stat.ctimeMs > 0) return stat.ctimeMs;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Git does not persist a display name for the root checkout. Prefer the
 * repository's advertised default branch, then its branch at the configured
 * project root. This intentionally never assumes a branch name in the UI.
 */
async function resolveRepositoryDefaultBranch(
  projectPath: string,
  rootBranch: string | null,
): Promise<string | null> {
  const key = worktreeCacheKey(projectPath);
  const cached = remoteDefaultBranchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value ?? rootBranch;
  let value: string | null = null;
  try {
    const remoteHead = await git(projectPath, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const slash = remoteHead.indexOf("/");
    if (slash >= 0) value = remoteHead.slice(slash + 1);
  } catch {
    // A repository without an origin has no advertised default branch.
  }
  remoteDefaultBranchCache.set(key, { expiresAt: Date.now() + PROJECT_GIT_META_TTL_MS, value });
  return value ?? rootBranch;
}

/** List local branches, annotated with the worktree Git says currently owns each one. */
export async function listBranches(projectPath: string): Promise<GitBranch[]> {
  const [worktrees, stdout] = await Promise.all([
    listWorktrees(projectPath),
    git(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
  ]);
  const checkedOutByBranch = new Map(
    worktrees
      .filter((worktree): worktree is Worktree & { branch: string } => Boolean(worktree.branch))
      .map((worktree) => [worktree.branch, worktree.path]),
  );
  return stdout
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, worktreePath: checkedOutByBranch.get(name) ?? null }));
}

/** Check out a local branch in a specific live worktree, then return its fresh Git state. */
export async function switchWorktreeBranch(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<Worktree> {
  const targetPath = pathKey(worktreePath);
  await withRepositoryLock(projectPath, async () => {
    const target = (await listWorktrees(projectPath)).find(
      (worktree) => pathKey(worktree.path) === targetPath,
    );
    if (!target) throw new Error("Worktree is no longer available");
    if (!(await branchExists(projectPath, branch))) {
      throw new Error(`Branch does not exist: ${branch}`);
    }

    // git receives an argument array, and branchExists above constrains this
    // to a local ref, so no shell interpretation is possible here.
    try {
      await git(target.path, ["switch", branch]);
    } finally {
      invalidateWorktreeCache(projectPath);
    }
  });
  const switched = (await listWorktrees(projectPath)).find(
    (worktree) => pathKey(worktree.path) === targetPath,
  );
  if (!switched) throw new Error("Worktree disappeared after switching branches");
  return switched;
}

/**
 * The OS's canonical form of a real path. `realpathSync.native` is required
 * rather than the JS implementation: on Windows only the native call expands
 * 8.3 short names (`RUNNER~1` → `runneradmin`) and resolves true on-disk
 * casing, which is the form `git worktree list` reports. Falls back to
 * `resolve` for paths that don't exist (they match no live worktree anyway).
 *
 * Always run through `normalize` so git porcelain (forward slashes on Windows)
 * and Node `join` (backslashes) compare equal — `C:/...` vs `C:\...`.
 */
function canonical(path: string): string {
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return normalize(resolve(path));
  }
}

/**
 * Comparison key for a path. Canonicalization alone isn't enough on Windows,
 * where the filesystem is case-insensitive and git and the OS may disagree on
 * casing. Never use this as a value — it is lossy; return `canonical` instead.
 */
export function pathKey(path: string): string {
  const real = canonical(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** True when two paths denote the same location on this platform. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Worktrees nested under a project, excluding the project's own main working
 * tree. git canonicalizes (realpath) worktree paths, so the exclusion compares
 * realpaths — a plain string compare would leak the main tree when the project
 * path contains a symlink.
 */
export async function listChildWorktrees(projectPath: string): Promise<Worktree[]> {
  return (await listWorktrees(projectPath)).filter((w) => !w.isProjectRoot);
}

/**
 * "Continue" after a merge: keep the same worktree directory (and its chats,
 * terminals, deps) but start a fresh `pipper/<name>-N` branch off the latest
 * base. Fetches first so the new branch includes the just-merged work;
 * refuses a dirty tree so no local change is silently carried across.
 */
export async function continueWorktreeOnNewBranch(
  projectPath: string,
  worktreePath: string,
): Promise<Worktree> {
  const targetPath = await withRepositoryLock(projectPath, async () => {
    const target = (await listWorktrees(projectPath)).find(
      (worktree) => !worktree.isProjectRoot && samePath(worktree.path, worktreePath),
    );
    if (!target) throw new Error("Workspace is no longer available");
    if (await git(target.path, ["status", "--porcelain"])) {
      throw new Error(
        "Workspace has uncommitted changes — commit or discard them before continuing.",
      );
    }
    const startPoint = await resolveBaseBranch(projectPath);
    const name = target.workspaceName ?? worktreePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    const branch = await resolveBranchName(projectPath, name);
    try {
      await git(target.path, ["switch", "--no-track", "-c", branch, startPoint]);
    } finally {
      invalidateWorktreeCache(projectPath);
    }
    return target.path;
  });
  const next = (await listWorktrees(projectPath)).find((worktree) =>
    samePath(worktree.path, targetPath),
  );
  if (!next) throw new Error("Worktree disappeared after switching branches");
  return next;
}

/** Remove a linked worktree and its Omni-generated branch. The project root is
 * intentionally protected because removing it would destroy the project. */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  projectId: string,
): Promise<Worktree> {
  return withRepositoryLock(projectPath, async () => {
    const target = (await listWorktrees(projectPath)).find(
      (worktree) => !worktree.isProjectRoot && samePath(worktree.path, worktreePath),
    );
    if (!target) throw new Error("Workspace is no longer available");

    // Git reports every linked worktree, including ones created outside Omni.
    // Removing the checkout is explicit, but only delete branches that Omni
    // generated from its managed worktree root; user-managed branches must
    // remain recoverable.
    const pathFromRoot = relative(
      canonical(join(getWorktreesRoot(), projectId)),
      canonical(target.path),
    );
    const managedPath =
      pathFromRoot !== "" &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${normalize("/")}`) &&
      !isAbsolute(pathFromRoot);
    const branchToDelete =
      managedPath && target.branch?.startsWith(GENERATED_BRANCH_PREFIX) ? target.branch : null;

    try {
      // `target.path` is the project directory inside the checkout; Git only
      // accepts the checkout root here.
      await git(projectPath, ["worktree", "remove", "--force", await worktreeRootOf(target.path)]);
      if (branchToDelete) {
        try {
          await git(projectPath, ["branch", "-D", branchToDelete]);
        } catch {
          // A user-owned branch may be shared or protected; removing the
          // worktree is still complete when Git refuses to delete that branch.
        }
      }
    } finally {
      invalidateWorktreeCache(projectPath);
    }
    return target;
  });
}

/**
 * True when a bound worktree path still points at a live worktree — used to
 * validate a thread's stored `worktree_path` before binding a session to it.
 * A linked worktree has a `.git` *file* (gitdir pointer), not a directory.
 */
export async function isLiveWorktree(worktreePath: string, projectPath: string): Promise<boolean> {
  try {
    const canonicalTarget = pathKey(worktreePath);
    const worktrees = await listWorktrees(projectPath);
    return worktrees.some((w) => pathKey(w.path) === canonicalTarget);
  } catch {
    return false;
  }
}
