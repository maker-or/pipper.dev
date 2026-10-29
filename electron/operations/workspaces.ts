import { basename } from "node:path";
import { z } from "zod";
import type { Project } from "../../contracts/projects.ts";
import type { OpenTabsState, Thread } from "../../contracts/threads.ts";
import type { Worktree } from "../../contracts/worktrees.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import type { CreatedWorkspace, CreateWorkspaceRequest } from "../workspace-lifecycle.ts";
import { pathKey, samePath } from "../worktree-manager.ts";
import { defineOperation, OperationInputError, type Confirmation } from "./define.ts";
import type { ProvenanceStore } from "./provenance.ts";

/**
 * Workspace operations: list, create and delete a project's worktrees. The
 * IPC handlers (`worktrees:list`, `worktrees:create`, `worktrees:delete`) and
 * the agent tools (`list_workspaces`, `create_workspace`, `delete_workspace`)
 * both run these.
 */

export interface WorkspaceDeps {
  listProjects(): Project[];
  getProject(id: string): Project | null;
  listWorktrees(projectPath: string): Promise<Worktree[]>;
  createWorkspace(request: CreateWorkspaceRequest): Promise<CreatedWorkspace>;
  cancelWorkspaceSetup(worktreePath: string): Promise<void>;
  removeWorktree(projectPath: string, worktreePath: string, projectId: string): Promise<Worktree>;
  gitStatus(worktreePath: string): Promise<WorkspaceGitStatus>;
  listThreads(): Thread[];
  threadTitle(threadId: string): string | null;
  deleteThread(threadId: string): Promise<void>;
  activeThreadId(): string | null;
  switchThread(threadId: string): Promise<void>;
  clearActiveThread(): Promise<void>;
  removeThreadTabs(threadIds: string[]): Promise<OpenTabsState>;
  readOpenTabsState(): Promise<OpenTabsState>;
  broadcastTabs(state: OpenTabsState): void;
  broadcastDeleted(event: { projectId: string; path: string }): void;
  /** A project's workspace list changed; every window refetches it. */
  broadcastChanged(event: { projectId: string }): void;
  /** The persisted selected workspace path per project id. */
  readWorkspaceSelections(): Promise<Record<string, string>>;
  updateWorkspaceSelection(projectId: string, path: string): Promise<void>;
  provenance: ProvenanceStore;
}

let deps: WorkspaceDeps | null = null;

/** Wire the operations to the app (main process) or to fakes (tests). */
export function configureWorkspaceOperations(next: WorkspaceDeps | null): void {
  deps = next;
}

function requireDeps(): WorkspaceDeps {
  if (!deps) throw new Error("Workspace operations are not configured");
  return deps;
}

/** A project by id, or by its path (agents may name either). */
export function resolveProject(idOrPath: string): Project {
  const d = requireDeps();
  const project =
    d.getProject(idOrPath) ?? d.listProjects().find((p) => samePath(p.path, idOrPath)) ?? null;
  if (!project) throw new OperationInputError(`Project not found: ${idOrPath}`);
  return project;
}

/** A live, non-root workspace of the project. */
async function deletableWorkspace(project: Project, path: string): Promise<Worktree> {
  const target = (await requireDeps().listWorktrees(project.path)).find(
    (worktree) => !worktree.isProjectRoot && samePath(worktree.path, path),
  );
  if (!target) {
    throw new OperationInputError(
      "Workspace is no longer available, or it is the project's root, which can't be deleted.",
    );
  }
  return target;
}

function threadsIn(project: Project, workspacePath: string): Thread[] {
  return requireDeps()
    .listThreads()
    .filter(
      (thread) =>
        thread.project_id === project.id &&
        thread.worktree_path != null &&
        samePath(thread.worktree_path, workspacePath),
    );
}

const projectRef = z
  .string()
  .min(1)
  .describe("Project id or absolute path. Defaults to the calling thread's project.");

export const listWorkspaces = defineOperation({
  id: "workspaces.list",
  tier: "read",
  input: z.object({ project: projectRef }),
  async run({ project }) {
    // Includes the project root so callers see its real branch alongside the
    // linked worktrees.
    return requireDeps().listWorktrees(resolveProject(project).path);
  },
});

