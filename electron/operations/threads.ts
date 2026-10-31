import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { Project } from "../../contracts/projects.ts";
import type { Thread, ThreadMoveResult } from "../../contracts/threads.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import { samePath } from "../worktree-manager.ts";
import { defineOperation, OperationInputError } from "./define.ts";
import { createWorkspace } from "./workspaces.ts";

/**
 * Thread operations that change Pipper's own state: create a thread, delete
 * one, and move one to another workspace. The IPC handlers (`threads:create`,
 * `threads:delete`, `threads:move`) and the agent tools (`start_subthread`
 * and `create_thread`, `delete_thread`, `move_thread`) all run these. See
 * docs/capabilities/design.md.
 */

export interface ThreadDeps {
  getThread(id: string): Thread | null;
  /**
   * Create the thread row and its tab. `background` leaves the selection and
   * the active tab alone; `after` places the tab after that thread's.
   */
  createThread(input: {
    projectId: string;
    agentId: string | null;
    title: string | null;
    worktreePath: string | null;
    model: string | null;
    after: string | null;
    background: boolean;
  }): Promise<Thread>;
  /** The agent's models as Pipper last saw them, or null when it hasn't yet. */
  listModels(agentId: string): Promise<Array<{ modelId: string; name: string }> | null>;
  getProject(id: string): Project | null;
  listWorktrees(projectPath: string): Promise<Worktree[]>;
  threadTitle(id: string): string | null;
  isTurnInFlight(id: string): boolean;
  /** Delete the thread and close its tab, as the user's own delete does. */
  deleteThread(id: string): Promise<void>;
  /** Persist the thread's workspace: a worktree path, or null for the root. */
  setThreadWorkspace(id: string, worktreePath: string | null): void;
  /**
   * End the thread's session so the next one starts in its new directory;
   * reopen it at once when it is the thread on screen.
   */
  reloadThreadSession(id: string): Promise<void>;
  /** Tell every window the thread row changed (tabs, header, selection). */
  threadChanged(id: string): void;
  /** Files with uncommitted changes in a workspace, or null when unknown. */
  uncommittedFiles(worktreePath: string): Promise<string[] | null>;
}

let deps: ThreadDeps | null = null;
/** Moves waiting for their thread's running turn to settle: thread → target. */
const pendingMoves = new Map<string, string | null>();
const moveListeners = new Set<(event: ThreadMoved) => void>();

export interface ThreadMoved {
  threadId: string;
  /** The new worktree path, or null for the project root. */
  worktreePath: string | null;
  /** The directory the thread now runs in. */
  cwd: string;
}

/** Wire the operations to the app (main process) or to fakes (tests). */
export function configureThreadOperations(next: ThreadDeps | null): void {
  deps = next;
  pendingMoves.clear();
}

/** Hear about applied moves (the task service updates its rows). */
export function onThreadMoved(listener: (event: ThreadMoved) => void): () => void {
  moveListeners.add(listener);
  return () => moveListeners.delete(listener);
}

function requireDeps(): ThreadDeps {
  if (!deps) throw new Error("Thread operations are not configured");
  return deps;
}

function requireThread(id: string): Thread {
  const thread = requireDeps().getThread(id);
  if (!thread) throw new OperationInputError(`No thread ${id}. Call list_threads.`);
  return thread;
}

function titleOf(thread: Thread): string {
  return requireDeps().threadTitle(thread.id) ?? thread.title ?? "Untitled";
}

const threadRef = z.string().min(1).describe("A thread_id from list_threads or get_thread.");

