import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  BASE_FETCH_INTERVAL_MS,
  commitWorkspace,
  getProjectRepoState,
  getWorkspaceGitStatus,
  initProjectRepo,
  isGhAvailable,
  mergeWorkspaceBranch,
  parseGitHubRepo,
  parseNumstat,
  pushWorkspace,
  PR_REFRESH_INTERVAL_MS,
  refreshBaseBranch,
  resetBaseFetchesForTests,
  resetPrRefreshesForTests,
  resolvePrWithCache,
  summarizeChecks,
  summarizePrNodes,
  summarizeStatusPorcelain,
  type PrSummary,
} from "./git-workspace.ts";

const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
Object.assign(GIT_ENV, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

let dir: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-workspace-"));
});

afterEach(() => {
  // Git can still be writing (e.g. a detached auto-maintenance step) when a
  // test ends; retry instead of failing on ENOTEMPTY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("getWorkspaceGitStatus", () => {
  test("a plain directory reports an absent repo, without throwing", async () => {
    const status = await getWorkspaceGitStatus(dir);
    expect(status.repoState).toBe("absent");
    expect(status.branch).toBeNull();
  });

  test("a repository subdirectory whose metadata git cannot read is broken, not absent", async () => {
    // A project registered at a repository subdirectory has no `.git` at the
    // probed path — the metadata lives at an ancestor. A failed probe there
    // must not read as "no repository", which would offer to initialize a
    // nested repository inside the existing one.
    const parent = join(dir, "parent");
    const child = join(parent, "packages", "app");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, ".git"), "gitdir: /nonexistent\n");
    expect((await getWorkspaceGitStatus(child)).repoState).toBe("broken");
  });

  test("a worktree whose admin dir was pruned reads as broken, not absent", async () => {
    // Regression: both states were one `isRepo:false`, so an orphaned
    // worktree offered "Initialize git repo" inside an existing repository.
    const project = join(dir, "project");
    mkdirSync(project);
    await initProjectRepo(project, { name: "Test", email: "test@example.com" });
    writeFileSync(join(project, "a.txt"), "hi");
    git(project, ["add", "-A"]);
    git(project, ["commit", "-m", "init"]);
    const work = join(dir, "w1");
    git(project, ["worktree", "add", work, "-b", "feat"]);
    expect((await getWorkspaceGitStatus(work)).repoState).toBe("ready");

    rmSync(join(project, ".git", "worktrees", "w1"), { recursive: true, force: true });
    const status = await getWorkspaceGitStatus(work);
    expect(status.repoState).toBe("broken");
    expect(existsSync(join(work, ".git"))).toBe(true);
  });

  test("a deleted workspace directory reads as broken, not absent", async () => {
    const gone = join(dir, "never-existed");
    expect((await getWorkspaceGitStatus(gone)).repoState).toBe("broken");
  });

  test("clean repo reports branch with zero counts", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "hi");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    const status = await getWorkspaceGitStatus(dir);
    expect(status.repoState).toBe("ready");
    expect(status.branch).toBe("main");
    expect(status.upstream).toBeNull();
    expect(status.staged + status.unstaged + status.untracked).toBe(0);
    expect(status.files).toEqual([]);
  });

  test("dirty files are counted and listed", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "hi");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    writeFileSync(join(dir, "a.txt"), "changed");
    writeFileSync(join(dir, "new.txt"), "untracked");
    const status = await getWorkspaceGitStatus(dir);
    expect(status.unstaged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.files.map((f) => f.path).sort()).toEqual(["a.txt", "new.txt"]);
    const modified = status.files.find((f) => f.path === "a.txt");
    expect(modified).toMatchObject({ additions: 1, deletions: 1 });
    const untracked = status.files.find((f) => f.path === "new.txt");
    expect(untracked).toMatchObject({ additions: 1, deletions: 0 });
  });

  test("branch without upstream counts commits beyond main as ahead", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    expect((await getWorkspaceGitStatus(dir)).ahead).toBe(0);
    writeFileSync(join(dir, "b.txt"), "side");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "side change"]);
    const status = await getWorkspaceGitStatus(dir);
    expect(status.upstream).toBeNull();
    expect(status.ahead).toBe(1);
    expect(status.aheadOfBase).toBe(1);
  });

  test("a request issued mid-flight still sees state from its own request time", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "hi");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    // Kick off a run, mutate the worktree, then ask again while the first
    // run may still be in flight: coalescing must queue a follow-up run, not
    // hand back the stale in-flight answer.
    const first = getWorkspaceGitStatus(dir);
    writeFileSync(join(dir, "late.txt"), "late");
    const second = await getWorkspaceGitStatus(dir);
    expect(second.files.map((f) => f.path)).toContain("late.txt");
    await first;
  });

  test("in-sync branch still reports commits beyond base", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "b.txt"), "side");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "side change"]);
    // Fake a pushed branch: a remote-tracking ref plus tracking config.
    git(dir, ["remote", "add", "origin", dir]);
    git(dir, ["update-ref", "refs/remotes/origin/side", "HEAD"]);
    git(dir, ["config", "branch.side.remote", "origin"]);
    git(dir, ["config", "branch.side.merge", "refs/heads/side"]);
    const status = await getWorkspaceGitStatus(dir);
    expect(status.upstream).toBe("origin/side");
    expect(status.ahead).toBe(0);
    expect(status.aheadOfBase).toBe(1);
  });

  test("counts commits on a local base branch the workspace lacks, with no fetch", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "b.txt"), "moved on");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main moved"]);
    git(dir, ["checkout", "side"]);
    const status = await getWorkspaceGitStatus(dir);
    expect(status.baseBranch).toBe("main");
    expect(status.behindBase).toBe(1);
    expect(status.aheadOfBase).toBe(0);
    expect(status.baseFetchedAt).toBeNull();
  });

  test("totals the branch's lines against the base, ignoring what the base gained since", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    // Committed: one line replaced.
    writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
    git(dir, ["commit", "-am", "edit"]);
    // The base moves on afterwards; none of that is the branch's change.
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "main.txt"), "1\n2\n3\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "main moved"]);
    git(dir, ["checkout", "side"]);
    // Uncommitted: a tracked line added and an untracked file of two lines.
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");
    writeFileSync(join(dir, "new.txt"), "x\ny\n");
    const status = await getWorkspaceGitStatus(dir);
    expect(status.branchLines).toEqual({ additions: 4, deletions: 1 });
  });

  test("names the GitHub repository from the origin remote", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    git(dir, ["remote", "add", "origin", "git@github.com:maker-or/pipper.dev.git"]);
    expect((await getWorkspaceGitStatus(dir)).repository).toBe("maker-or/pipper.dev");
  });
});

