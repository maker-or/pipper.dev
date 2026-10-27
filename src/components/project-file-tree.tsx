import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { ProjectFileTreeSnapshot } from "../../contracts/projects.ts";
import { draftComments, previewWorkspaceKey, usePreviewStore } from "@/store/preview-store";
import { openFilePreview } from "@/lib/file-preview-actions";

interface ProjectFileTreeProps {
  projectId: string;
  /** Worktree checkout, or null for the project's root checkout. */
  worktreePath: string | null;
}

const EMPTY_SNAPSHOT: ProjectFileTreeSnapshot = {
  paths: [],
  gitStatus: [],
};

const treeStyles = {
  height: "100%",
  minHeight: 0,
  "--trees-bg-override": "var(--surface-1)",
  "--trees-bg-muted-override": "var(--hover)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-border-color-override": "var(--border)",
  "--trees-selected-bg-override": "var(--active)",
  "--trees-selected-fg-override": "var(--foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": '"Inter Variable", sans-serif',
  "--trees-font-size-override": "12px",
  "--trees-padding-inline-override": "8px",
  "--trees-item-margin-x-override": "0px",
  "--trees-item-padding-x-override": "7px",
  "--trees-border-radius-override": "6px",
} as CSSProperties;

function ProjectFileTreeContent({
  snapshot,
  projectId,
  worktreePath,
}: {
  snapshot: ProjectFileTreeSnapshot;
  projectId: string;
  worktreePath: string | null;
}) {
  // The tree reads its options once; keep the latest values in refs.
  const filesRef = useRef(new Set(snapshot.paths));
  filesRef.current = new Set(snapshot.paths);
  const workspaceRef = useRef({ projectId, worktreePath });
  workspaceRef.current = { projectId, worktreePath };
  const workspaceKey = previewWorkspaceKey(projectId, worktreePath);
  const unsentByPath = usePreviewStore((state) => {
    const counts: Record<string, number> = {};
    for (const comment of draftComments(state.workspaces[workspaceKey])) {
      counts[comment.path] = (counts[comment.path] ?? 0) + 1;
    }
    return JSON.stringify(counts);
  });
  const unsentRef = useRef<Record<string, number>>({});
  unsentRef.current = JSON.parse(unsentByPath) as Record<string, number>;

  const { model } = useFileTree({
    paths: snapshot.paths,
    gitStatus: snapshot.gitStatus,
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: "standard",
    density: "compact",
    search: false,
    dragAndDrop: false,
    renaming: false,
    stickyFolders: true,
    renderRowDecoration: ({ item }) => {
      const count = item.kind === "file" ? unsentRef.current[item.path] : undefined;
      return count
        ? { text: String(count), title: `${count} unsent ${count === 1 ? "comment" : "comments"}` }
        : null;
    },
  });

  // Row decorations are read when rows render; re-applying the same git
  // status redraws them so comment badges follow the counts.
  useEffect(() => {
    model.setGitStatus(snapshot.gitStatus);
  }, [model, snapshot.gitStatus, unsentByPath]);

  // Open on click or Enter, not on selection change: clicking the file that is
  // already selected (after closing the preview) must open it
  // again, and arrowing through the tree must not open every file passed.
  const openFromEvent = (event: Event) => {
    const row = event
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.dataset.itemType !== undefined,
      );
    const path = row?.dataset.itemType === "file" ? row.dataset.itemPath : undefined;
    if (path && filesRef.current.has(path)) openFilePreview({ ...workspaceRef.current, path });
  };

  return (
    <div
      className="h-full min-h-0"
      onClick={(event) => openFromEvent(event.nativeEvent)}
      onKeyDown={(event) => {
        if (event.key === "Enter") openFromEvent(event.nativeEvent);
      }}
    >
      <FileTree model={model} style={treeStyles} aria-label="Project files" />
    </div>
  );
}

/** The workspace's files. Clicking a file shows it in the preview tab. */
export function ProjectFileTree({ projectId, worktreePath }: ProjectFileTreeProps) {
  const [snapshot, setSnapshot] = useState<ProjectFileTreeSnapshot>(EMPTY_SNAPSHOT);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void window.omni.projects
      .getFileTree(projectId, worktreePath)
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot);
      })
      .catch((reason) => {
        if (!cancelled) {
          setSnapshot(EMPTY_SNAPSHOT);
          setError(reason instanceof Error ? reason.message : "Could not load project files.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, worktreePath]);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-1"
      data-pipper-id="project-file-tree"
    >
      <div className="min-h-0 flex-1 bg-surface-1">
        {isLoading ? (
          <div className="px-4 py-3 text-[12px] text-muted-foreground">Loading files…</div>
        ) : error ? (
          <div className="px-4 py-3 text-[12px] text-red-500">{error}</div>
        ) : snapshot.paths.length === 0 ? (
          <div className="px-4 py-3 text-[12px] text-muted-foreground">No project files found.</div>
        ) : (
          <ProjectFileTreeContent
            // A new workspace gets a fresh tree model.
            key={`${projectId}:${worktreePath ?? ""}`}
            snapshot={snapshot}
            projectId={projectId}
            worktreePath={worktreePath}
          />
        )}
      </div>
    </div>
  );
}