/** A new workspace's name: the thread's title as a slug, plus a short suffix. */
export function workspaceNameFor(title: string | null): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${slug || "thread"}-${randomBytes(2).toString("hex")}`;
}

/**
 * The model id for `model` in the agent's catalog, matched by id, then by id
 * or name ignoring case. An agent without a known catalog can't be checked,
 * so its model passes through; the agent reports it if it's wrong.
 */
export async function resolveModel(
  agentId: string,
  model: string | null | undefined,
): Promise<string | null> {
  const wanted = model?.trim();
  if (!wanted) return null;
  const models = await requireDeps().listModels(agentId);
  if (!models?.length) return wanted;
  const lower = wanted.toLowerCase();
  const match =
    models.find((candidate) => candidate.modelId === wanted) ??
    models.find(
      (candidate) =>
        candidate.modelId.toLowerCase() === lower || candidate.name.toLowerCase() === lower,
    );
  if (match) return match.modelId;
  const shown = models.slice(0, 20).map((candidate) => candidate.modelId);
  throw new OperationInputError(
    `${agentId} has no model "${wanted}". Available: ${shown.join(", ")}` +
      `${models.length > shown.length ? ", …" : ""}. Leave model out for the agent's default.`,
  );
}

export interface CreatedThread {
  thread: Thread;
  /** The directory the thread runs in. */
  cwd: string;
  /** The worktree it runs in, or null for the project root. */
  worktreePath: string | null;
  /** Set when this call created the thread's workspace. */
  createdWorkspace: { path: string; branch: string | null } | null;
}

export const createThread = defineOperation({
  id: "threads.create",
  tier: "local",
  input: z.object({
    project: z.string().min(1),
    agent: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    workspace: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('"new" for a new worktree, a workspace path, or null for the project root.'),
    setup: z.enum(["prepared", "source-only"]).optional(),
    model: z.string().nullable().optional(),
    after: z.string().nullable().optional(),
    activation: z.enum(["foreground", "background"]),
  }),

  async run(input, ctx): Promise<CreatedThread> {
    const d = requireDeps();
    const project = d.getProject(input.project);
    if (!project) throw new OperationInputError(`Project not found: ${input.project}`);
    const title = input.title?.trim() || null;
    // The UI's pickers only offer catalog models; an agent may guess.
    const model =
      ctx.caller.kind === "agent" && input.agent
        ? await resolveModel(input.agent, input.model)
        : input.model || null;

    let worktreePath: string | null = null;
    let created: Awaited<ReturnType<typeof createWorkspace.run>> | null = null;
    if (input.workspace === "new") {
      created = await createWorkspace.run(
        {
          project: project.id,
          name: workspaceNameFor(title),
          setup: input.setup,
          activation: "background",
        },
        ctx,
      );
      worktreePath = created.worktree.path;
    } else if (input.workspace && !samePath(input.workspace, project.path)) {
      if (ctx.caller.kind === "agent") {
        const match = (await d.listWorktrees(project.path)).find((worktree) =>
          samePath(worktree.path, input.workspace!),
        );
        if (!match) {
          throw new OperationInputError(
            `${input.workspace} is not a workspace of this project. Call list_workspaces.`,
          );
        }
        worktreePath = match.isProjectRoot ? null : match.path;
      } else {
        // The user picked it in Pipper's own UI.
        worktreePath = input.workspace;
      }
    }

    let thread: Thread;
    try {
      thread = await d.createThread({
        projectId: project.id,
        agentId: input.agent || null,
        title,
        worktreePath,
        model,
        after: input.after || null,
        background: input.activation === "background",
      });
    } catch (error) {
      await created?.rollback().catch(() => {});
      throw error;
    }
    return {
      thread,
      cwd: worktreePath ?? project.path,
      worktreePath,
      createdWorkspace: created
        ? { path: created.worktree.path, branch: created.worktree.branch ?? null }
        : null,
    };
  },
});