describe("project repo state and initialization", () => {
  test("a plain directory is absent; a missing one is broken", async () => {
    expect(await getProjectRepoState(dir)).toBe("absent");
    expect(await getProjectRepoState(join(dir, "never-existed"))).toBe("broken");
  });

  test("a repository with no commits is unborn, not ready", async () => {
    git(dir, ["init", "-b", "main"]);
    expect(await getProjectRepoState(dir)).toBe("unborn");
  });

  test("a repository with a commit is ready", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    expect(await getProjectRepoState(dir)).toBe("ready");
  });

  test("repository metadata git cannot read is broken, not absent", async () => {
    // A `.git` entry pointing nowhere: git refuses to answer, but the
    // directory was set up as a repository — initializing one here would act
    // on the wrong tree.
    writeFileSync(join(dir, ".git"), "gitdir: /nonexistent\n");
    expect(await getProjectRepoState(dir)).toBe("broken");
  });

  test("initialization leaves a commit a worktree can branch from", async () => {
    // Regression: `git worktree add` needs a commit. A repository that is
    // only `git init`-ed has no HEAD, so every workspace create failed right
    // after the user was told the repository had been initialized.
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    expect(git(dir, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
    expect(git(dir, ["log", "--oneline", "-1"])).toContain("Initial commit");
  });

  test("the initial commit includes the project's existing files", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    expect(git(dir, ["show", "--stat", "--oneline", "HEAD"])).toContain("a.txt");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  test("an empty project still gets the commit a worktree needs", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(git(dir, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
  });

  test("finishes an existing repository that has no commits", async () => {
    git(dir, ["init", "-b", "trunk"]);
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    expect(await getProjectRepoState(dir)).toBe("ready");
    // The repository's own branch is kept; only the missing commit is added.
    expect(git(dir, ["branch", "--show-current"])).toBe("trunk");
  });

  test("refuses to re-initialize a repository that already has commits", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    await expect(initProjectRepo(dir, { name: "Test", email: "test@example.com" })).rejects.toThrow(
      "already a git repository",
    );
  });
});

/**
 * A bare origin plus two clones: `work` is the user's workspace, `other` is
 * a teammate who pushes to main behind their back.
 */
async function setUpTeamRepo(): Promise<{ work: string; other: string }> {
  git(dir, ["init", "--bare", "--initial-branch=main", "origin.git"]);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  mkdirSync(work);
  await initProjectRepo(work, { name: "Test", email: "test@example.com" });
  writeFileSync(join(work, "a.txt"), "base");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["push", "-u", "origin", "main"]);
  git(work, ["remote", "set-head", "origin", "main"]);
  git(work, ["checkout", "-b", "side"]);
  git(dir, ["clone", "--quiet", origin, "other"]);
  return { work, other: join(dir, "other") };
}

function teammatePushes(other: string, file: string): void {
  writeFileSync(join(other, file), "teammate");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-m", `teammate adds ${file}`]);
  git(other, ["push", "--quiet", "origin", "main"]);
}

describe("pushWorkspace", () => {
  function commitFeature(work: string, file = "feature.txt") {
    writeFileSync(join(work, file), "feature work");
    git(work, ["add", file]);
    git(work, ["commit", "-m", "feature work"]);
    return git(work, ["rev-parse", "HEAD"]);
  }

  test("publishes a new branch, sets its upstream, and supports later pushes", async () => {
    const { work } = await setUpTeamRepo();
    const base = git(work, ["rev-parse", "origin/main"]);
    commitFeature(work);
    await pushWorkspace(work);
    expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/side");
    const next = commitFeature(work, "next.txt");
    await pushWorkspace(work);
    expect(git(join(dir, "origin.git"), ["rev-parse", "side"])).toBe(next);
    expect(git(join(dir, "origin.git"), ["rev-parse", "main"])).toBe(base);
  });

  test.each(["simple", "upstream", "matching"])(
    "repairs an inherited base upstream with push.default=%s without changing main",
    async (mode) => {
      const { work } = await setUpTeamRepo();
      const base = git(work, ["rev-parse", "origin/main"]);
      git(work, ["branch", "--set-upstream-to=origin/main", "side"]);
      git(work, ["config", "push.default", mode]);
      git(work, ["config", "remote.origin.push", "refs/heads/side:refs/heads/main"]);
      const head = commitFeature(work);
      await pushWorkspace(work);
      expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/side");
      expect(git(join(dir, "origin.git"), ["rev-parse", "side"])).toBe(head);
      expect(git(join(dir, "origin.git"), ["rev-parse", "main"])).toBe(base);
      expect(git(work, ["config", "push.default"])).toBe(mode);
    },
  );

  test("keeps the configured remote when repairing an upstream", async () => {
    const { work } = await setUpTeamRepo();
    git(work, ["remote", "rename", "origin", "fork"]);
    git(work, ["branch", "--set-upstream-to=fork/main", "side"]);
    const head = commitFeature(work);
    await pushWorkspace(work);
    expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("fork/side");
    expect(git(join(dir, "origin.git"), ["rev-parse", "side"])).toBe(head);
  });

  test.each(["branch", "default", "both"])(
    "honors the %s push remote setting and preserves a separate fetch upstream",
    async (setting) => {
      const { work } = await setUpTeamRepo();
      await pushWorkspace(work);
      const upstreamHead = git(join(dir, "origin.git"), ["rev-parse", "side"]);
      for (const remote of ["fork", "default-fork"]) {
        const path = join(dir, `${remote}.git`);
        git(dir, ["init", "--bare", path]);
        git(work, ["remote", "add", remote, path]);
      }
      if (setting !== "default") git(work, ["config", "branch.side.pushRemote", "fork"]);
      if (setting !== "branch")
        git(work, ["config", "remote.pushDefault", setting === "both" ? "default-fork" : "fork"]);
      const head = commitFeature(work);
      await pushWorkspace(work);
      expect(git(join(dir, "fork.git"), ["rev-parse", "side"])).toBe(head);
      expect(git(join(dir, "origin.git"), ["rev-parse", "side"])).toBe(upstreamHead);
      expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/side");
      expect(git(join(dir, "default-fork.git"), ["for-each-ref", "--format=%(refname)"])).toBe("");
    },
  );

  test("uses the default push remote for first publication and establishes tracking", async () => {
    const { work } = await setUpTeamRepo();
    const fork = join(dir, "fork.git");
    git(dir, ["init", "--bare", fork]);
    git(work, ["remote", "add", "fork", fork]);
    git(work, ["config", "remote.pushDefault", "fork"]);
    const head = commitFeature(work);
    await pushWorkspace(work);
    expect(git(fork, ["rev-parse", "side"])).toBe(head);
    expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("fork/side");
    expect(git(join(dir, "origin.git"), ["for-each-ref", "--format=%(refname)"])).toBe(
      "refs/heads/main",
    );
  });

  test("rejects diverging remote history without overwriting it", async () => {
    const { work, other } = await setUpTeamRepo();
    commitFeature(work);
    await pushWorkspace(work);
    git(other, ["fetch", "origin", "side"]);
    git(other, ["checkout", "-b", "side", "origin/side"]);
    const remoteHead = commitFeature(other, "teammate.txt");
    git(other, ["push", "origin", "side"]);
    const localHead = commitFeature(work, "local.txt");
    await expect(pushWorkspace(work)).rejects.toThrow();
    expect(git(join(dir, "origin.git"), ["rev-parse", "side"])).toBe(remoteHead);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(git(work, ["rev-parse", "--abbrev-ref", "@{u}"])).toBe("origin/side");
  });

  test("rejects a detached HEAD before publishing anything", async () => {
    const { work } = await setUpTeamRepo();
    git(work, ["checkout", "--detach"]);
    await expect(pushWorkspace(work)).rejects.toThrow("Check out a branch");
    expect(git(join(dir, "origin.git"), ["for-each-ref", "--format=%(refname)"])).toBe(
      "refs/heads/main",
    );
  });
});

describe("base branch fetch", () => {
  afterEach(() => {
    resetBaseFetchesForTests();
  });

  test("a teammate's push to main shows up as behindBase after a fetch", async () => {
    const { work, other } = await setUpTeamRepo();
    teammatePushes(other, "b.txt");
    // Nothing has fetched yet: the remote-tracking ref is still at "base".
    const before = await getWorkspaceGitStatus(work);
    expect(before.baseBranch).toBe("origin/main");
    expect(before.behindBase).toBe(0);
    await refreshBaseBranch(work, { base: "origin/main", upstream: null }, { force: true });
    const after = await getWorkspaceGitStatus(work);
    expect(after.behindBase).toBe(1);
    expect(after.aheadOfBase).toBe(0);
    expect(after.baseFetchedAt).not.toBeNull();
  });

  test("status kicks off a fetch in the background and the next poll sees it", async () => {
    const { work, other } = await setUpTeamRepo();
    teammatePushes(other, "b.txt");
    resetBaseFetchesForTests();
    const first = await getWorkspaceGitStatus(work);
    expect(first.behindBase).toBe(0);
    // The fetch started by the poll above is still running; await it via the
    // throttle (same window, so this returns the in-flight promise).
    await refreshBaseBranch(work, { base: "origin/main", upstream: null });
    const second = await getWorkspaceGitStatus(work);
    expect(second.behindBase).toBe(1);
  });

  test("fetches are throttled per workspace until forced", async () => {
    const { work, other } = await setUpTeamRepo();
    const now = Date.now();
    await refreshBaseBranch(work, { base: "origin/main", upstream: null }, { force: true, now });
    teammatePushes(other, "b.txt");
    // Inside the interval: no network round-trip, so the ref does not move.
    await refreshBaseBranch(work, { base: "origin/main", upstream: null }, { now: now + 1_000 });
    expect(git(work, ["rev-list", "--count", "HEAD..origin/main"])).toBe("0");
    await refreshBaseBranch(
      work,
      { base: "origin/main", upstream: null },
      { now: now + BASE_FETCH_INTERVAL_MS + 1 },
    );
    expect(git(work, ["rev-list", "--count", "HEAD..origin/main"])).toBe("1");
  });

  test("an unreachable origin resolves without throwing and leaves fetchedAt null", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["remote", "add", "origin", join(dir, "does-not-exist.git")]);
    await expect(
      refreshBaseBranch(dir, { base: "origin/main", upstream: null }, { force: true }),
    ).resolves.toBeUndefined();
    const status = await getWorkspaceGitStatus(dir);
    expect(status.baseFetchedAt).toBeNull();
  });

  test("nothing under origin/ means no fetch at all", async () => {
    await expect(
      refreshBaseBranch(dir, { base: "main", upstream: null }, { force: true }),
    ).resolves.toBeUndefined();
  });
});

