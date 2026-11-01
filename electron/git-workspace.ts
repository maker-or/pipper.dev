import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ProjectRepoState,
  WorkspaceGitFile,
  WorkspaceGitStatus,
  WorkspacePr,
  WorkspacePrCheck,
  WorkspacePrCheckState,
  WorkspacePrComment,
  WorkspacePrDeployment,
} from "../contracts/git.ts";
import {
  foreignGitEnv,
  gitBinary,
  runCommand,
  withRepositoryLock,
  WorktreeCommandError,
} from "./worktree-manager.ts";

/**
 * First-party git operations for the advanced workspace UI.
 * Electron-free except for node builtins (unit-testable like worktree-manager).
 * Every operation is scoped to a worktree path; callers must ensure the path
 * belongs to a known project.
 *
 * Git always runs asynchronously with a deadline (the same `runCommand` the
 * worktree manager uses), so a stuck hook or credential helper can never
 * freeze the Electron main process. Mutations (commit, merge, init) take the
 * per-repository lock shared with worktree create/remove, so a merge can never
 * race a worktree being added to the same repository.
 */

const MAX_PANEL_FILES = 30;
/** Untracked files larger than this are not line-counted (likely binary). */
const MAX_LINE_COUNT_BYTES = 1_000_000;
const GH_AVAILABLE_TTL_MS = 60_000;

/** Default deadline for a git command; anything near it is stuck. */
const GIT_TIMEOUT_MS = 60_000;
/**
 * Deadline for commands that run user hooks (commit, merge, checkout). A
 * pre-commit hook may lint or test the whole repository; since git no longer
 * blocks the main process, a slow hook only delays its own action.
 */
const GIT_HOOK_TIMEOUT_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

/**
 * Run git against `cwd` without blocking the event loop. Rejects with a
 * `WorktreeCommandError` whose `kind` says whether git exited non-zero, timed
 * out (its whole process group is then stopped), could not start, or produced
 * runaway output.
 */
async function git(
  cwd: string,
  args: string[],
  timeoutMs = GIT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = foreignGitEnv(),
): Promise<string> {
  const stdout = await runCommand(gitBinary(), args, {
    cwd,
    env,
    timeoutMs,
    operation: `git ${args[0] ?? ""}`.trim(),
    stdout: "pipe",
  });
  // Trailing trim only: porcelain status records carry a significant leading
  // space (" M file" = unstaged modification) that String.trim() would eat.
  return stdout.replace(/[\r\n]+$/, "");
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

async function gh(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync(ghBinary(), args, {
    cwd,
    encoding: "utf8",
    env: foreignGitEnv(),
    timeout: timeoutMs,
  });
  return stdout.trim();
}

const GH_CANDIDATES =
  process.platform === "win32"
    ? [
        join(process.env["ProgramFiles"] ?? "C:\\Program Files", "GitHub CLI", "gh.exe"),
        join(process.env["LOCALAPPDATA"] ?? "", "Programs", "GitHub CLI", "gh.exe"),
      ]
    : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

let cachedGhBinary: { pathEnv: string; value: string } | null = null;

/**
 * Absolute `gh` binary, PATH-independent like `gitBinary()`: an app launched
 * from the Dock/Finder gets a minimal PATH without Homebrew, and a bare "gh"
 * would silently read as "not installed" (no PR, no checks) in the panel.
 * Memoized per PATH value — the probe walks the filesystem and runs before
 * every gh spawn. A failed probe is never cached so a mid-session install is
 * still picked up.
 */
export function ghBinary(): string {
  const pathEnv = process.env.PATH ?? "";
  if (cachedGhBinary && cachedGhBinary.pathEnv === pathEnv) return cachedGhBinary.value;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const exe = process.platform === "win32" ? "gh.exe" : "gh";
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (existsSync(candidate)) {
      cachedGhBinary = { pathEnv, value: candidate };
      return candidate;
    }
  }
  for (const candidate of GH_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedGhBinary = { pathEnv, value: candidate };
      return candidate;
    }
  }
  return "gh";
}

let ghAvailableCache: { value: boolean; expiresAt: number } | null = null;
let ghAvailableProbe: Promise<boolean> | null = null;

/**
 * Whether the GitHub CLI can be run. Cached briefly (the status poll asks
 * every 15s) and probed asynchronously so the main-process event loop never
 * blocks on spawning `gh --version`. Concurrent callers share one probe.
 */
export function isGhAvailable(): Promise<boolean> {
  if (ghAvailableCache && ghAvailableCache.expiresAt > Date.now()) {
    return Promise.resolve(ghAvailableCache.value);
  }
  ghAvailableProbe ??= execFileAsync(ghBinary(), ["--version"], { encoding: "utf8" })
    .then(
      () => true,
      () => false,
    )
    .then((value) => {
      ghAvailableCache = { value, expiresAt: Date.now() + GH_AVAILABLE_TTL_MS };
      ghAvailableProbe = null;
      return value;
    });
  return ghAvailableProbe;
}

async function remoteOrigin(cwd: string): Promise<{ host: string | null; url: string | null }> {
  const url = await tryGit(cwd, ["remote", "get-url", "origin"]);
  if (!url) return { host: null, url: null };
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo.git
  const scp = url.match(/@([^:]+):/);
  if (scp?.[1]) return { host: scp[1], url };
  try {
    return { host: new URL(url).hostname || null, url };
  } catch {
    return { host: null, url };
  }
}

interface StatusSummary {
  /** First `MAX_PANEL_FILES` changed files, for display. */
  files: WorkspaceGitFile[];
  truncated: boolean;
  /** Totals over *every* record, not just the displayed slice. */
  staged: number;
  unstaged: number;
  untracked: number;
}

/**
 * Pure parse of `git status --porcelain=v1 -z` output. Exported for tests.
 * Counts index and worktree columns independently, so `MM file` is one staged
 * and one unstaged change — the same arithmetic `git status` itself uses.
 */
export function summarizeStatusPorcelain(out: string): StatusSummary {
  const files: WorkspaceGitFile[] = [];
  const summary: StatusSummary = { files, truncated: false, staged: 0, unstaged: 0, untracked: 0 };
  if (!out) return summary;
  const records = out.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (code.includes("R") || code.includes("C")) i += 1; // skip rename source
    let status: WorkspaceGitFile["status"] | null = null;
    if (code === "??") status = "untracked";
    else if (code === "!!") continue;
    else if (code.includes("R") || code.includes("C")) status = "renamed";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("A")) status = "added";
    else if (code.includes("M") || code.includes("T") || code.includes("U")) status = "modified";
    if (!status) continue;
    const staged = code[0] !== " " && code[0] !== "?";
    if (status === "untracked") summary.untracked += 1;
    else {
      if (staged) summary.staged += 1;
      if (code[1] !== " ") summary.unstaged += 1;
    }
    if (files.length >= MAX_PANEL_FILES) {
      summary.truncated = true;
      continue;
    }
    // Line counts are not part of porcelain; `getWorkspaceGitStatus` enriches
    // these with `git diff --numstat` after parsing.
    files.push({ path, staged, status, additions: null, deletions: null });
  }
  return summary;
}

