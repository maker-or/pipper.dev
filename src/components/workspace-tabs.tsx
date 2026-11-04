import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DotsThreeVertical } from "@phosphor-icons/react";
import { parseDiffFromFile } from "@pierre/diffs";
import type { Project } from "../../contracts/projects.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { Dropdown } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { openFilePreview } from "@/lib/file-preview-actions";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/store/agent-store";
import { useDiffStore } from "@/store/diff-store";

// Loaded when the Files tab first opens, keeping the tree out of the panel's chunk.
const ProjectFileTree = lazy(() =>
  import("@/components/project-file-tree").then((m) => ({ default: m.ProjectFileTree })),
);

export type WorkspacePanelTab = "check" | "changes" | "files";

/** Where the Changes tab reads its file list from. */
export type ChangesSource = "turn" | "git";

export interface FileChange {
  path: string;
  /** null when the line count is unknown (e.g. a binary file). */
  additions: number | null;
  deletions: number | null;
}

const TAB_LABEL: Record<WorkspacePanelTab, string> = {
  check: "Check",
  changes: "Changes",
  files: "Files",
};

/** Split a path into its directory prefix and file name for display. */
function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index === -1) return { dir: "", name: path };
  return { dir: path.slice(0, index), name: path.slice(index + 1) };
}

/** Check / Changes / Files, as the workspace header shows them. */
export function WorkspaceTabBar({
  tab,
  onTabChange,
  trailing,
  className,
}: {
  tab: WorkspacePanelTab;
  onTabChange: (tab: WorkspacePanelTab) => void;
  /** Controls for the open tab, at the row's end. */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("flex items-center gap-4 text-[13px] font-medium leading-5", className)}
    >
      {(["check", "changes", "files"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          onClick={() => onTabChange(value)}
          className={cn(
            "transition-colors",
            tab === value
              ? "font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {TAB_LABEL[value]}
        </button>
      ))}
      {trailing ? <div className="relative ml-auto">{trailing}</div> : null}
    </div>
  );
}

/**
 * The files a workspace changed, from local git or from the agent thread's
 * edits. The agent's edits only count while the displayed thread runs in this
 * very workspace, so a switch never lists another workspace's files.
 */
export function useWorkspaceChanges(
  project: Project | null,
  worktreePath: string | null,
  status: WorkspaceGitStatus | null,
  source: ChangesSource,
): { changes: FileChange[]; turnCount: number } {
  const diffFiles = useDiffStore((state) => state.files);
  const diffOrder = useDiffStore((state) => state.order);
  const diffThreadId = useDiffStore((state) => state.threadId);
  const agentThreadId = useAgentStore((state) => state.state?.threadId ?? null);
  const agentProjectId = useAgentStore((state) => state.state?.projectId ?? null);
  const agentCwd = useAgentStore((state) => state.state?.cwd ?? null);

  // Agent changes come from the diff store's active-thread projection. That
  // projection is swapped after paint (DiffIngestor effect) and the active
  // thread itself follows a workspace switch asynchronously — only trust it
  // when the projection is for the active thread AND that thread runs in this
  // workspace; otherwise a switch would briefly show (and let the user open)
  // the previous workspace's files under the new workspace's header.
  const turnDiffReady =
    diffThreadId !== null &&
    diffThreadId === agentThreadId &&
    agentProjectId === (project?.id ?? null) &&
    normalizeWorkspacePath(agentCwd, project?.path ?? null) ===
      normalizeWorkspacePath(worktreePath, project?.path ?? null);
  // Key the recount on each file's content version so streaming edits don't
  // re-parse unchanged files on every render.
  const turnSignature = diffOrder
    .map((path) => `${path}:${diffFiles[path]?.updatedAt ?? 0}`)
    .join("|");
  const turnChanges = useMemo<FileChange[]>(() => {
    return diffOrder.map((path) => {
      const entry = diffFiles[path];
      if (!entry) return { path, additions: null, deletions: null };
      try {
        const parsed = parseDiffFromFile(
          { name: path, contents: entry.oldText },
          { name: path, contents: entry.newText },
        );
        return {
          path,
          additions: parsed.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
          deletions: parsed.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
        };
      } catch {
        return { path, additions: null, deletions: null };
      }
    });
    // turnSignature encodes diffOrder + per-file updatedAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnSignature]);

  const changes: FileChange[] =
    source === "turn"
      ? turnDiffReady
        ? turnChanges
        : []
      : (status?.files ?? []).map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        }));
  return { changes, turnCount: turnDiffReady ? turnChanges.length : 0 };
}