describe("summarizeStatusPorcelain", () => {
  const record = (code: string, path: string) => `${code} ${path}`;

  test("counts index and worktree columns independently", () => {
    const out = [
      record("MM", "both.ts"),
      record("M ", "staged.ts"),
      record(" M", "unstaged.ts"),
      record("A ", "new.ts"),
      record("??", "loose.ts"),
    ].join("\0");
    const summary = summarizeStatusPorcelain(out);
    // MM contributes to both totals; ?? only to untracked.
    expect(summary).toMatchObject({ staged: 3, unstaged: 2, untracked: 1, truncated: false });
    expect(summary.files.find((f) => f.path === "both.ts")).toMatchObject({
      staged: true,
      status: "modified",
    });
  });

  test("totals cover every record even when the file list is capped", () => {
    const records: string[] = [];
    for (let i = 0; i < 40; i += 1) records.push(record(" M", `m${i}.ts`));
    for (let i = 0; i < 5; i += 1) records.push(record("??", `u${i}.ts`));
    const summary = summarizeStatusPorcelain(records.join("\0"));
    expect(summary.files).toHaveLength(30);
    expect(summary.truncated).toBe(true);
    // Untracked files sit entirely past the cap yet still count.
    expect(summary).toMatchObject({ staged: 0, unstaged: 40, untracked: 5 });
  });
});