/**
 * Parse `git diff --numstat -z`. Records are `add\tdel\tpath` NUL-terminated;
 * renames emit an empty path then the old and new paths as separate fields.
 * Binary files report `-` for both counts and are treated as zero.
 */
export function parseNumstat(
  out: string,
): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const additions = Number(record.slice(0, firstTab));
    const deletions = Number(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (path === "") {
      // Rename/copy: the next two fields are the source then destination path.
      path = fields[i + 2] ?? "";
      i += 2;
    }
    if (!path) continue;
    stats.set(path, {
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
    });
  }
  return stats;
}

/**
 * Parse `git diff --shortstat` ("3 files changed, 10 insertions(+), 2
 * deletions(-)"). Either count is left out when zero; empty output is no
 * change at all. Exported for tests.
 */
export function parseShortstat(out: string): { additions: number; deletions: number } {
  const additions = out.match(/(\d+) insertions?\(\+\)/);
  const deletions = out.match(/(\d+) deletions?\(-\)/);
  return {
    additions: additions ? Number(additions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

/**
 * Lines the workspace changes against the base: the working tree (tracked
 * files) diffed against the merge base, plus untracked files' line counts.
 * Measured from the merge base so commits the team landed on the base since
 * the branch forked don't count as this branch's deletions.
 */
async function branchLineTotals(
  cwd: string,
  base: string,
  files: WorkspaceGitFile[],
  lineStats: Map<string, LineStats>,
): Promise<{ additions: number; deletions: number } | null> {
  const mergeBase = await tryGit(cwd, ["merge-base", base, "HEAD"]);
  if (!mergeBase) return null;
  const out = await tryGit(cwd, ["diff", "--shortstat", mergeBase]);
  if (out === null) return null;
  const totals = parseShortstat(out);
  for (const file of files) {
    if (file.status === "untracked") totals.additions += lineStats.get(file.path)?.additions ?? 0;
  }
  return totals;
}

/** Line count for an untracked file; null for binaries/oversized/unreadable. */
function countFileLines(absolutePath: string): number | null {
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_LINE_COUNT_BYTES) return null;
    const text = readFileSync(absolutePath, "utf8");
    if (text.length === 0) return 0;
    let lines = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) lines += 1;
    }
    if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
    return lines;
  } catch {
    return null;
  }
}

/**
 * Per-file line counts for the working tree, relative to HEAD. The caller
 * hands in the pre-fetched `git diff HEAD --numstat -z` output (fetched in
 * the parallel read round) and the repo root; this falls back to summing
 * index and worktree diffs on an unborn branch, and counts untracked files
 * directly since git reports no diff for them.
 */
type LineStats = { additions: number | null; deletions: number | null };

async function collectLineStats(
  cwd: string,
  files: WorkspaceGitFile[],
  combined: string | null,
  repoRoot: string,
): Promise<Map<string, LineStats>> {
  let stats: Map<string, LineStats>;
  if (combined !== null) {
    stats = parseNumstat(combined);
  } else {
    const [unstaged, staged] = await Promise.all([
      tryGit(cwd, ["diff", "--numstat", "-z"]),
      tryGit(cwd, ["diff", "--cached", "--numstat", "-z"]),
    ]);
    stats = parseNumstat(unstaged ?? "");
    for (const [path, value] of parseNumstat(staged ?? "")) {
      const previous = stats.get(path);
      // If either side is unknown the combined count is unknown.
      stats.set(path, {
        additions:
          previous?.additions == null || value.additions == null
            ? null
            : previous.additions + value.additions,
        deletions:
          previous?.deletions == null || value.deletions == null
            ? null
            : previous.deletions + value.deletions,
      });
    }
  }
  // Status/diff paths are relative to the repository root even when `cwd` is a
  // project subdirectory, so resolve untracked files against the root.
  for (const file of files) {
    if (file.status !== "untracked" || stats.has(file.path)) continue;
    stats.set(file.path, { additions: countFileLines(join(repoRoot, file.path)), deletions: 0 });
  }
  return stats;
}

async function parseStatusFiles(cwd: string): Promise<StatusSummary> {
  const out = await tryGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return summarizeStatusPorcelain(out ?? "");
}

export type PrSummary = {
  number: number | null;
  url: string | null;
  isDraft: boolean;
  checksState: WorkspaceGitStatus["checksState"];
  checks: WorkspacePrCheck[];
  mergedNumber: number | null;
  mergedUrl: string | null;
  pr: WorkspacePr | null;
};

const NO_PR: PrSummary = {
  number: null,
  url: null,
  isDraft: false,
  checksState: "unknown",
  checks: [],
  mergedNumber: null,
  mergedUrl: null,
  pr: null,
};

type PrLookup = {
  summary: PrSummary;
  dataState: WorkspaceGitStatus["prDataState"];
  updatedAt: number | null;
};

export interface GithubPrSnapshotCache {
  read(repository: string, branch: string): { snapshotJson: string; updatedAt: number } | null;
  write(repository: string, branch: string, snapshotJson: string, updatedAt: number): void;
}

let persistentPrSnapshotCache: GithubPrSnapshotCache | null = null;
const memoryPrSnapshotCache = new Map<string, { snapshotJson: string; updatedAt: number }>();
const MAX_PR_SNAPSHOTS = 200;

/** Installed by the Electron entrypoint after SQLite is ready. */
export function configureGithubPrSnapshotCache(cache: GithubPrSnapshotCache): void {
  persistentPrSnapshotCache = cache;
}

function prSnapshotKey(repository: string, branch: string): string {
  return `${repository}\0${branch}`;
}

function isPrSummary(value: unknown): value is PrSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PrSummary>;
  return (
    (candidate.number === null || typeof candidate.number === "number") &&
    (candidate.url === null || typeof candidate.url === "string") &&
    typeof candidate.isDraft === "boolean" &&
    typeof candidate.checksState === "string" &&
    Array.isArray(candidate.checks) &&
    (candidate.mergedNumber === null || typeof candidate.mergedNumber === "number") &&
    (candidate.mergedUrl === null || typeof candidate.mergedUrl === "string") &&
    (candidate.pr === null || typeof candidate.pr === "object")
  );
}

function readPrSnapshot(
  repository: string,
  branch: string,
): {
  summary: PrSummary;
  updatedAt: number;
} | null {
  const key = prSnapshotKey(repository, branch);
  let record = memoryPrSnapshotCache.get(key) ?? null;
  if (!record && persistentPrSnapshotCache) {
    try {
      record = persistentPrSnapshotCache.read(repository, branch);
    } catch {
      // A display cache must never make git status fail.
    }
  }
  if (!record) return null;
  try {
    const summary: unknown = JSON.parse(record.snapshotJson);
    if (!isPrSummary(summary)) return null;
    memoryPrSnapshotCache.set(key, record);
    return { summary, updatedAt: record.updatedAt };
  } catch {
    return null;
  }
}

