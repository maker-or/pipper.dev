import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Thread } from "../../contracts/threads.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import { runAsUser } from "./define.ts";
import { ProvenanceStore, ensureProvenanceSchema } from "./provenance.ts";
import {
  configureWorkspaceOperations,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  type WorkspaceDeps,
} from "./workspaces.ts";

const PROJECT = { id: "p1", path: "/repo", name: "repo", icon: "" };

function fakeApp() {
  const db = new DatabaseSync(":memory:");
  ensureProvenanceSchema(db);
  const worktrees: Worktree[] = [
    { path: "/repo", branch: "main", head: "a", isProjectRoot: true },
    { path: "/wt/feature", branch: "pipper/feature", head: "b" },
  ];
  const threads: Thread[] = [
    { id: "t-root", project_id: "p1", worktree_path: null } as Thread,
    { id: "t-a", project_id: "p1", worktree_path: "/wt/feature" } as Thread,
    { id: "t-b", project_id: "p1", worktree_path: "/wt/feature" } as Thread,
  ];
  const log: string[] = [];
  let failThread: string | null = null;
  let active: string | null = "t-a";
  let selections: Record<string, string> = { p1: "/wt/feature" };
  let nextActive = "t-root";
  const deps: WorkspaceDeps = {
    listProjects: () => [PROJECT],
    getProject: (id) => (id === PROJECT.id ? PROJECT : null),
    listWorktrees: async () => worktrees.map((w) => ({ ...w })),
    createWorkspace: async (request) => {
      const worktree = { path: `/wt/${request.name}`, branch: `pipper/${request.name}`, head: "c" };
      worktrees.push(worktree);
      log.push(`create ${request.name} ${request.activation}`);
      return {
        project: PROJECT,
        worktree,
        policy: "source-only",
        setup: Promise.resolve({ status: "skipped" }),
        rollback: async () => {},
      };
    },
    cancelWorkspaceSetup: async (path) => {
      log.push(`cancel-setup ${path}`);
    },
    removeWorktree: async (_projectPath, path) => {
      log.push(`remove ${path}`);
      const index = worktrees.findIndex((w) => w.path === path);
      return worktrees.splice(index, 1)[0];
    },
    gitStatus: async () => {
      throw new Error("not used");
    },
    listThreads: () => threads,
    threadTitle: () => null,
    deleteThread: async (id) => {
      if (id === failThread) throw new Error(`can't delete ${id}`);
      log.push(`delete-thread ${id}`);
    },
    activeThreadId: () => active,
    switchThread: async (id) => {
      active = id;
      log.push(`switch ${id}`);
    },
    clearActiveThread: async () => {
      active = null;
      log.push("clear-active");
    },
    removeThreadTabs: async (ids) => {
      log.push(`remove-tabs ${ids.join(",")}`);
      return { openThreadIds: [nextActive], activeThreadId: nextActive, threadSwitchHistory: [] };
    },
    readOpenTabsState: async () => ({
      openThreadIds: [],
      activeThreadId: null,
      threadSwitchHistory: [],
    }),
    broadcastTabs: (state) => log.push(`broadcast-tabs ${state.activeThreadId}`),
    broadcastDeleted: (event) => log.push(`broadcast-deleted ${event.path}`),
    broadcastChanged: (event) => log.push(`changed ${event.projectId}`),
    readWorkspaceSelections: async () => selections,
    updateWorkspaceSelection: async (_projectId, path) => {
      log.push(`select ${path}`);
    },
    provenance: new ProvenanceStore(() => db),
  };
  configureWorkspaceOperations(deps);
  return {
    log,
    deps,
    failDeleting: (id: string) => {
      failThread = id;
    },
    select: (next: Record<string, string>) => {
      selections = next;
    },
    /** The tab that becomes active once the deleted threads' tabs close. */
    activateAfter: (threadId: string) => {
      nextActive = threadId;
    },
    threads,
    worktrees,
  };
}

afterEach(() => configureWorkspaceOperations(null));

describe("workspace operations from the UI", () => {
  test("delete removes the worktree first, then its threads and tabs, then reselects the root", async () => {
    const app = fakeApp();

    const removed = await runAsUser(deleteWorkspace, { project: "p1", path: "/wt/feature" });

    expect(removed.path).toBe("/wt/feature");
    expect(app.log).toEqual([
      "cancel-setup /wt/feature",
      "remove /wt/feature",
      "broadcast-deleted /wt/feature",
      "changed p1",
      "remove-tabs t-a,t-b",
      "delete-thread t-a",
      "delete-thread t-b",
      "select /repo",
      "switch t-root",
      "broadcast-tabs t-root",
    ]);
  });

  test("a thread that won't delete still lets the rest finish, then reports the failure", async () => {
    const app = fakeApp();
    app.failDeleting("t-a");

    await expect(
      runAsUser(deleteWorkspace, { project: "p1", path: "/wt/feature" }),
    ).rejects.toThrow("Workspace removed, but some chat cleanup failed");
    expect(app.log).toContain("delete-thread t-b");
    expect(app.log).toContain("broadcast-tabs t-root");
  });

  test("deleting a workspace the user isn't on leaves their selection alone", async () => {
    const app = fakeApp();
    app.worktrees.push({ path: "/wt/other", branch: "pipper/other", head: "d" });
    app.threads.push({ id: "t-c", project_id: "p1", worktree_path: "/wt/other" } as Thread);
    app.select({ p1: "/wt/other" });
    app.activateAfter("t-c");

    await runAsUser(deleteWorkspace, { project: "p1", path: "/wt/feature" });

    expect(app.log.some((line) => line.startsWith("select "))).toBe(false);
  });

  test("deleting the selected workspace follows the thread that stays open", async () => {
    const app = fakeApp();
    app.worktrees.push({ path: "/wt/other", branch: "pipper/other", head: "d" });
    app.threads.push({ id: "t-c", project_id: "p1", worktree_path: "/wt/other" } as Thread);
    app.activateAfter("t-c");

    await runAsUser(deleteWorkspace, { project: "p1", path: "/wt/feature" });

    expect(app.log).toContain("select /wt/other");
  });

  test("the project root can't be deleted, and nothing is touched", async () => {
    const app = fakeApp();
    await expect(runAsUser(deleteWorkspace, { project: "p1", path: "/repo" })).rejects.toThrow(
      /project's root/,
    );
    expect(app.log).toEqual([]);
  });

  test("list and create take a project id or path; a user's workspace has no creator", async () => {
    const app = fakeApp();
    expect((await runAsUser(listWorkspaces, { project: "/repo" })).map((w) => w.path)).toEqual([
      "/repo",
      "/wt/feature",
    ]);
    const created = await runAsUser(createWorkspace, {
      project: "p1",
      name: "spike",
      activation: "foreground",
    });
    expect(created.worktree.path).toBe("/wt/spike");
    expect(app.log).toEqual(["create spike foreground", "changed p1"]);
    expect(app.deps.provenance.createdBy("workspace", "/wt/spike")).toBeNull();
  });

  test("bad input is refused with a readable message", async () => {
    fakeApp();
    await expect(
      runAsUser(createWorkspace, { project: "p1", activation: "foreground" }),
    ).rejects.toThrow(/name/);
    await expect(runAsUser(listWorkspaces, { project: "nope" })).rejects.toThrow(
      "Project not found: nope",
    );
  });
});
