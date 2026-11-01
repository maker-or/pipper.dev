import { useEffect, useState } from "react";
import type { Project } from "../../contracts/projects.ts";
import type { Thread } from "../../contracts/threads.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { useAgentStore } from "@/store/agent-store";
import { useThreadStore } from "@/store/thread-store";

/**
 * Which agents are mid-turn in each workspace, so the sidebar can show work
 * happening in workspaces the user is not currently looking at.
 *
 * Keyed by canonical workspace path (`null` = project root), matching
 * `normalizeWorkspacePath`. Agent ids are deduplicated and ordered by first
 * appearance so the row of logos stays stable while threads come and go.
 */
export function groupRunningAgentsByWorkspace(input: {
  threads: Thread[];
  runningThreadIds: readonly string[];
  projectId: string;
  projectPath: string;
}): Map<string | null, string[]> {
  const running = new Set(input.runningThreadIds);
  const byWorkspace = new Map<string | null, string[]>();
  for (const thread of input.threads) {
    if (!running.has(thread.id)) continue;
    if (thread.project_id !== input.projectId) continue;
    const workspace = normalizeWorkspacePath(thread.worktree_path, input.projectPath);
    const agents = byWorkspace.get(workspace) ?? [];
    if (!agents.includes(thread.agent_id)) agents.push(thread.agent_id);
    byWorkspace.set(workspace, agents);
  }
  return byWorkspace;
}

/** Threads the renderer already holds, from every source that caches them. */
function knownThreads(): Thread[] {
  return useThreadStore.getState().threads;
}

/**
 * Every running thread the renderer can attribute to a project and workspace.
 *
 * A thread can be running in a workspace whose threads were never paged into
 * the renderer, so ids that are not already known are fetched once by id and
 * remembered for the session.
 */
function useRunningThreads(): { threads: Thread[]; runningThreadIds: readonly string[] } {
  const runningThreadIds = useAgentStore((state) => state.runningThreadIds);
  const threads = useThreadStore((state) => state.threads);
  const [resolved, setResolved] = useState<Thread[]>([]);

  useEffect(() => {
    if (runningThreadIds.length === 0) return;
    const known = new Set([...knownThreads(), ...resolved].map((thread) => thread.id));
    const missing = runningThreadIds.filter((id) => !known.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void window.omni.threads
      .listByIds(missing)
      .then((fetched) => {
        if (cancelled || fetched.length === 0) return;
        setResolved((current) => {
          const seen = new Set(current.map((thread) => thread.id));
          const added = fetched.filter((thread) => !seen.has(thread.id));
          return added.length > 0 ? [...current, ...added] : current;
        });
      })
      .catch(() => {
        // A workspace without its badge is a cosmetic loss; never surface this.
      });
    return () => {
      cancelled = true;
    };
  }, [runningThreadIds, resolved]);

  return { threads: [...threads, ...resolved], runningThreadIds };
}

/** Live map of workspace → running agent ids for a project. */
export function useRunningAgentsByWorkspace(project: Project | null): Map<string | null, string[]> {
  const { threads, runningThreadIds } = useRunningThreads();
  if (!project) return new Map();
  return groupRunningAgentsByWorkspace({
    threads,
    runningThreadIds,
    projectId: project.id,
    projectPath: project.path,
  });
}

/** Which agents are mid-turn in each project, across all of its workspaces. */
export function groupRunningAgentsByProject(input: {
  threads: Thread[];
  runningThreadIds: readonly string[];
}): Map<string, string[]> {
  const running = new Set(input.runningThreadIds);
  const byProject = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const thread of input.threads) {
    if (!running.has(thread.id) || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const agents = byProject.get(thread.project_id) ?? [];
    if (!agents.includes(thread.agent_id)) agents.push(thread.agent_id);
    byProject.set(thread.project_id, agents);
  }
  return byProject;
}

/** Live map of project id → running agent ids. */
export function useRunningAgentsByProject(): Map<string, string[]> {
  return groupRunningAgentsByProject(useRunningThreads());
}