/**
 * Request ordering per `repository\0branch`.
 *
 * A forced read (merge, mark ready) and a background refresh can be in flight
 * for the same branch at once, and GitHub may answer them in either order. A
 * background request that started before a merge but lands after the forced
 * read would otherwise overwrite the post-merge snapshot with pre-merge state
 * that reads as "fresh". Every request takes a sequence number when it starts,
 * and a response is only written when nothing newer has been written already.
 */
const prRequestOrder = new Map<string, { started: number; written: number }>();

function beginPrRequest(repository: string, branch: string): number {
  const key = prSnapshotKey(repository, branch);
  const order = prRequestOrder.get(key) ?? { started: 0, written: 0 };
  order.started += 1;
  prRequestOrder.set(key, order);
  return order.started;
}

/** True when no request that started after `requestId` has been written. */
function isCurrentPrRequest(repository: string, branch: string, requestId: number): boolean {
  return requestId > (prRequestOrder.get(prSnapshotKey(repository, branch))?.written ?? 0);
}

/**
 * Write a GitHub response, unless a newer request's response is already
 * cached. Returns whether it was written.
 */
function writePrSnapshot(
  repository: string,
  branch: string,
  summary: PrSummary,
  updatedAt: number,
  requestId: number,
): boolean {
  if (!isCurrentPrRequest(repository, branch, requestId)) return false;
  const order = prRequestOrder.get(prSnapshotKey(repository, branch));
  if (order) order.written = requestId;
  const snapshotJson = JSON.stringify(summary);
  const key = prSnapshotKey(repository, branch);
  // Refresh insertion order as a tiny in-memory LRU mirroring the disk cap.
  memoryPrSnapshotCache.delete(key);
  memoryPrSnapshotCache.set(key, { snapshotJson, updatedAt });
  while (memoryPrSnapshotCache.size > MAX_PR_SNAPSHOTS) {
    const oldest = memoryPrSnapshotCache.keys().next().value;
    if (oldest === undefined) break;
    memoryPrSnapshotCache.delete(oldest);
  }
  try {
    persistentPrSnapshotCache?.write(repository, branch, snapshotJson, updatedAt);
  } catch {
    // The fresh response is still usable when persistence is unavailable.
  }
  return true;
}

/**
 * How long a GitHub PR snapshot is served without asking GitHub again.
 *
 * Local git state is free (subprocesses) and polled often so the panel feels
 * live; GitHub is metered — one PR query measured at 2 GraphQL points, so a
 * 15s poll would burn ~480 of an account's 5,000 points per hour for a single
 * visible workspace, before the user's own `gh` usage. PR/check/comment state
 * also changes on the order of minutes, not seconds, so within this window the
 * cached snapshot is served as-is and no request is made.
 */
export const PR_REFRESH_INTERVAL_MS = 3 * 60_000;

/**
 * Stale-while-revalidate policy, exported so fallback semantics stay
 * unit-testable.
 *
 * A snapshot younger than `ttlMs` is returned without contacting GitHub and
 * still counts as `fresh`: it is the last successful response, recent enough
 * to act on. `force` skips that window for user-initiated work that must see
 * current data (merge, mark ready, create PR).
 */
export async function resolvePrWithCache(
  repository: string,
  branch: string,
  fetchSummary: () => Promise<PrSummary>,
  options: { now?: number; force?: boolean; ttlMs?: number } = {},
): Promise<PrLookup> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? PR_REFRESH_INTERVAL_MS;
  const cached = readPrSnapshot(repository, branch);
  if (!options.force && cached && now - cached.updatedAt < ttlMs) {
    return { summary: cached.summary, dataState: "fresh", updatedAt: cached.updatedAt };
  }
  const requestId = beginPrRequest(repository, branch);
  try {
    const summary = await fetchSummary();
    if (!writePrSnapshot(repository, branch, summary, now, requestId)) {
      // A request that started after this one already answered; its snapshot
      // is the newer truth.
      const newer = readPrSnapshot(repository, branch);
      if (newer) return { summary: newer.summary, dataState: "fresh", updatedAt: newer.updatedAt };
    }
    return { summary, dataState: "fresh", updatedAt: now };
  } catch {
    return cached
      ? { summary: cached.summary, dataState: "stale", updatedAt: cached.updatedAt }
      : { summary: NO_PR, dataState: "unavailable", updatedAt: null };
  }
}

type PrRefresh = {
  startedAt: number;
  inFlight: Promise<void> | null;
  /** The last completed attempt failed — what makes cached data "stale". */
  failed: boolean;
};

const prRefreshes = new Map<string, PrRefresh>();

function prRefreshKey(repository: string, branch: string): string {
  return `${repository}\0${branch}`;
}

/**
 * Throttled, non-blocking PR refresh.
 *
 * GitHub answers in ~1s while the whole local git read takes ~70ms, so the
 * network must never sit on the critical path of a status query. The caller
 * serves whatever snapshot is cached and this brings the next one in.
 * Never rejects; a failure is recorded so the cached data reads as stale.
 */
function refreshPrSnapshot(
  repository: string,
  branch: string,
  fetchSummary: () => Promise<PrSummary>,
  now = Date.now(),
): void {
  const key = prRefreshKey(repository, branch);
  const entry = prRefreshes.get(key) ?? { startedAt: 0, inFlight: null, failed: false };
  if (entry.inFlight) return;
  if (now - entry.startedAt < PR_REFRESH_INTERVAL_MS) return;
  entry.startedAt = now;
  const requestId = beginPrRequest(repository, branch);
  entry.inFlight = fetchSummary()
    .then((summary) => {
      writePrSnapshot(repository, branch, summary, Date.now(), requestId);
      entry.failed = false;
    })
    .catch(() => {
      // A failure that a newer, successful request has already superseded
      // must not mark that newer snapshot stale.
      if (isCurrentPrRequest(repository, branch, requestId)) entry.failed = true;
    })
    .finally(() => {
      entry.inFlight = null;
    });
  prRefreshes.set(key, entry);
}

/** True while a background refresh for this branch is in flight. */
function isPrRefreshing(repository: string, branch: string): boolean {
  return prRefreshes.get(prRefreshKey(repository, branch))?.inFlight != null;
}

/** Test seam: forget refresh throttling and failure flags. */
export function resetPrRefreshesForTests(): void {
  prRefreshes.clear();
  prRequestOrder.clear();
}

const PR_BODY_MAX = 20_000;
const COMMENT_BODY_MAX = 4_000;
const COMMENT_LIMIT = 30;

/** `owner/name` from an origin URL (ssh or https), or null for non-GitHub. */
export function parseGitHubRepo(remoteUrl: string): { owner: string; name: string } | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return { owner: match[1]!, name: match[2]! };
}

