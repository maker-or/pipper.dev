import { create } from "zustand";
import type { FilePreviewTarget } from "../../contracts/file-preview.ts";

/**
 * File previews, one per workspace.
 *
 * Each workspace has at most one preview tab, showing one file. Opening a
 * file replaces what the tab shows instead of adding a tab; there is no
 * history. Comments belong to files, not to the tab: switching files or
 * closing the tab keeps unsent comments until they are sent to the agent or
 * deleted.
 */

export interface FileComment {
  id: string;
  path: string;
  /** First and last commented line; both 0 for a comment on the whole file. */
  startLine: number;
  endLine: number;
  /** The commented lines when the comment was written, to spot outdated ones. */
  quote: string;
  body: string;
  status: "draft" | "sent";
  createdAt: number;
}

export interface WorkspacePreview {
  projectId: string;
  worktreePath: string | null;
  /** The file the preview tab shows, or null when the tab is closed. */
  path: string | null;
  comments: Record<string, FileComment[]>;
}

export function previewWorkspaceKey(projectId: string, worktreePath: string | null): string {
  return `${projectId}\u0000${worktreePath ?? ""}`;
}

export function currentPreviewTarget(
  preview: WorkspacePreview | undefined,
): FilePreviewTarget | null {
  return preview?.path
    ? { projectId: preview.projectId, worktreePath: preview.worktreePath, path: preview.path }
    : null;
}

/** Unsent comments across every file in the workspace, in file then line order. */
export function draftComments(preview: WorkspacePreview | undefined): FileComment[] {
  if (!preview) return [];
  return Object.keys(preview.comments)
    .sort()
    .flatMap((path) =>
      preview.comments[path]
        .filter((comment) => comment.status === "draft")
        .sort((a, b) => a.startLine - b.startLine),
    );
}

interface PreviewState {
  workspaces: Record<string, WorkspacePreview>;
  /**
   * The workspace the shell is showing, set by the shell itself (the same
   * workspace its file tree lists). The tab bar and preview panel show this
   * workspace's preview tab, so they never disagree with the tree about it.
   */
  shownWorkspaceKey: string | null;
  setShownWorkspace: (key: string | null) => void;
  /** Show `target` in its workspace's preview tab. Returns the workspace key. */
  openFile: (target: FilePreviewTarget) => string;
  close: (key: string) => void;
  addComment: (
    key: string,
    comment: Pick<FileComment, "path" | "startLine" | "endLine" | "quote" | "body">,
  ) => FileComment | null;
  updateComment: (key: string, path: string, id: string, body: string) => void;
  deleteComment: (key: string, path: string, id: string) => void;
  setCommentStatus: (key: string, ids: readonly string[], status: FileComment["status"]) => void;
}

function emptyPreview(target: FilePreviewTarget): WorkspacePreview {
  return {
    projectId: target.projectId,
    worktreePath: target.worktreePath,
    path: null,
    comments: {},
  };
}

function newCommentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `c_${Date.now()}_${Math.random().toString(36)}`;
}

export const usePreviewStore = create<PreviewState>((set, get) => {
  const update = (key: string, change: (preview: WorkspacePreview) => WorkspacePreview) => {
    const preview = get().workspaces[key];
    if (!preview) return;
    set({ workspaces: { ...get().workspaces, [key]: change(preview) } });
  };

  return {
    workspaces: {},
    shownWorkspaceKey: null,
    setShownWorkspace: (key) => {
      if (get().shownWorkspaceKey !== key) set({ shownWorkspaceKey: key });
    },

    openFile: (target) => {
      const key = previewWorkspaceKey(target.projectId, target.worktreePath);
      const preview = get().workspaces[key] ?? emptyPreview(target);
      if (preview.path !== target.path) {
        set({ workspaces: { ...get().workspaces, [key]: { ...preview, path: target.path } } });
      }
      return key;
    },

    close: (key) => update(key, (preview) => ({ ...preview, path: null })),

    addComment: (key, input) => {
      const body = input.body.trim();
      if (!body || !get().workspaces[key]) return null;
      const comment: FileComment = {
        ...input,
        body,
        id: newCommentId(),
        status: "draft",
        createdAt: Date.now(),
      };
      update(key, (preview) => ({
        ...preview,
        comments: {
          ...preview.comments,
          [input.path]: [...(preview.comments[input.path] ?? []), comment],
        },
      }));
      return comment;
    },

    updateComment: (key, path, id, body) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      update(key, (preview) => ({
        ...preview,
        comments: {
          ...preview.comments,
          [path]: (preview.comments[path] ?? []).map((comment) =>
            comment.id === id ? { ...comment, body: trimmed } : comment,
          ),
        },
      }));
    },

    deleteComment: (key, path, id) =>
      update(key, (preview) => ({
        ...preview,
        comments: {
          ...preview.comments,
          [path]: (preview.comments[path] ?? []).filter((comment) => comment.id !== id),
        },
      })),

    setCommentStatus: (key, ids, status) => {
      const changing = new Set(ids);
      update(key, (preview) => ({
        ...preview,
        comments: Object.fromEntries(
          Object.entries(preview.comments).map(([path, comments]) => [
            path,
            comments.map((comment) =>
              changing.has(comment.id) ? { ...comment, status } : comment,
            ),
          ]),
        ),
      }));
    },
  };
});
