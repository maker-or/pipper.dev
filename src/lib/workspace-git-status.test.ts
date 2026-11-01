import { describe, expect, test } from "vitest";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import { workspaceGitTone } from "./workspace-git-status";

function status(patch: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    repoState: "ready",
    branch: "feature",
    upstream: "origin/feature",
    ahead: 0,
    behind: 0,
    aheadOfBase: 1,
    behindBase: 0,
    baseBranch: "origin/main",
    baseFetchedAt: null,
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
    prUpdatedAt: null,
    prRefreshing: false,
    ...patch,
  };
}

describe("workspaceGitTone", () => {
  test("work without a PR is neutral", () => {
    expect(workspaceGitTone(status({ unstaged: 2 }))).toBe("neutral");
  });

  test("an idle workspace the base moved past is stale", () => {
    expect(workspaceGitTone(status({ behindBase: 3 }))).toBe("stale");
  });

  test("an open PR with green checks and a clean tree is ready", () => {
    expect(workspaceGitTone(status({ openPrNumber: 4, checksState: "passing" }))).toBe("ready");
  });

  test("an open PR with unsaved work, a draft or failing checks needs action", () => {
    expect(workspaceGitTone(status({ openPrNumber: 4, unstaged: 1 }))).toBe("action");
    expect(workspaceGitTone(status({ openPrNumber: 4, isDraftPr: true }))).toBe("action");
    expect(workspaceGitTone(status({ openPrNumber: 4, checksState: "failing" }))).toBe("action");
  });

  test("a landed PR is merged, whatever the base did since", () => {
    expect(workspaceGitTone(status({ mergedPrNumber: 9, behindBase: 5 }))).toBe("merged");
  });

  test("a workspace git couldn't read stays neutral", () => {
    expect(workspaceGitTone(status({ repoState: "broken", openPrNumber: 4 }))).toBe("neutral");
  });
});