describe("parseNumstat", () => {
  test("parses additions and deletions per path", () => {
    const stats = parseNumstat("10\t2\tsrc/a.ts\0" + "0\t5\tsrc/b.ts\0");
    expect(stats.get("src/a.ts")).toEqual({ additions: 10, deletions: 2 });
    expect(stats.get("src/b.ts")).toEqual({ additions: 0, deletions: 5 });
  });

  test("attributes renames to the destination path", () => {
    const stats = parseNumstat("3\t4\t\0old.ts\0new.ts\0");
    expect(stats.get("new.ts")).toEqual({ additions: 3, deletions: 4 });
    expect(stats.has("old.ts")).toBe(false);
  });

  test("treats binary files as unknown line counts", () => {
    const stats = parseNumstat("-\t-\timg.png\0");
    expect(stats.get("img.png")).toEqual({ additions: null, deletions: null });
  });
});

describe("commitWorkspace", () => {
  test("stages everything and commits", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "hi");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    writeFileSync(join(dir, "b.txt"), "more");
    const hash = await commitWorkspace(dir, "second commit");
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(git(dir, ["log", "--oneline", "-1"])).toContain("second commit");
  });

  test("empty message throws", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    await expect(commitWorkspace(dir, "   ")).rejects.toThrow("Commit message is empty");
  });
});