export const createWorkspace = defineOperation({
  id: "workspaces.create",
  tier: "local",
  input: z.object({
    project: projectRef,
    name: z.string().trim().min(1),
    setup: z.enum(["prepared", "source-only"]).optional(),
    activation: z.enum(["foreground", "background"]),
  }),
  async run(input, ctx) {
    const d = requireDeps();
    const project = resolveProject(input.project);
    const created = await d.createWorkspace({
      projectId: project.id,
      name: input.name,
      setup: input.setup,
      activation: input.activation,
    });
    const key = pathKey(created.worktree.path);
    if (ctx.caller.kind === "agent") {
      d.provenance.record("workspace", key, ctx.caller.threadId);
    }
    d.broadcastChanged({ projectId: project.id });
    return {
      ...created,
      rollback: async () => {
        await created.rollback();
        d.provenance.forget("workspace", key);
        d.broadcastChanged({ projectId: project.id });
      },
    };
  },
});

export const deleteWorkspace = defineOperation({
  id: "workspaces.delete",
  tier: "destructive",
  input: z.object({
    project: projectRef,
    path: z.string().min(1).describe("The workspace path, from list_workspaces."),
  }),

  async forbid(input, ctx) {
    const project = resolveProject(input.project);
    const target = await deletableWorkspace(project, input.path);
    const mine = new Set(ctx.lineage);
    const own = threadsIn(project, target.path).find((thread) => mine.has(thread.id));
    if (!own) return null;
    return own.id === ctx.caller.threadId
      ? "You can't delete the workspace your own thread runs in."
      : "You can't delete the workspace a thread that started you runs in.";
  },

  async owned(input, ctx) {
    const d = requireDeps();
    const project = resolveProject(input.project);
    const target = await deletableWorkspace(project, input.path);
    const creator = d.provenance.createdBy("workspace", pathKey(target.path));
    if (!ctx.owns(creator)) return false;
    return threadsIn(project, target.path).every((thread) => ctx.owns(thread.id));
  },

  async describe(input, ctx) {
    const project = resolveProject(input.project);
    const target = await deletableWorkspace(project, input.path);
    return workspaceImpact(project, target, (id) => ctx.owns(id));
  },

  async run(input) {
    const d = requireDeps();
    const project = resolveProject(input.project);
    const target = await deletableWorkspace(project, input.path);
    const key = pathKey(target.path);
    const threads = threadsIn(project, target.path);
    const deletedThreadIds = new Set(threads.map((thread) => thread.id));
    const cleanupErrors: unknown[] = [];

    // Stop a queued or running dependency install so it cannot keep writing
    // into (or later recreate files in) the workspace being removed.
    await d.cancelWorkspaceSetup(target.path);
    // Remove the Git worktree first. If Git refuses because of a lock,
    // permissions, or a concurrent change, no chats have been deleted yet.
    const removed = await d.removeWorktree(project.path, target.path, project.id);
    d.provenance.forget("workspace", key);
    // Terminals are owned by renderer workspace buckets. Notify it as soon
    // as Git removes the worktree, even if later chat cleanup fails.
    d.broadcastDeleted({ projectId: project.id, path: target.path });
    d.broadcastChanged({ projectId: project.id });

    // Run every cleanup operation even if one fails. Git has already removed
    // the workspace, so leaving the remaining tabs or threads untouched would
    // strand them against a path that no longer exists.
    //
    // One persisted write drops every deleted tab: a per-thread close could
    // fail midway and leave a stale ID in launch state that resurfaces after
    // restart, bound to a worktree that no longer exists.
    let tabs: OpenTabsState | null = null;
    try {
      tabs = await d.removeThreadTabs([...deletedThreadIds]);
    } catch (error) {
      console.error("[workspaces] Failed to persist tab cleanup after worktree removal:", error);
      cleanupErrors.push(error);
    }

    const threadResults = await Promise.allSettled(
      threads.map((thread) => d.deleteThread(thread.id)),
    );
    threadResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const threadId = threads[index]?.id ?? "unknown";
        console.error(
          `[workspaces] Failed to delete thread ${threadId} after worktree removal:`,
          result.reason,
        );
        cleanupErrors.push(result.reason);
      }
    });

    try {
      // Move the selection only when it named the deleted workspace. An agent
      // deleting some other workspace must leave the user where they are, or
      // the sidebar loses the workspace their open thread runs in.
      const selected = (await d.readWorkspaceSelections())[project.id];
      if (selected !== undefined && samePath(selected, target.path)) {
        // Follow the thread that stays open when it works in this project;
        // otherwise the project's root checkout. The root's path comes from
        // the live worktree list (the same value a root switch persists), not
        // `project.path`: for a project registered at a repository
        // subdirectory the two can differ, and the selection must name a real
        // workspace.
        const survivorId = [tabs?.activeThreadId, d.activeThreadId()].find(
          (id): id is string => Boolean(id) && !deletedThreadIds.has(id!),
        );
        const survivor = survivorId
          ? d.listThreads().find((thread) => thread.id === survivorId)
          : undefined;
        const rootWorktree = (await d.listWorktrees(project.path)).find(
          (worktree) => worktree.isProjectRoot,
        );
        const next =
          survivor?.project_id === project.id && survivor.worktree_path
            ? survivor.worktree_path
            : (rootWorktree?.path ?? project.path);
        await d.updateWorkspaceSelection(project.id, next);
      }
    } catch (error) {
      console.error(
        `[workspaces] Failed to reconcile workspace selection after deleting ${target.path}:`,
        error,
      );
      cleanupErrors.push(error);
    }

    // When the persisted tab write failed, stale IDs may remain on disk. Still
    // never broadcast them back to the renderer or reactivate a thread whose
    // workspace has just been removed — reconcile the in-memory view instead.
    let reconciledTabs: OpenTabsState | null = tabs;
    if (!reconciledTabs) {
      try {
        const persisted = await d.readOpenTabsState();
        const openThreadIds = persisted.openThreadIds.filter((id) => !deletedThreadIds.has(id));
        reconciledTabs = {
          openThreadIds,
          activeThreadId:
            persisted.activeThreadId && !deletedThreadIds.has(persisted.activeThreadId)
              ? persisted.activeThreadId
              : (openThreadIds[0] ?? null),
          threadSwitchHistory: persisted.threadSwitchHistory.filter(
            (id) => !deletedThreadIds.has(id),
          ),
        };
      } catch (error) {
        console.error("[workspaces] Failed to read tabs after worktree cleanup:", error);
        cleanupErrors.push(error);
      }
    }

    try {
      const activeThreadId = reconciledTabs?.activeThreadId ?? d.activeThreadId();
      if (activeThreadId && !deletedThreadIds.has(activeThreadId)) {
        if (d.activeThreadId() !== activeThreadId) {
          await d.switchThread(activeThreadId);
        }
      } else {
        await d.clearActiveThread();
      }
    } catch (error) {
      console.error(
        "[workspaces] Failed to reconcile active thread after worktree cleanup:",
        error,
      );
      cleanupErrors.push(error);
    }

    if (reconciledTabs) d.broadcastTabs(reconciledTabs);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Workspace removed, but some chat cleanup failed");
    }
    return removed;
  },
});

