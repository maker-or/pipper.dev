import { create } from "zustand";
import type { WorktreeSetupProgress } from "../../contracts/worktrees.ts";

/**
 * What the advanced shell shows about the background setup that follows a
 * worktree create: the project's setup script, or else the automatic
 * dependency install. Finished setups leave no entry; only a running setup
 * and an undismissed failure are worth showing.
 */
export type WorkspaceSetupEntry = {
  projectId: string;
  worktreePath: string;
  workspaceName: string;
  /** `script`: the project's setup script; `install`: the automatic install. */
  source: "script" | "install";
  /** Package manager of the automatic install, when known. */
  manager?: string;
} & ({ status: "running" } | { status: "failed"; message: string });

interface WorkspaceSetupState {
  /** Keyed by worktree path, the identity setup jobs are queued under. */
  entries: Record<string, WorkspaceSetupEntry>;
  apply: (progress: WorktreeSetupProgress) => void;
  /** Hide a failure the user has read. */
  dismiss: (worktreePath: string) => void;
  /** The workspace is gone; nothing about its setup matters any more. */
  forget: (worktreePath: string) => void;
}

const FALLBACK_FAILURE = "Setup did not complete.";

function without(
  entries: Record<string, WorkspaceSetupEntry>,
  worktreePath: string,
): Record<string, WorkspaceSetupEntry> {
  if (!(worktreePath in entries)) return entries;
  const next = { ...entries };
  delete next[worktreePath];
  return next;
}

export const useWorkspaceSetupStore = create<WorkspaceSetupState>((set) => ({
  entries: {},
  apply: (progress) =>
    set((state) => {
      const base = {
        projectId: progress.projectId,
        worktreePath: progress.worktreePath,
        workspaceName: progress.workspaceName,
        // The automatic install reports no source.
        source: progress.source ?? "install",
        manager: progress.manager,
      } as const;
      switch (progress.status) {
        case "installing":
          // Remote/phone workspaces set up in the background; the desktop
          // only hears about them if they fail.
          if (progress.activation === "background") return state;
          return {
            entries: { ...state.entries, [progress.worktreePath]: { ...base, status: "running" } },
          };
        case "failed":
          return {
            entries: {
              ...state.entries,
              [progress.worktreePath]: {
                ...base,
                status: "failed",
                message: progress.message?.trim() || FALLBACK_FAILURE,
              },
            },
          };
        case "installed":
        case "skipped":
          return { entries: without(state.entries, progress.worktreePath) };
        default:
          return state;
      }
    }),
  dismiss: (worktreePath) =>
    set((state) =>
      state.entries[worktreePath]?.status === "failed"
        ? { entries: without(state.entries, worktreePath) }
        : state,
    ),
  forget: (worktreePath) => set((state) => ({ entries: without(state.entries, worktreePath) })),
}));

/**
 * Mirror setup progress and workspace deletions into the store. Returns the
 * unsubscribe; the advanced shell holds it for as long as it is mounted.
 */
export function startWorkspaceSetupWatcher(): () => void {
  const worktrees = window.omni?.worktrees;
  const { apply, forget } = useWorkspaceSetupStore.getState();
  const stopProgress = worktrees?.onSetupProgress?.(apply);
  const stopDeleted = worktrees?.onDeleted?.(({ path }) => forget(path));
  return () => {
    stopProgress?.();
    stopDeleted?.();
  };
}

/** Headline for a failure, naming what failed: the script or the install. */
export function setupFailureTitle(entry: WorkspaceSetupEntry): string {
  if (entry.source === "script") return "Setup script failed";
  return entry.manager ? `${entry.manager} install failed` : "Dependency install failed";
}