describe("isGhAvailable", () => {
  test("resolves to a boolean without throwing", async () => {
    expect(typeof (await isGhAvailable())).toBe("boolean");
  });

  test("concurrent callers share one probe", async () => {
    const [first, second] = await Promise.all([isGhAvailable(), isGhAvailable()]);
    expect(first).toBe(second);
  });
});

describe("resolvePrWithCache", () => {
  test("post-action reads immediately reflect created, ready, and merged PRs inside the cache window", async () => {
    const repository = "owner/post-action-transitions";
    let nodes: Parameters<typeof summarizePrNodes>[0] = [];
    const read = (force = false) =>
      resolvePrWithCache(repository, "feature", async () => summarizePrNodes(nodes), {
        now: 1000,
        force,
      });

    expect((await read()).summary.number).toBeNull();
    nodes = [
      { number: 42, url: "https://github.com/owner/repo/pull/42", state: "OPEN", isDraft: true },
    ];
    expect((await read()).summary.number).toBeNull();
    expect((await read(true)).summary).toMatchObject({ number: 42, isDraft: true });
    nodes = [{ ...nodes[0], isDraft: false }];
    expect((await read(true)).summary).toMatchObject({ number: 42, isDraft: false });
    nodes = [{ ...nodes[0], state: "MERGED" }];
    expect((await read(true)).summary).toMatchObject({ number: null, mergedNumber: 42 });
  });

  test("returns the last successful PR snapshot when a refresh fails", async () => {
    const repository = `owner/repo-${Date.now()}`;
    const freshSummary = summarizePrNodes([
      { number: 42, url: "https://github.com/owner/repo/pull/42", state: "OPEN" },
    ]);

    const fresh = await resolvePrWithCache(repository, "feature", async () => freshSummary, {
      now: 1000,
    });
    expect(fresh).toMatchObject({
      dataState: "fresh",
      updatedAt: 1000,
      summary: { number: 42 },
    });

    const stale = await resolvePrWithCache(
      repository,
      "feature",
      async () => {
        throw new Error("network down");
      },
      { now: 2000, force: true },
    );
    expect(stale).toMatchObject({
      dataState: "stale",
      updatedAt: 1000,
      summary: { number: 42 },
    });
  });

  test("serves a recent snapshot without asking GitHub again", async () => {
    // The metered call is the one worth avoiding: PR state changes on the
    // order of minutes, so within the window the last response is reused.
    const repository = `owner/ttl-${Date.now()}`;
    let calls = 0;
    const fetchSummary = async () => {
      calls += 1;
      return summarizePrNodes([
        { number: 7, url: "https://github.com/owner/repo/pull/7", state: "OPEN" },
      ]);
    };

    await resolvePrWithCache(repository, "feature", fetchSummary, { now: 1000, ttlMs: 60_000 });
    expect(calls).toBe(1);

    const cached = await resolvePrWithCache(repository, "feature", fetchSummary, {
      now: 30_000,
      ttlMs: 60_000,
    });
    expect(calls).toBe(1);
    expect(cached).toMatchObject({ dataState: "fresh", updatedAt: 1000, summary: { number: 7 } });

    // Past the window it asks again...
    await resolvePrWithCache(repository, "feature", fetchSummary, { now: 70_000, ttlMs: 60_000 });
    expect(calls).toBe(2);
    // ...and `force` ignores the window entirely.
    await resolvePrWithCache(repository, "feature", fetchSummary, {
      now: 70_001,
      ttlMs: 60_000,
      force: true,
    });
    expect(calls).toBe(3);
  });

  test("an older response that lands late never overwrites a newer one", async () => {
    // A background refresh starts, the user merges (forced read), and the
    // background answer arrives after the forced one. The pre-merge answer
    // must not replace the post-merge snapshot.
    const repository = `owner/race-${Date.now()}`;
    const open = summarizePrNodes([
      { number: 9, url: "https://github.com/owner/repo/pull/9", state: "OPEN" },
    ]);
    const merged = summarizePrNodes([
      { number: 9, url: "https://github.com/owner/repo/pull/9", state: "MERGED" },
    ]);
    let releaseOlder!: () => void;
    const older = resolvePrWithCache(
      repository,
      "feature",
      () => new Promise<PrSummary>((resolve) => (releaseOlder = () => resolve(open))),
      { now: 1000, force: true },
    );
    const newer = await resolvePrWithCache(repository, "feature", async () => merged, {
      now: 2000,
      force: true,
    });
    expect(newer.summary.mergedNumber).toBe(9);

    releaseOlder();
    // The late caller is handed the newer snapshot, not its own stale answer.
    expect((await older).summary).toEqual(merged);
    const cached = await resolvePrWithCache(
      repository,
      "feature",
      async () => {
        throw new Error("should be served from cache");
      },
      { now: 3000 },
    );
    expect(cached).toMatchObject({ dataState: "fresh", updatedAt: 2000 });
    expect(cached.summary).toEqual(merged);
  });

  test("reports unavailable when refresh fails before any successful response", async () => {
    const result = await resolvePrWithCache(
      `owner/uncached-${Date.now()}`,
      "feature",
      async () => {
        throw new Error("offline");
      },
      { now: 2000 },
    );
    expect(result).toMatchObject({
      dataState: "unavailable",
      updatedAt: null,
      summary: { number: null, pr: null },
    });
  });
});