/** "owner/name" for a GitHub remote; null for any other host or no remote. */
function repositoryName(remoteUrl: string | null): string | null {
  const repo = remoteUrl ? parseGitHubRepo(remoteUrl) : null;
  return repo ? `${repo.owner}/${repo.name}` : null;
}

/** One round-trip for everything the panel shows about the branch's PR. */
const PR_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, states: [OPEN, MERGED], first: 5,
                 orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title body isDraft state url isCrossRepository additions deletions
        commits(last: 1) { nodes { commit {
          deployments(last: 10) { nodes {
            environment state latestStatus { state environmentUrl logUrl }
          } }
          statusCheckRollup { contexts(first: 100) { nodes {
            __typename
            ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
            ... on StatusContext { context state targetUrl createdAt }
          } } }
        } } }
        comments(last: ${COMMENT_LIMIT}) { nodes {
          id author { login avatarUrl } body url createdAt
        } }
        reviewThreads(first: ${COMMENT_LIMIT}) { nodes {
          isResolved
          comments(first: 1) { nodes {
            id author { login avatarUrl } body url createdAt path line
          } }
        } }
      }
    }
  }
}`;

/** Shape of one `pullRequests.nodes[]` entry from PR_QUERY (all optional: be lenient). */
export interface GhPrNode {
  number: number;
  title?: string | null;
  body?: string | null;
  isDraft?: boolean | null;
  state?: string | null;
  url?: string | null;
  /** True when the head branch lives in a fork rather than this repository. */
  isCrossRepository?: boolean | null;
  additions?: number | null;
  deletions?: number | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        deployments?: { nodes?: GhDeploymentNode[] | null } | null;
        statusCheckRollup?: { contexts?: { nodes?: GhCheckContext[] | null } | null } | null;
      } | null;
    }> | null;
  } | null;
  comments?: { nodes?: GhCommentNode[] | null } | null;
  reviewThreads?: {
    nodes?: Array<{
      isResolved?: boolean | null;
      comments?: { nodes?: GhCommentNode[] | null } | null;
    }> | null;
  } | null;
}

export interface GhDeploymentNode {
  environment?: string | null;
  state?: string | null;
  latestStatus?: {
    state?: string | null;
    environmentUrl?: string | null;
    logUrl?: string | null;
  } | null;
}

/** CheckRun or StatusContext from statusCheckRollup.contexts. */
export interface GhCheckContext {
  __typename?: string;
  // CheckRun
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  // StatusContext
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
  createdAt?: string | null;
}

interface GhCommentNode {
  id?: string | null;
  author?: { login?: string | null; avatarUrl?: string | null } | null;
  body?: string | null;
  url?: string | null;
  createdAt?: string | null;
  path?: string | null;
  line?: number | null;
}

function checkStateOf(entry: GhCheckContext): WorkspacePrCheckState {
  if (entry.__typename === "StatusContext") {
    const state = (entry.state ?? "").toUpperCase();
    if (state === "SUCCESS") return "passing";
    if (state === "FAILURE" || state === "ERROR") return "failing";
    return "pending";
  }
  if ((entry.status ?? "").toUpperCase() !== "COMPLETED") return "pending";
  const conclusion = (entry.conclusion ?? "").toUpperCase();
  if (
    ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)
  )
    return "failing";
  if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "skipped";
  return "passing";
}

/**
 * Pure CI summary over statusCheckRollup contexts (unit-tested without `gh`).
 * Re-runs repeat a check name — the most recently started one wins so a
 * green re-run hides its red predecessor, exactly as GitHub shows it.
 */
export function summarizeChecks(entries: GhCheckContext[]): {
  checksState: WorkspaceGitStatus["checksState"];
  checks: WorkspacePrCheck[];
} {
  const byName = new Map<string, { startedAt: number; check: WorkspacePrCheck }>();
  for (const entry of entries) {
    const name = (entry.__typename === "StatusContext" ? entry.context : entry.name) ?? "check";
    const started = Date.parse(entry.startedAt ?? entry.createdAt ?? "") || 0;
    const completed = Date.parse(entry.completedAt ?? "") || 0;
    const check: WorkspacePrCheck = {
      name,
      state: checkStateOf(entry),
      durationMs: started && completed && completed >= started ? completed - started : null,
      url: entry.detailsUrl ?? entry.targetUrl ?? null,
    };
    const existing = byName.get(name);
    if (!existing || started >= existing.startedAt) byName.set(name, { startedAt: started, check });
  }
  const checks = [...byName.values()].map((item) => item.check);
  if (checks.length === 0) return { checksState: "none", checks };
  if (checks.some((check) => check.state === "failing")) return { checksState: "failing", checks };
  if (checks.some((check) => check.state === "pending")) return { checksState: "pending", checks };
  return { checksState: "passing", checks };
}

function deploymentOf(node: GhDeploymentNode): WorkspacePrDeployment {
  const status = (node.latestStatus?.state ?? node.state ?? "").toUpperCase();
  const state: WorkspacePrDeployment["state"] =
    status === "SUCCESS" || status === "ACTIVE"
      ? "success"
      : status === "ERROR" || status === "FAILURE"
        ? "failure"
        : status === "INACTIVE" || status === "DESTROYED"
          ? "inactive"
          : "pending";
  return {
    environment: node.environment ?? "deployment",
    state,
    url: node.latestStatus?.environmentUrl ?? node.latestStatus?.logUrl ?? null,
  };
}

function commentOf(node: GhCommentNode, fallbackId: string): WorkspacePrComment {
  return {
    id: node.id ?? fallbackId,
    author: node.author?.login ?? "unknown",
    avatarUrl: node.author?.avatarUrl ?? null,
    body: (node.body ?? "").slice(0, COMMENT_BODY_MAX),
    url: node.url ?? null,
    createdAt: node.createdAt ?? "",
    path: node.path ?? null,
    line: node.line ?? null,
  };
}

/**
 * Pure selection over PR_QUERY nodes: open PR wins, else newest merged.
 * GitHub filters `pullRequests(headRefName:)` by branch *name* only, so a
 * fork's PR with the same branch name would match too; those are dropped
 * here so the panel never displays or merges someone else's pull request.
 */
export function summarizePrNodes(nodes: GhPrNode[]): PrSummary {
  const ours = nodes.filter((node) => node.isCrossRepository !== true);
  const open = ours.find((node) => (node.state ?? "").toUpperCase() === "OPEN");
  const merged = ours.find((node) => (node.state ?? "").toUpperCase() === "MERGED");
  const node = open ?? merged;
  if (!node) return NO_PR;
  const commit = node.commits?.nodes?.[0]?.commit;
  const summary = summarizeChecks(commit?.statusCheckRollup?.contexts?.nodes ?? []);
  const issueComments = (node.comments?.nodes ?? []).map((item, index) =>
    commentOf(item, `c${index}`),
  );
  const reviewComments = (node.reviewThreads?.nodes ?? [])
    .filter((thread) => !thread.isResolved)
    .flatMap((thread, index) =>
      (thread.comments?.nodes ?? []).slice(0, 1).map((item) => commentOf(item, `r${index}`)),
    );
  const pr: WorkspacePr = {
    number: node.number,
    url: node.url ?? "",
    title: node.title ?? "",
    body: (node.body ?? "").slice(0, PR_BODY_MAX),
    isDraft: node.isDraft ?? false,
    state: open ? "open" : "merged",
    additions: typeof node.additions === "number" ? node.additions : null,
    deletions: typeof node.deletions === "number" ? node.deletions : null,
    deployments: (commit?.deployments?.nodes ?? []).map(deploymentOf),
    comments: [...issueComments, ...reviewComments],
  };
  if (open) {
    return {
      number: node.number,
      url: pr.url,
      isDraft: pr.isDraft,
      ...summary,
      mergedNumber: null,
      mergedUrl: null,
      pr,
    };
  }
  return { ...NO_PR, mergedNumber: node.number, mergedUrl: pr.url, pr };
}

/**
 * PR picture for the branch in one `gh api graphql` round-trip: the open PR
 * (draft flag, CI, deployments, comments) or — once nothing is open — the
 * last merged one. Never throws — `gh` auth/network failures read as
 * "no PR known". The caller gates on `isGhAvailable()`.
 */
/** The metered GitHub round-trip, isolated so callers can choose when to pay it. */
function fetchPrSummary(
  cwd: string,
  repo: { owner: string; name: string },
  branch: string,
): Promise<PrSummary> {
  return gh(
    cwd,
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_QUERY}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      "-f",
      `branch=${branch}`,
    ],
    30_000,
  ).then((out) => {
    const parsed = JSON.parse(out) as {
      errors?: unknown[];
      data?: { repository?: { pullRequests?: { nodes?: GhPrNode[] } | null } | null };
    };
    const nodes = parsed.data?.repository?.pullRequests?.nodes;
    if (parsed.errors?.length || !Array.isArray(nodes)) {
      throw new Error("GitHub returned no pull request data");
    }
    return summarizePrNodes(nodes);
  });
}

/**
 * PR state for a branch, served from cache.
 *
 * Only `force` (a user action that must see current data) waits for GitHub.
 * Every other caller gets the cached snapshot immediately and triggers a
 * throttled background refresh, so a ~1s network round-trip never delays a
 * ~70ms local git read. `refreshing` tells the panel a newer answer is on its
 * way so it can re-read shortly instead of waiting for the next poll.
 */
async function lookupPr(
  cwd: string,
  branch: string | null,
  remoteUrl: string | null,
  options: { force?: boolean; published?: boolean } = {},
): Promise<PrLookup & { refreshing: boolean }> {
  const repo = remoteUrl ? parseGitHubRepo(remoteUrl) : null;
  if (!branch || !repo) {
    return { summary: NO_PR, dataState: "unavailable", updatedAt: null, refreshing: false };
  }
  const repository = `${repo.owner}/${repo.name}`;
  const fetchSummary = () => fetchPrSummary(cwd, repo, branch);

  if (options.force) {
    const resolved = await resolvePrWithCache(repository, branch, fetchSummary, { force: true });
    // A forced success is the newest answer, so an earlier background
    // failure no longer makes the cached data stale.
    const entry = prRefreshes.get(prRefreshKey(repository, branch));
    if (entry && resolved.dataState === "fresh") entry.failed = false;
    return { ...resolved, refreshing: false };
  }

  const cached = readPrSnapshot(repository, branch);
  // A branch that has never been published cannot have a pull request. Most
  // workspaces in a multi-worktree flow sit here, so skipping the query
  // removes the bulk of the API traffic. Once a snapshot exists we keep
  // refreshing it, so a branch whose upstream config was dropped is not lost.
  if (!options.published && !cached) {
    return { summary: NO_PR, dataState: "unavailable", updatedAt: null, refreshing: false };
  }

  refreshPrSnapshot(repository, branch, fetchSummary);
  const refreshing = isPrRefreshing(repository, branch);
  if (!cached) {
    return { summary: NO_PR, dataState: "unavailable", updatedAt: null, refreshing };
  }
  return {
    summary: cached.summary,
    // Age alone is not staleness: a snapshot past its window with a refresh
    // under way is still the last good answer. Only a failed attempt earns
    // the warning (and blocks the actions that require current data).
    dataState: prRefreshes.get(prRefreshKey(repository, branch))?.failed ? "stale" : "fresh",
    updatedAt: cached.updatedAt,
    refreshing,
  };
}

/**
 * How often a polled workspace re-fetches its base branch (and upstream)
 * from origin. Fetching is the only way "the team has new changes" can ever
 * be noticed; it is throttled per worktree so the status poll never becomes a
 * network round-trip. A `git fetch` does not spend GitHub's API quota, but it
 * is still a remote round-trip per workspace, and a teammate's merge is not
 * news that needs noticing within seconds.
 */
export const BASE_FETCH_INTERVAL_MS = 5 * 60_000;
const BASE_FETCH_TIMEOUT_MS = 30_000;

type BaseFetch = {
  startedAt: number;
  inFlight: Promise<void> | null;
  /** Last successful completion, kept across later failures (offline). */
  fetchedAt: number | null;
};

const baseFetches = new Map<string, BaseFetch>();

/** Branch names under `origin/` worth refreshing for this workspace. */
function originRefsToFetch(base: string | null, upstream: string | null): string[] {
  const refs = new Set<string>();
  for (const ref of [base, upstream]) {
    if (ref?.startsWith("origin/")) refs.add(ref.slice("origin/".length));
  }
  return [...refs];
}

/**
 * Throttled background `git fetch origin <base> [<upstream>]` for a
 * workspace. Never rejects and never blocks the caller for long: status
 * kicks it off and the *next* poll sees the moved remote-tracking refs.
 * `force` bypasses the interval for user-initiated refreshes. Resolves when
 * the fetch (if any) has finished, so callers that must act on current
 * refs — and tests — can await it.
 */
export function refreshBaseBranch(
  worktreePath: string,
  refs: { base: string | null; upstream: string | null },
  options: { force?: boolean; now?: number } = {},
): Promise<void> {
  const branches = originRefsToFetch(refs.base, refs.upstream);
  if (branches.length === 0) return Promise.resolve();
  const now = options.now ?? Date.now();
  const entry = baseFetches.get(worktreePath) ?? { startedAt: 0, inFlight: null, fetchedAt: null };
  if (entry.inFlight) return entry.inFlight;
  if (!options.force && now - entry.startedAt < BASE_FETCH_INTERVAL_MS) return Promise.resolve();
  entry.startedAt = now;
  entry.inFlight = git(
    worktreePath,
    ["fetch", "--quiet", "--no-tags", "origin", ...branches],
    BASE_FETCH_TIMEOUT_MS,
    // No credential or host-key prompts can be answered from a background
    // process; fail fast instead of wedging on a hidden prompt.
    { ...foreignGitEnv(), GIT_TERMINAL_PROMPT: "0" },
  )
    .then(() => {
      entry.fetchedAt = Date.now();
    })
    .catch(() => {
      // Offline, no auth, or a locked ref: the next interval retries.
    })
    .finally(() => {
      entry.inFlight = null;
    });
  baseFetches.set(worktreePath, entry);
  return entry.inFlight;
}

/** Test seam: forget fetch throttling so a fresh temp repo starts cold. */
export function resetBaseFetchesForTests(): void {
  baseFetches.clear();
}

/**
 * Coalesces concurrent status requests per worktree. A caller that arrives
 * while a run is in flight shares one queued follow-up run, so its answer
 * reflects state no older than its own request — a post-action refresh can
 * never be satisfied by a poll that started before the action finished —
 * while the panel's poll, multiple windows, and the PR action handlers never
 * stack duplicate git/gh process trees for the same path.
 */
type StatusFlight = {
  active: Promise<WorkspaceGitStatus>;
  queued: Promise<WorkspaceGitStatus> | null;
};

const statusFlights = new Map<string, StatusFlight>();

export function getWorkspaceGitStatus(
  worktreePath: string,
  options: { force?: boolean } = {},
): Promise<WorkspaceGitStatus> {
  // A forced read must see current GitHub data, so it never shares a flight
  // that may already be serving a cached snapshot. These are user-initiated
  // and rare, so the extra run costs nothing in practice.
  if (options.force) return computeWorkspaceGitStatus(worktreePath, true);
  const flight = statusFlights.get(worktreePath);
  if (!flight) return startStatusFlight(worktreePath);
  flight.queued ??= flight.active.then(
    () => startStatusFlight(worktreePath),
    () => startStatusFlight(worktreePath),
  );
  return flight.queued;
}

function startStatusFlight(worktreePath: string): Promise<WorkspaceGitStatus> {
  const flight: StatusFlight = {
    active: computeWorkspaceGitStatus(worktreePath),
    queued: null,
  };
  statusFlights.set(worktreePath, flight);
  const settle = () => {
    // A queued follow-up installs itself as the next flight via
    // startStatusFlight; only clear the entry when nothing is queued. This
    // callback was registered before any queued chain, so it runs first.
    if (statusFlights.get(worktreePath) === flight && !flight.queued) {
      statusFlights.delete(worktreePath);
    }
  };
  void flight.active.then(settle, settle);
  return flight.active;
}

/**
 * Classify a path whose `git rev-parse` probe failed.
 *
 * Repository metadata does not always sit at the probed path: a project
 * registered at a repository subdirectory points at `<checkout>/packages/app`
 * while `.git` lives at the checkout root, and a linked worktree's `.git` is a
 * file at the worktree root. So walk up looking for a `.git` entry rather than
 * checking only the probed path — otherwise a failed probe on a real checkout
 * reads as `absent` and the UI offers to initialize a nested repository inside
 * the existing one.
 *
 * A `.git` entry means this path was set up as a repository: a directory for
 * an ordinary checkout, or a file holding `gitdir:` for a linked worktree.
 * When one is present and git still refuses to answer, the repository exists
 * and something else is wrong (pruned worktree admin dir, moved checkout,
 * spawn failure, timeout) — never an invitation to create a repository. Only
 * a path with no repository metadata anywhere above it is genuinely `absent`.
 */
function repoStateForFailedProbe(worktreePath: string): "absent" | "broken" {
  let current = worktreePath;
  for (;;) {
    if (existsSync(join(current, ".git"))) return "broken";
    const parent = dirname(current);
    if (parent === current) return "absent";
    current = parent;
  }
}

/**
 * Full git picture for one workspace worktree. Never throws — degrades to
 * a non-`ready` repoState. Async end to end: this is polled by the panel, and a slow
 * `gh` round-trip must not stall every other IPC in the app. Independent
 * reads run in two parallel rounds instead of a serial chain of ~10 spawns.
 */
async function computeWorkspaceGitStatus(
  worktreePath: string,
  forcePrRefresh = false,
): Promise<WorkspaceGitStatus> {
  const ghAvailable = await isGhAvailable();
  const degraded: WorkspaceGitStatus = {
    repoState: "broken",
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    aheadOfBase: 0,
    behindBase: 0,
    baseBranch: null,
    baseFetchedAt: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    files: [],
    truncated: false,
    branchLines: null,
    remoteHost: null,
    repository: null,
    ghAvailable,
    openPrNumber: null,
    openPrUrl: null,
    isDraftPr: false,
    mergedPrNumber: null,
    mergedPrUrl: null,
    checksState: "unknown",
    checks: [],
    pr: null,
    prDataState: "unavailable",
    prUpdatedAt: null,
    prRefreshing: false,
  };
  try {
    // The directory itself is gone: broken, not "no repo here". Offering to
    // initialize one would target a path that does not exist.
    if (!existsSync(worktreePath)) return degraded;
    if ((await tryGit(worktreePath, ["rev-parse", "--git-dir"])) === null) {
      return { ...degraded, repoState: repoStateForFailedProbe(worktreePath) };
    }
    // Round 1: every read that depends only on the worktree.
    const [branchRaw, upstreamRaw, base, statusSummary, origin, combinedNumstat, repoRoot] =
      await Promise.all([
        tryGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]),
        tryGit(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
        branchBaseAsync(worktreePath),
        parseStatusFiles(worktreePath),
        remoteOrigin(worktreePath),
        tryGit(worktreePath, ["diff", "HEAD", "--numstat", "-z"]),
        tryGit(worktreePath, ["rev-parse", "--show-toplevel"]),
      ]);
    const branch = !branchRaw || branchRaw === "HEAD" ? null : branchRaw;
    const upstream = upstreamRaw || null;
    const { files, truncated, staged, unstaged, untracked } = statusSummary;
    // Deliberately not awaited: a fetch is a network round-trip that must
    // not stall the poll. This status reads whatever the last fetch left in
    // the remote-tracking refs; the next poll picks up this one's result.
    void refreshBaseBranch(worktreePath, { base, upstream });
    // Round 2: reads that depend on round 1, plus the gh network round-trip.
    const [baseCount, behindBaseCount, counts, { stats: lineStats, branchLines }, prLookup] =
      await Promise.all([
        // Commits beyond the base branch: what a PR would contain.
        base ? tryGit(worktreePath, ["rev-list", "--count", `${base}..HEAD`]) : null,
        // Commits on the base this branch lacks: what "Get latest" would bring in.
        base ? tryGit(worktreePath, ["rev-list", "--count", `HEAD..${base}`]) : null,
        upstream
          ? tryGit(worktreePath, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])
          : null,
        collectLineStats(worktreePath, files, combinedNumstat, repoRoot ?? worktreePath).then(
          async (stats) => ({
            stats,
            branchLines: base ? await branchLineTotals(worktreePath, base, files, stats) : null,
          }),
        ),
        origin.host === "github.com" && ghAvailable
          ? lookupPr(worktreePath, branch, origin.url, {
              force: forcePrRefresh,
              published: upstream !== null,
            })
          : {
              summary: NO_PR,
              dataState: "unavailable" as const,
              updatedAt: null,
              refreshing: false,
            },
      ]);
    const pr = prLookup.summary;
    const aheadOfBase = baseCount && Number.isFinite(Number(baseCount)) ? Number(baseCount) : 0;
    const behindBase =
      behindBaseCount && Number.isFinite(Number(behindBaseCount)) ? Number(behindBaseCount) : 0;
    let ahead = 0;
    let behind = 0;
    if (upstream) {
      if (counts) {
        const [a, b] = counts.split(/\s+/).map(Number);
        ahead = Number.isFinite(a) ? a : 0;
        behind = Number.isFinite(b) ? b : 0;
      }
    } else {
      // No upstream yet: "ahead" means commits a first push would publish.
      // Keeps local-only work visible as unpushed instead of reading like a
      // fresh worktree.
      ahead = aheadOfBase;
    }
    const filesWithLines = files.map((file) => {
      const stat = lineStats.get(file.path);
      return {
        ...file,
        additions: stat?.additions ?? file.additions,
        deletions: stat?.deletions ?? file.deletions,
      };
    });
    return {
      repoState: "ready",
      branch,
      upstream,
      ahead,
      behind,
      aheadOfBase,
      behindBase,
      baseBranch: base,
      baseFetchedAt: baseFetches.get(worktreePath)?.fetchedAt ?? null,
      staged,
      unstaged,
      untracked,
      files: filesWithLines,
      truncated,
      branchLines,
      remoteHost: origin.host,
      repository: repositoryName(origin.url),
      ghAvailable,
      openPrNumber: pr.number,
      openPrUrl: pr.url,
      isDraftPr: pr.isDraft,
      mergedPrNumber: pr.mergedNumber,
      mergedPrUrl: pr.mergedUrl,
      checksState: pr.checksState,
      checks: pr.checks,
      pr: pr.pr,
      prDataState: prLookup.dataState,
      prUpdatedAt: prLookup.updatedAt,
      prRefreshing: prLookup.refreshing,
    };
  } catch {
    return degraded;
  }
}

/** Stage everything and commit. Returns the short hash on success. */
export async function commitWorkspace(worktreePath: string, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Commit message is empty.");
  await assertInsideRepo(worktreePath);
  return withRepositoryLock(worktreePath, async () => {
    // Fail fast with a readable error instead of git's "Author identity unknown"
    // wall. Env-provided identity (CI, tests) counts — same rule git applies.
    const ident = await tryGit(worktreePath, ["var", "GIT_AUTHOR_IDENT"]);
    if (!ident) {
      throw new Error(
        "Git identity is missing: set user.name and user.email (repo-local config or global) before committing.",
      );
    }
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-m", trimmed], GIT_HOOK_TIMEOUT_MS);
    return git(worktreePath, ["rev-parse", "--short", "HEAD"]);
  });
}

/** Publish the current branch under its own name using Git's push remote precedence. */
export async function pushWorkspace(worktreePath: string): Promise<void> {
  await assertInsideRepo(worktreePath);
  const branch = await tryGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) throw new Error("Check out a branch before pushing this workspace.");
  const [branchPushRemote, defaultPushRemote, upstream] = await Promise.all([
    tryGit(worktreePath, ["config", "--get", `branch.${branch}.pushRemote`]),
    tryGit(worktreePath, ["config", "--get", "remote.pushDefault"]),
    git(worktreePath, [
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ]),
  ]);
  const [upstreamRemote, upstreamRef] = upstream.split("\0");
  // Honor triangular workflows (fetch upstream, push fork), but never publish to the base
  // branch or let push.default / remote push refspecs choose another branch.
  const remote =
    branchPushRemote ||
    defaultPushRemote ||
    (upstreamRemote && upstreamRemote !== "." ? upstreamRemote : "origin");
  const branchRef = `refs/heads/${branch}`;
  // Keep a same-name fetch upstream on another remote. Only establish tracking
  // on first publication or repair the inherited base-branch upstream.
  const setUpstream = !upstreamRemote || upstreamRemote === "." || upstreamRef !== branchRef;
  // Generous timeout: first pushes and slow networks take a while, but a
  // credential prompt must never hang the UI forever (stdin is ignored).
  await git(
    worktreePath,
    ["push", ...(setUpstream ? ["-u"] : []), remote, `${branchRef}:${branchRef}`],
    120_000,
  );
}

/** Create a GitHub PR for the workspace branch via `gh`. Returns the PR URL. */
export async function createWorkspacePr(
  worktreePath: string,
  title: string,
  body?: string,
  draft = false,
): Promise<string> {
  await assertInsideRepo(worktreePath);
  if (!(await isGhAvailable())) throw new Error("GitHub CLI (gh) is not installed.");
  const branch = await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // A PR with zero unique commits is rejected server-side with GraphQL noise —
  // catch it here with a message that says what to do instead.
  const base = await branchBaseAsync(worktreePath);
  const unique = base ? await tryGit(worktreePath, ["rev-list", "--count", `${base}..HEAD`]) : null;
  if (unique !== null && Number(unique) === 0) {
    const dirty = await tryGit(worktreePath, ["status", "--porcelain"]);
    throw new Error(
      dirty
        ? `Branch "${branch}" has no commits beyond ${base ?? "the base branch"} — commit your changes first, then create the PR.`
        : `Branch "${branch}" has no commits beyond ${base ?? "the base branch"} — nothing to open a PR for.`,
    );
  }
  // Draft PRs require an explicit body when non-interactive — derive one from
  // the branch commits when the caller has none.
  const finalBody = body?.trim() || (await defaultPrBody(worktreePath, branch, base));
  const args = ["pr", "create", "--head", branch, "--title", title.trim() || branch];
  if (draft) args.push("--draft");
  args.push("--body", finalBody);
  const out = await gh(worktreePath, args, 120_000);
  return out.split("\n").at(-1) ?? "";
}

/** Base ref for branch comparisons: advertised remote default, else local main. */
async function branchBaseAsync(worktreePath: string): Promise<string | null> {
  return (
    (await tryGit(worktreePath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) ??
    ((await tryGit(worktreePath, ["rev-parse", "--verify", "--quiet", "main"])) ? "main" : null)
  );
}

/** Local branch names tried, in order, when no remote advertises a default. */
const CONVENTIONAL_BASE_BRANCHES = ["main", "master"];

/**
 * The repository's base branch as a *local* branch name: `origin/HEAD` when
 * advertised, else a conventional local branch. Deliberately never "whatever
 * is checked out" — the project root may be sitting on another feature
 * branch, and merging workspace work into that would be silent data
 * misplacement. Throws when nothing qualifies.
 */
async function resolveLocalBaseBranch(projectPath: string): Promise<string> {
  const remoteHead = await tryGit(projectPath, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const candidate of CONVENTIONAL_BASE_BRANCHES) {
    const ref = `refs/heads/${candidate}`;
    if ((await tryGit(projectPath, ["rev-parse", "--verify", "--quiet", ref])) !== null) {
      return candidate;
    }
  }
  throw new Error(
    "Could not determine the base branch: no origin default branch and no local main/master.",
  );
}

/** Fallback PR body: the branch's commit subjects, else the branch name. */
async function defaultPrBody(
  worktreePath: string,
  branch: string,
  base: string | null,
): Promise<string> {
  const rangeArgs = base ? [`${base}..HEAD`] : ["-n", "10", "HEAD"];
  const log = await tryGit(worktreePath, ["log", "--pretty=format:- %s", ...rangeArgs]);
  if (log) return log.split("\n").slice(0, 20).join("\n");
  return branch;
}

/**
 * Merge the open PR for the workspace branch on GitHub (`gh pr merge`).
 * The branch itself is kept — the worktree stays checked out on it.
 */
export async function mergeWorkspacePr(worktreePath: string, prNumber: number): Promise<string> {
  await assertInsideRepo(worktreePath);
  if (!(await isGhAvailable())) throw new Error("GitHub CLI (gh) is not installed.");
  await gh(worktreePath, ["pr", "merge", String(prNumber), "--merge"], 120_000);
  return `PR #${prNumber} merged.`;
}

