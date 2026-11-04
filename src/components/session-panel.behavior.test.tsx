import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import { SessionPanel, SessionSubthreads, type SessionWorkspace } from "@/components/session-panel";
import { workspaceGitTone } from "@/lib/workspace-git-status";

const PROJECT = { id: "project", path: "/repo", name: "repo", icon: null };

function status(patch: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    repoState: "ready",
    branch: "feature",
    upstream: "origin/feature",
    ahead: 0,
    behind: 0,
    aheadOfBase: 2,
    behindBase: 0,
    baseBranch: "origin/main",
    baseFetchedAt: Date.now(),
    staged: 0,
    unstaged: 0,
    untracked: 0,
    files: [],
    truncated: false,
    branchLines: { additions: 12, deletions: 3 },
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

function session(git: WorkspaceGitStatus | null, patch: Partial<SessionWorkspace> = {}) {
  return {
    draft: false,
    project: PROJECT,
    cwd: "/repo/.worktrees/feature",
    threadId: "parent",
    isStreaming: false,
    status: git,
    refresh: async () => {},
    tone: git ? workspaceGitTone(git) : "neutral",
    ...patch,
  } satisfies SessionWorkspace;
}

function task(taskId: string, patch: Partial<AgentTaskSnapshot> = {}): AgentTaskSnapshot {
  return {
    taskId,
    parentThreadId: "parent",
    childThreadId: `child-${taskId}`,
    projectId: "project",
    agentId: "codex-acp",
    title: `Task ${taskId}`,
    status: "running",
    outcome: null,
    waitingForPermission: false,
    workspaceMode: "shared",
    workspacePath: "/repo",
    branch: null,
    depth: 1,
    turns: 0,
    createdAt: 1,
    updatedAt: 1,
    reportPreview: null,
    nextStep: null,
    error: null,
    ...patch,
  };
}

function render(workspace: SessionWorkspace) {
  return renderToStaticMarkup(<SessionPanel session={workspace} />);
}

describe("SessionPanel", () => {
  test("a green open PR offers Merge beside its PR number, and lists its checks", () => {
    const html = render(
      session(
        status({
          openPrNumber: 17,
          openPrUrl: "https://github.com/owner/repo/pull/17",
          checksState: "passing",
          checks: [{ name: "build", state: "passing", url: null, durationMs: null }],
          pr: {
            number: 17,
            url: "https://github.com/owner/repo/pull/17",
            title: "Fix login",
            body: "",
            isDraft: false,
            state: "open",
            additions: 12,
            deletions: 3,
            deployments: [],
            comments: [],
          },
        }),
      ),
    );
    // Merge, then the PR button right after it, labelled with the bare number.
    const merge = html.indexOf(">Merge<");
    const prButton = html.indexOf('aria-label="Open pull request #17 on GitHub"');
    expect(merge).toBeGreaterThan(-1);
    expect(prButton).toBeGreaterThan(merge);
    const prButtonHtml = html.slice(prButton, html.indexOf("</button>", prButton));
    expect(prButtonHtml).toContain(">17<");
    expect(prButtonHtml).not.toContain("#17<");
    expect(html).toContain("build");
  });

  test("opens on Check, with Changes and Files beside it", () => {
    const html = render(session(status()));
    expect(html).toMatch(/aria-selected="true"[^>]*>Check</);
    expect(html).toContain(">Changes<");
    expect(html).toContain(">Files<");
    expect(html).not.toContain("Connectors");
  });

  test("a pushed branch without a PR offers to create one, with no PR link", () => {
    const html = render(session(status()));
    expect(html).not.toContain("Open pull request");
    expect(html).toContain("Create a PR");
    // One step, no dropdown of other actions.
    expect(html).not.toContain("More options");
    expect(html).toContain("No pull request for this branch yet.");
    expect(html).toContain("owner/repo");
  });

  test("the base branch offers no PR step and no Check", () => {
    const html = render(session(status({ branch: "main", untracked: 3, aheadOfBase: 0 })));
    expect(html).not.toContain("Commit and push");
    expect(html).not.toContain("No pull request");
    expect(html).toContain("owner/repo");
  });

  test("a draft has no session to show", () => {
    const html = render(session(null, { draft: true, project: null, cwd: null, threadId: null }));
    expect(html).toContain("Open a thread to see its session.");
    expect(html).not.toContain("Check");
  });
});

function subthreads(tasks: AgentTaskSnapshot[], dismissedIds: string[] = []) {
  return renderToStaticMarkup(
    <SessionSubthreads
      threadId="parent"
      agents={[]}
      tasks={tasks}
      dismissedIds={dismissedIds}
      onDismiss={() => {}}
    />,
  );
}

describe("SessionSubthreads", () => {
  test("lists only the subthreads the displayed thread started, by title alone", () => {
    const html = subthreads([
      task("a", { title: "Explore the codebase" }),
      task("b", { title: "Another thread's task", parentThreadId: "other" }),
      task("c", { title: "Write tests", status: "idle", outcome: "needs_input" }),
    ]);
    expect(html).toContain("Subthreads");
    expect(html).toContain("Explore the codebase");
    expect(html).toContain("Write tests");
    expect(html).not.toContain(">Has a question<");
    expect(html).not.toContain("Another thread");
  });

  test("a finished subthread stays with a close button, shown on hover; a running one has none", () => {
    const html = subthreads([
      task("a", { title: "Explore the codebase" }),
      task("b", { title: "Fix the bug", status: "idle", outcome: "done" }),
    ]);
    expect(html).toContain("Fix the bug");
    expect(html).not.toContain(">Done<");
    expect(html).toContain('aria-label="Close Fix the bug"');
    expect(html).toMatch(
      /aria-label="Close Fix the bug"[^>]*class="[^"]*opacity-0[^"]*group-hover\/subthread:opacity-100/,
    );
    expect(html).not.toContain('aria-label="Close Explore the codebase"');
  });

  test("a closed subthread leaves the list, and the section goes with the last one", () => {
    const finished = task("b", { title: "Fix the bug", status: "idle", outcome: "done" });
    expect(subthreads([task("a"), finished], ["b"])).not.toContain("Fix the bug");
    expect(subthreads([finished], ["b"])).toBe("");
  });

  test("shows nothing for a thread that started none", () => {
    expect(subthreads([task("b", { parentThreadId: "other" })])).toBe("");
  });
});