export const deleteThread = defineOperation({
  id: "threads.delete",
  tier: "destructive",
  input: z.object({ thread: threadRef }),

  async forbid({ thread }, ctx) {
    requireThread(thread);
    if (thread === ctx.caller.threadId) return "You can't delete your own thread.";
    if (ctx.lineage.includes(thread)) return "You can't delete a thread that started you.";
    return null;
  },

  async owned({ thread }, ctx) {
    return ctx.owns(thread);
  },

  async describe({ thread }) {
    const row = requireThread(thread);
    const running = requireDeps().isTurnInFlight(thread) ? 1 : 0;
    return {
      title: `Delete thread “${titleOf(row)}”`,
      verb: "delete",
      impact: running ? ["its turn in progress"] : [],
      measures: { running },
    };
  },

  async run({ thread }) {
    const row = requireThread(thread);
    pendingMoves.delete(thread);
    await requireDeps().deleteThread(thread);
    return { thread: row.id, title: titleOf(row) };
  },
});

export const moveThread = defineOperation({
  id: "threads.move",
  tier: "local",
  input: z.object({
    thread: threadRef,
    workspace: z
      .string()
      .min(1)
      .describe("A workspace path from list_workspaces; the project's root path for main."),
  }),

  async forbid({ thread }, ctx) {
    requireThread(thread);
    if (thread === ctx.caller.threadId || ctx.owns(thread)) return null;
    return "You can only move your own thread or threads you started; it would change where someone else's work runs.";
  },

  async run(input): Promise<ThreadMoveResult> {
    const d = requireDeps();
    const thread = requireThread(input.thread);
    const project = d.getProject(thread.project_id);
    if (!project) throw new OperationInputError(`Project not found: ${thread.project_id}`);
    const target = (await d.listWorktrees(project.path)).find((worktree) =>
      samePath(worktree.path, input.workspace),
    );
    if (!target) {
      throw new OperationInputError(
        `${input.workspace} is not a workspace of this thread's project. Call list_workspaces.`,
      );
    }
    const worktreePath = target.isProjectRoot ? null : target.path;
    // A thread on the root runs in the project's own directory, which can sit
    // below the repository root (resolveThreadCwd).
    const cwd = worktreePath ?? project.path;
    const from = thread.worktree_path ?? null;
    const name = target.isProjectRoot ? "main" : (target.workspaceName ?? basename(target.path));
    const unchanged =
      from === null ? worktreePath === null : worktreePath !== null && samePath(from, worktreePath);
    if (unchanged) {
      // Moving back before a pending move landed cancels it.
      pendingMoves.delete(thread.id);
      return { status: "unchanged", workspace: name, cwd, leftBehind: [] };
    }
    // Uncommitted changes stay where they were made; say so before moving.
    const leftBehind = (await d.uncommittedFiles(from ?? project.path)) ?? [];
    if (d.isTurnInFlight(thread.id)) {
      pendingMoves.set(thread.id, worktreePath);
      return { status: "after_turn", workspace: name, cwd, leftBehind };
    }
    await applyMove(thread.id, worktreePath, cwd);
    return { status: "moved", workspace: name, cwd, leftBehind };
  },
});

async function applyMove(threadId: string, worktreePath: string | null, cwd: string) {
  const d = requireDeps();
  pendingMoves.delete(threadId);
  d.setThreadWorkspace(threadId, worktreePath);
  for (const listener of moveListeners) listener({ threadId, worktreePath, cwd });
  d.threadChanged(threadId);
  await d.reloadThreadSession(threadId);
}

/**
 * A thread's turn settled: apply a move that waited for it. A session's
 * working directory can't change mid-turn, so moves land between turns.
 */
export async function applyPendingMove(threadId: string): Promise<void> {
  if (!deps || !pendingMoves.has(threadId)) return;
  if (deps.isTurnInFlight(threadId)) return;
  const worktreePath = pendingMoves.get(threadId) ?? null;
  const thread = deps.getThread(threadId);
  const project = thread ? deps.getProject(thread.project_id) : null;
  if (!thread || !project) {
    pendingMoves.delete(threadId);
    return;
  }
  await applyMove(threadId, worktreePath, worktreePath ?? project.path);
}

export function hasPendingMove(threadId: string): boolean {
  return pendingMoves.has(threadId);
}