describe("refreshPrSnapshot throttling", () => {
  afterEach(() => {
    resetPrRefreshesForTests();
  });

  test("a slow GitHub response never delays the status read", async () => {
    // The whole point of the background refresh: local git answers in ~70ms
    // while GitHub takes ~1s, so a status read must not await the network.
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "hi");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "init"]);
    git(dir, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);

    const startedAt = Date.now();
    const status = await getWorkspaceGitStatus(dir);
    // No upstream and no cached snapshot: no query is even attempted, and the
    // read certainly does not sit on a network round-trip.
    expect(status.repoState).toBe("ready");
    expect(status.prDataState).toBe("unavailable");
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  test("a cached snapshot past its window still reads fresh while refreshing", async () => {
    const repository = `owner/bg-${Date.now()}`;
    await resolvePrWithCache(
      repository,
      "feature",
      async () =>
        summarizePrNodes([
          { number: 5, url: "https://github.com/owner/repo/pull/5", state: "OPEN" },
        ]),
      { now: 1000 },
    );
    // Age alone is not staleness: only a failed attempt earns the warning.
    const aged = await resolvePrWithCache(
      repository,
      "feature",
      async () => {
        throw new Error("still trying");
      },
      { now: 1000 + PR_REFRESH_INTERVAL_MS + 1 },
    );
    expect(aged).toMatchObject({ dataState: "stale", summary: { number: 5 } });
  });
});