const MAX_TITLES = 4;

/**
 * What deleting a workspace loses, measured now: its threads (naming the
 * caller's own separately from everyone else's), uncommitted files and
 * unpublished commits. A check that fails says so instead of disappearing.
 */
export async function workspaceImpact(
  project: Project,
  target: Worktree,
  owns: (threadId: string) => boolean,
): Promise<Confirmation> {
  const d = requireDeps();
  const name = target.workspaceName ?? target.branch ?? basename(target.path);
  const threads = threadsIn(project, target.path);
  const others = threads.filter((thread) => !owns(thread.id));
  const impact: string[] = [];
  if (threads.length > 0) {
    const titles = others
      .slice(0, MAX_TITLES)
      .map((thread) => `“${d.threadTitle(thread.id) ?? "Untitled"}”`);
    const more = others.length > MAX_TITLES ? `, and ${others.length - MAX_TITLES} more` : "";
    impact.push(
      others.length > 0
        ? `${plural(threads.length, "thread")}, including ${titles.join(", ")}${more}`
        : plural(threads.length, "thread"),
    );
  }
  let changedFiles = 0;
  let unpushed = 0;
  try {
    const status = await d.gitStatus(target.path);
    changedFiles = status.staged + status.unstaged + status.untracked;
    unpushed = status.ahead;
    if (changedFiles > 0) impact.push(`uncommitted changes in ${plural(changedFiles, "file")}`);
    if (unpushed > 0) {
      impact.push(
        `${plural(unpushed, "commit")} not pushed${status.branch ? ` on ${status.branch}` : ""}`,
      );
    }
  } catch {
    impact.push("couldn't check for uncommitted changes or unpushed commits");
  }
  return {
    title: `Delete workspace ${name}`,
    verb: "delete",
    impact,
    measures: { threads: threads.length, changedFiles, unpushed },
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Hand a workspace an agent created to the user, as when an agent starts a
 * thread for the user in it: from then on deleting it needs confirming.
 */
export function releaseWorkspaceToUser(worktreePath: string): void {
  requireDeps().provenance.forget("workspace", pathKey(worktreePath));
}