/** The ⋮ menu that picks agent or uncommitted changes. */
export function ChangesSourceMenu({
  source,
  onSourceChange,
  turnCount,
  gitCount,
}: {
  source: ChangesSource;
  onSourceChange: (source: ChangesSource) => void;
  turnCount: number;
  gitCount: number;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const pick = (next: ChangesSource) => {
    onSourceChange(next);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Choose which changes to show"
        aria-haspopup="menu"
        aria-expanded={open}
        title={source === "turn" ? "Showing agent changes" : "Showing uncommitted changes"}
        data-pipper-id="changes-source-menu-toggle"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "grid size-7 place-items-center rounded-md outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring",
          open
            ? "bg-active text-foreground"
            : "text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <DotsThreeVertical size={16} weight="bold" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-[200] mt-2 text-left"
          data-pipper-id="changes-source-menu"
        >
          <Dropdown
            checkedIndex={source === "turn" ? 0 : 1}
            className="w-64"
            aria-label="Changes source"
          >
            <MenuItem
              index={0}
              label="Agent changes"
              description="Files edited across this agent thread"
              secondaryLabel={`${turnCount} files`}
              checked={source === "turn"}
              onSelect={() => pick("turn")}
            />
            <MenuItem
              index={1}
              label="Uncommitted changes"
              description="Current changes reported by local git"
              secondaryLabel={`${gitCount} files`}
              checked={source === "git"}
              onSelect={() => pick("git")}
            />
          </Dropdown>
        </div>
      ) : null}
    </>
  );
}

/**
 * The Changes tab's file list with its totals. Agent changes open in the diff
 * view; uncommitted ones open as a file preview.
 */
export function WorkspaceChangesList({
  project,
  worktreePath,
  status,
  source,
  changes,
}: {
  project: Project;
  worktreePath: string;
  status: WorkspaceGitStatus;
  source: ChangesSource;
  changes: FileChange[];
}) {
  const openDiff = useDiffStore((state) => state.open);
  const setDiffActivePath = useDiffStore((state) => state.setActivePath);
  const totalAdditions = changes.reduce((total, file) => total + (file.additions ?? 0), 0);
  const totalDeletions = changes.reduce((total, file) => total + (file.deletions ?? 0), 0);
  // Hide the aggregate when no file reports line counts (all binary/unknown).
  const hasLineStats = changes.some((file) => file.additions !== null || file.deletions !== null);

  const openFile = (path: string) => {
    if (source === "turn") {
      setDiffActivePath(path);
      openDiff();
      return;
    }
    openFilePreview({
      projectId: project.id,
      worktreePath: normalizeWorkspacePath(worktreePath, project.path),
      path,
    });
  };

  return (
    <>
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-semibold text-foreground">
          {changes.length} {changes.length === 1 ? "file" : "files"} changed
        </span>
        {hasLineStats ? (
          <span className="flex items-center gap-1.5 tabular-nums">
            <span className="text-emerald-500">+{totalAdditions}</span>
            <span className="text-red-400">-{totalDeletions}</span>
          </span>
        ) : null}
      </div>

      {changes.length === 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground">
          {source === "turn" ? "No changes from this session yet." : "Working tree is clean."}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {changes.map((file) => {
            const { dir, name } = splitPath(file.path);
            return (
              <li key={file.path}>
                <button
                  type="button"
                  title={file.path}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition-colors duration-80 hover:bg-hover"
                  onClick={() => openFile(file.path)}
                >
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="shrink-0 font-medium text-foreground">{name}</span>
                    {dir ? <span className="truncate text-muted-foreground">{dir}</span> : null}
                  </span>
                  {file.additions !== null ? (
                    <span className="shrink-0 tabular-nums text-emerald-500">
                      +{file.additions}
                    </span>
                  ) : null}
                  {file.deletions !== null ? (
                    <span className="shrink-0 tabular-nums text-red-400">-{file.deletions}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {source === "git" && status.truncated ? (
        <p className="text-[10px] text-muted-foreground/70">File list truncated.</p>
      ) : null}
    </>
  );
}

/** The Files tab: the workspace's file tree, which scrolls itself. */
export function WorkspaceFilesTab({
  project,
  worktreePath,
  className,
}: {
  project: Project;
  /** null for the project folder itself. */
  worktreePath: string | null;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1", className)} data-pipper-id="workspace-files">
      <Suspense fallback={null}>
        <ProjectFileTree
          projectId={project.id}
          worktreePath={normalizeWorkspacePath(worktreePath, project.path)}
        />
      </Suspense>
    </div>
  );
}
