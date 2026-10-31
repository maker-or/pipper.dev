import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Thread } from "../../contracts/threads.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import { callAsAgent, runAsUser, type AgentContext } from "./define.ts";
import { ProvenanceStore, ensureProvenanceSchema } from "./provenance.ts";
import { configureThreadOperations, createThread, type ThreadDeps } from "./threads.ts";
import { configureWorkspaceOperations, type WorkspaceDeps } from "./workspaces.ts";

const PROJECT = { id: "p1", path: "/repo", name: "repo", icon: "" };

function fakeApp() {
  const db = new DatabaseSync(":memory:");
  ensureProvenanceSchema(db);
  const provenance = new ProvenanceStore(() => db);
  const worktrees: Worktree[] = [
    { path: "/repo", branch: "main", head: "a", isProjectRoot: true },
    { path: "/wt/feature", branch: "pipper/feature", head: "b" },
  ];
  const created: Array<Parameters<ThreadDeps["createThread"]>[0]> = [];
  const rolledBack: string[] = [];
  let failCreate = false;

  configureWorkspaceOperations({
    listProjects: () => [PROJECT],
    getProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    listWorktrees: async () => worktrees,
    createWorkspace: async (request: { name: string }) => {
      const worktree = { path: `/wt/${request.name}`, branch: `pipper/${request.name}`, head: "c" };
      worktrees.push(worktree);
      return {
        project: PROJECT,
        worktree,
        policy: "source-only",
        setup: Promise.resolve({ status: "skipped" }),
        rollback: async () => {
          rolledBack.push(worktree.path);
        },
      };
    },
    broadcastChanged: () => {},
    provenance,
  } as unknown as WorkspaceDeps);

  configureThreadOperations({
    listModels: async (agentId: string) =>
      agentId === "codex" ? [{ modelId: "gpt-5.5", name: "GPT-5.5" }] : null,
    getProject: (id: string) => (id === PROJECT.id ? PROJECT : null),
    listWorktrees: async () => worktrees,
    createThread: async (input: Parameters<ThreadDeps["createThread"]>[0]) => {
      if (failCreate) throw new Error("agent failed to start");
      created.push(input);
      return {
        id: `t${created.length}`,
        project_id: input.projectId,
        worktree_path: input.worktreePath,
      } as Thread;
    },
  } as unknown as ThreadDeps);

  return {
    created,
    rolledBack,
    provenance,
    failCreating: () => {
      failCreate = true;
    },
  };
}

function agent(threadId = "caller"): AgentContext {
  return {
    caller: { kind: "agent", threadId },
    lineage: [threadId],
    owns: (id) => id === threadId,
  };
}

afterEach(() => {
  configureThreadOperations(null);
  configureWorkspaceOperations(null);
});

describe("threads.create", () => {
  test("from the UI: a foreground thread on the root, placed after another tab", async () => {
    const app = fakeApp();

    const result = await runAsUser(createThread, {
      project: "p1",
      title: "",
      workspace: null,
      after: "t0",
      activation: "foreground",
    });

    expect(result).toMatchObject({ cwd: "/repo", worktreePath: null, createdWorkspace: null });
    expect(app.created).toEqual([
      {
        projectId: "p1",
        agentId: null,
        title: null,
        worktreePath: null,
        model: null,
        after: "t0",
        background: false,
      },
    ]);
  });

  test("an agent's thread in the caller's folder, given as the project path, runs on the root", async () => {
    const app = fakeApp();

    const outcome = await callAsAgent(
      createThread,
      { project: "p1", agent: "codex", title: "Kid", workspace: "/repo", activation: "background" },
      agent(),
    );

    expect(outcome.status).toBe("done");
    expect(app.created[0]).toMatchObject({
      worktreePath: null,
      background: true,
      agentId: "codex",
    });
  });

  test("an agent can't place a thread outside its project's workspaces", async () => {
    const app = fakeApp();

    await expect(
      callAsAgent(
        createThread,
        {
          project: "p1",
          agent: "codex",
          title: "x",
          workspace: "/tmp/elsewhere",
          activation: "background",
        },
        agent(),
      ),
    ).rejects.toThrow(/not a workspace of this project/);
    expect(app.created).toEqual([]);
  });

  test("a new workspace is recorded as the caller's, and rolled back if the thread fails", async () => {
    const app = fakeApp();
    const outcome = await callAsAgent(
      createThread,
      {
        project: "p1",
        agent: "codex",
        title: "Fix Login!",
        workspace: "new",
        activation: "background",
      },
      agent(),
    );
    if (outcome.status !== "done") throw new Error("expected done");
    const path = outcome.result.createdWorkspace!.path;
    expect(path).toMatch(/^\/wt\/fix-login-[0-9a-f]{4}$/);
    expect(outcome.result.cwd).toBe(path);

    app.failCreating();
    await expect(
      callAsAgent(
        createThread,
        {
          project: "p1",
          agent: "codex",
          title: "Again",
          workspace: "new",
          activation: "background",
        },
        agent(),
      ),
    ).rejects.toThrow(/agent failed to start/);
    expect(app.rolledBack).toHaveLength(1);
    expect(app.rolledBack[0]).toMatch(/^\/wt\/again-/);
  });

  test("an agent's model is matched to the agent's catalog, and an unknown one is refused", async () => {
    const app = fakeApp();
    const start = (model: string) =>
      callAsAgent(
        createThread,
        { project: "p1", agent: "codex", title: "m", model, activation: "background" },
        agent(),
      );

    await start("GPT-5.5");
    expect(app.created[0]!.model).toBe("gpt-5.5");
    await expect(start("claude-opus")).rejects.toThrow(
      /codex has no model "claude-opus"\. Available: gpt-5\.5/,
    );
    expect(app.created).toHaveLength(1);
  });

  test("an agent with no known catalog keeps the model it was given", async () => {
    const app = fakeApp();
    await callAsAgent(
      createThread,
      { project: "p1", agent: "claude", title: "m", model: "opus", activation: "background" },
      agent(),
    );
    expect(app.created[0]!.model).toBe("opus");
  });
});