describe("mergeWorkspaceBranch", () => {
  test("conflict aborts instead of wedging the checkout in MERGING state", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "a.txt"), "side");
    git(dir, ["commit", "-am", "side change"]);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "a.txt"), "main");
    git(dir, ["commit", "-am", "main change"]);

    await expect(mergeWorkspaceBranch(dir, "side")).rejects.toThrow();
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  test("merges into the conventional base even when another feature branch is checked out", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "b.txt"), "side");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "side change"]);
    // The project root is parked on an unrelated feature branch: that must
    // never become the merge target.
    git(dir, ["checkout", "-b", "other-feature", "main"]);

    expect(await mergeWorkspaceBranch(dir, "side")).toBe("main");
    expect(git(dir, ["branch", "--show-current"])).toBe("main");
    expect(git(dir, ["log", "--oneline", "-1", "other-feature"])).toContain("base");
    expect(git(dir, ["log", "--oneline", "-1", "main"])).toContain("side");
  });

  test("refuses when no base branch can be determined", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" }, "trunk");
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "b.txt"), "side");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "side change"]);
    git(dir, ["checkout", "trunk"]);

    await expect(mergeWorkspaceBranch(dir, "side")).rejects.toThrow(/base branch/);
    expect(git(dir, ["log", "--oneline", "-1", "trunk"])).toContain("base");
  });

  test("waits for a commit in a linked worktree of the same repository", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    const work = join(dir, "..", `${basename(dir)}-side`);
    git(dir, ["worktree", "add", "-b", "side", work]);
    try {
      // Hooks are shared by every worktree of the repository: the slow
      // pre-commit hook logs its span, the merge hook logs when it runs.
      const log = join(dir, ".git", "hook-order.log");
      const hooks = join(dir, ".git", "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "pre-commit"),
        `#!/bin/sh\necho commit-start >> "${log}"\nsleep 1\necho commit-end >> "${log}"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(hooks, "post-merge"), `#!/bin/sh\necho merge >> "${log}"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(work, "b.txt"), "side");

      const commit = commitWorkspace(work, "side change");
      // Start the merge only once the commit holds the lock (its hook runs).
      while (!existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 20));
      const merge = mergeWorkspaceBranch(dir, "side");
      await commit;
      expect(await merge).toBe("main");

      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "commit-start",
        "commit-end",
        "merge",
      ]);
      // The merge saw the commit that finished first.
      expect(git(dir, ["log", "--oneline", "main"])).toContain("side change");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("clean merge returns the base branch", async () => {
    await initProjectRepo(dir, { name: "Test", email: "test@example.com" });
    writeFileSync(join(dir, "a.txt"), "base");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "b.txt"), "side");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "side change"]);
    git(dir, ["checkout", "main"]);

    expect(await mergeWorkspaceBranch(dir, "side")).toBe("main");
    expect(git(dir, ["log", "--oneline", "-1"])).toContain("side");
  });
});

