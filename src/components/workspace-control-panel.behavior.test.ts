import { describe, expect, test } from "vitest";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import { hasTeamChanges } from "./workspace-control-panel";

function status(patch: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    repoState: "ready",
    branch: "feature",
    upstream: "origin/feature",
    ahead: 0,
    behind: 0,
    aheadOfBase: 0,
    behindBase: 0,
    baseBranch: "origin/main",
    baseFetchedAt: Date.now(),
    staged: 0,
    unstaged: 0,
    untracked: 0,
    files: [],
    truncated: false,
    branchLines: null,
    remoteHost: "github.com",
    repository: "owner/repo",
    ghAvailable: true,
    openPrNumber: null,
    openPrUrl: null,
    isDraftPr: false,
    mergedPrNumber: null,
    mergedPrUrl: null,
    checksState: "unknown",
    checks: [],
    pr: null,
    prDataState: "fresh",
    prUpdatedAt: Date.now(),
    prRefreshing: false,
    ...patch,
  };
}

describe("hasTeamChanges", () => {
  test("announces base commits a live workspace does not have", () => {
    expect(hasTeamChanges(status({ behindBase: 3 }))).toBe(true);
  });

  test("stays quiet when the base has not moved", () => {
    expect(hasTeamChanges(status({ behindBase: 0 }))).toBe(false);
  });

  test("stays quiet once the workspace's own PR has merged", () => {
    // Regression: merging puts this branch's work (plus the merge commit) on
    // the base, so behindBase counts the user's own landed changes and every
    // merged workspace claimed the team had moved ahead of it.
    expect(hasTeamChanges(status({ behindBase: 4, openPrNumber: null, mergedPrNumber: 12 }))).toBe(
      false,
    );
  });

  test("still announces while a PR is open and unmerged", () => {
    expect(hasTeamChanges(status({ behindBase: 2, openPrNumber: 9, mergedPrNumber: null }))).toBe(
      true,
    );
  });
});