/** Flip a draft PR to "ready for review" (`gh pr ready`). */
export async function markWorkspacePrReady(
  worktreePath: string,
  prNumber: number,
): Promise<string> {
  await assertInsideRepo(worktreePath);
  if (!(await isGhAvailable())) throw new Error("GitHub CLI (gh) is not installed.");
  await gh(worktreePath, ["pr", "ready", String(prNumber)], 60_000);
  return `PR #${prNumber} marked ready for review.`;
}

/**
 * Merge the workspace branch into the repo's base branch inside the project
 * root checkout. Refuses when either side is dirty so agent work is never
 * merged over uncommitted state. Runs under the repository lock so the dirty
 * check, checkout and merge cannot interleave with a worktree create or remove
 * (or another merge) in the same repository.
 */
export async function mergeWorkspaceBranch(projectPath: string, branch: string): Promise<string> {
  await assertInsideRepo(projectPath);
  if (!branch.trim()) throw new Error("No branch to merge.");
  return withRepositoryLock(projectPath, async () => {
    const dirty = await tryGit(projectPath, ["status", "--porcelain"]);
    if (dirty) {
      throw new Error("Project checkout has uncommitted changes — commit or stash first.");
    }
    const base = await resolveLocalBaseBranch(projectPath);
    if (base === branch.trim()) throw new Error(`"${branch}" is already the base branch.`);
    const current = await tryGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current !== base) await git(projectPath, ["checkout", base], GIT_HOOK_TIMEOUT_MS);
    try {
      await git(projectPath, ["merge", "--no-ff", branch], GIT_HOOK_TIMEOUT_MS);
    } catch (err) {
      // Never leave the project checkout wedged in MERGING state — a failed
      // panel merge must read as an error, not a broken repo.
      await abortMerge(projectPath, err);
      throw err;
    }
    return base;
  });
}