describe("summarizeChecks", () => {
  test("empty rollup means none", () => {
    expect(summarizeChecks([])).toEqual({ checksState: "none", checks: [] });
  });

  test("all completed successes means passing; skipped is not a failure", () => {
    const { checksState, checks } = summarizeChecks([
      {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:20Z",
        detailsUrl: "https://ci/1",
      },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
    ]);
    expect(checksState).toBe("passing");
    expect(checks).toEqual([
      { name: "build", state: "passing", durationMs: 20_000, url: "https://ci/1" },
      { name: "lint", state: "skipped", durationMs: null, url: null },
      { name: "CodeRabbit", state: "passing", durationMs: null, url: null },
    ]);
  });

  test("incomplete runs mean pending", () => {
    expect(
      summarizeChecks([
        { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS" },
      ]).checksState,
    ).toBe("pending");
  });

  test("failures surface with names", () => {
    const { checksState, checks } = summarizeChecks([
      { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    expect(checksState).toBe("failing");
    expect(checks.map((c) => [c.name, c.state])).toEqual([
      ["build", "passing"],
      ["e2e", "failing"],
    ]);
  });

  test("re-runs dedupe by name with the latest start winning", () => {
    const { checksState, checks } = summarizeChecks([
      {
        __typename: "CheckRun",
        name: "react-doctor",
        status: "COMPLETED",
        conclusion: "FAILURE",
        startedAt: "2026-01-01T00:00:00Z",
      },
      {
        __typename: "CheckRun",
        name: "react-doctor",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-01-01T00:05:00Z",
      },
    ]);
    expect(checks).toHaveLength(1);
    expect(checksState).toBe("passing");
  });
});

describe("summarizePrNodes", () => {
  const openNode = {
    number: 12,
    title: "Feature",
    body: "## Summary\nthing",
    isDraft: true,
    state: "OPEN",
    url: "https://github.com/o/r/pull/12",
    commits: {
      nodes: [
        {
          commit: {
            deployments: {
              nodes: [
                {
                  environment: "Preview",
                  state: "ACTIVE",
                  latestStatus: { state: "SUCCESS", environmentUrl: "https://preview" },
                },
              ],
            },
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "build",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                  },
                ],
              },
            },
          },
        },
      ],
    },
    comments: {
      nodes: [
        {
          id: "c1",
          author: { login: "bot", avatarUrl: null },
          body: "hi",
          url: "https://c/1",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          isResolved: false,
          comments: {
            nodes: [
              {
                id: "r1",
                author: { login: "reviewer" },
                body: "fix this",
                path: "src/a.ts",
                line: 7,
              },
            ],
          },
        },
        { isResolved: true, comments: { nodes: [{ id: "r2", body: "done" }] } },
      ],
    },
  };

  test("open PR wins over an older merged one and carries full detail", () => {
    const summary = summarizePrNodes([openNode, { number: 7, url: "u7", state: "MERGED" }]);
    expect(summary.number).toBe(12);
    expect(summary.isDraft).toBe(true);
    expect(summary.checksState).toBe("passing");
    expect(summary.mergedNumber).toBeNull();
    expect(summary.pr?.state).toBe("open");
    expect(summary.pr?.title).toBe("Feature");
    expect(summary.pr?.deployments).toEqual([
      { environment: "Preview", state: "success", url: "https://preview" },
    ]);
    // Issue comment first, then only the unresolved review thread opener.
    expect(summary.pr?.comments.map((c) => c.id)).toEqual(["c1", "r1"]);
    expect(summary.pr?.comments[1]).toMatchObject({ path: "src/a.ts", line: 7 });
  });

  test("merged PR is reported only when nothing is open", () => {
    const summary = summarizePrNodes([{ number: 7, url: "u7", state: "MERGED", title: "Landed" }]);
    expect(summary.number).toBeNull();
    expect(summary.mergedNumber).toBe(7);
    expect(summary.pr).toMatchObject({ state: "merged", title: "Landed" });
  });

  test("no nodes means no PR", () => {
    expect(summarizePrNodes([])).toMatchObject({ number: null, mergedNumber: null, pr: null });
  });

  test("a fork's PR with the same head branch name is never selected", () => {
    const forkPr = {
      number: 99,
      state: "OPEN",
      url: "https://github.com/o/r/pull/99",
      isCrossRepository: true,
    };
    expect(summarizePrNodes([forkPr])).toMatchObject({
      number: null,
      mergedNumber: null,
      pr: null,
    });
    // Our own PR is still found behind it.
    expect(summarizePrNodes([forkPr, { ...openNode, isCrossRepository: false }]).number).toBe(12);
  });
});

describe("parseGitHubRepo", () => {
  test("parses ssh and https forms", () => {
    expect(parseGitHubRepo("git@github.com:maker-or/omni.git")).toEqual({
      owner: "maker-or",
      name: "omni",
    });
    expect(parseGitHubRepo("https://github.com/maker-or/omni.git")).toEqual({
      owner: "maker-or",
      name: "omni",
    });
    expect(parseGitHubRepo("https://github.com/maker-or/omni")).toEqual({
      owner: "maker-or",
      name: "omni",
    });
  });

  test("rejects non-GitHub remotes", () => {
    expect(parseGitHubRepo("git@gitlab.com:o/r.git")).toBeNull();
  });
});