/** Best-effort `git merge --abort` after `cause` made a merge fail. */
async function abortMerge(projectPath: string, _cause: unknown): Promise<void> {
  // A timed-out merge rejects only after its process group was stopped
  // (runCommand), so `index.lock` is already released here.
  try {
    await git(projectPath, ["merge", "--abort"]);
  } catch {
    // Nothing to abort, or the abort failed: the merge error is what matters.
  }
}

/**
 * Whether the project root can host a workspace worktree. A worktree branches
 * from a commit, so a repository with no commits (`unborn`) is as unusable as
 * no repository at all — but its fix is an initial commit, not an init.
 */
export async function getProjectRepoState(projectPath: string): Promise<ProjectRepoState> {
  // The directory itself is gone: broken, not "no repo here". Offering to
  // initialize one would target a path that does not exist.
  if (!existsSync(projectPath)) return "broken";
  if ((await tryGit(projectPath, ["rev-parse", "--git-dir"])) === null) {
    return repoStateForFailedProbe(projectPath);
  }
  return (await tryGit(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"])) === null
    ? "unborn"
    : "ready";
}

/**
 * Make the project root a repository a workspace can branch from: initialize
 * one when none exists, wire the user's identity, and create the initial
 * commit when the repository has no commits yet.
 *
 * The commit is load-bearing, not cosmetic: `git worktree add` needs a commit
 * to branch from, so a repository with no commits cannot host a workspace.
 * Existing project files are included so a new workspace starts from them.
 */
export async function initProjectRepo(
  projectPath: string,
  identity: { name?: string | null; email?: string | null },
  defaultBranch = "main",
): Promise<void> {
  if (!existsSync(projectPath)) throw new Error(`Project path does not exist: ${projectPath}`);
  await withRepositoryLock(projectPath, async () => {
    const isRepo = (await tryGit(projectPath, ["rev-parse", "--git-dir"])) !== null;
    // Re-running `git init` on a live repository rewrites HEAD and the local
    // identity config. The UI only offers this for a project with no repo or no
    // commits, so reaching here with commits means the caller is acting on
    // stale state (or lost a race with another init of the same project).
    const head = isRepo
      ? await tryGit(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"])
      : null;
    if (head !== null) throw new Error("This project is already a git repository.");
    if (!isRepo) await git(projectPath, ["init", "-b", defaultBranch]);
    if (identity.name) await git(projectPath, ["config", "user.name", identity.name]);
    if (identity.email) await git(projectPath, ["config", "user.email", identity.email]);
    await createInitialCommit(projectPath);
  });
}

/**
 * Stage everything and commit. `--allow-empty` so a project with no files yet
 * still gets the commit a worktree needs. Fails fast with a readable error
 * instead of git's "Author identity unknown" wall — env-provided identity
 * (CI, tests) counts, same rule git applies.
 */
async function createInitialCommit(projectPath: string): Promise<void> {
  if ((await tryGit(projectPath, ["var", "GIT_AUTHOR_IDENT"])) === null) {
    throw new Error(
      "Git identity is missing: set user.name and user.email (repo-local config or global) before initializing.",
    );
  }
  await git(projectPath, ["add", "-A"]);
  await git(projectPath, ["commit", "--allow-empty", "-m", "Initial commit"], GIT_HOOK_TIMEOUT_MS);
}

async function assertInsideRepo(cwd: string): Promise<void> {
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
  } catch (err) {
    // A timeout or spawn failure is not evidence the path is no repository.
    if (err instanceof WorktreeCommandError && err.kind !== "exit") throw err;
    throw new Error(`Not a git repository: ${cwd}`);
  }
}
