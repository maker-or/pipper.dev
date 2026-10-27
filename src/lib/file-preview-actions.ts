import { useEffect } from "react";
import type { FilePreviewTarget } from "../../contracts/file-preview.ts";
import type { Project } from "../../contracts/projects.ts";
import { useProjectStore } from "@/store/project-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { previewWorkspaceKey, usePreviewStore, type FileComment } from "@/store/preview-store";
import { sendWorkspaceAgentPrompt } from "@/lib/workspace-agent-prompt";
import { encodeContextString } from "@/lib/git-skills";

/**
 * Tell the preview store which workspace this shell is showing: the same
 * project and checkout its file tree lists (projectId null when it shows
 * none). `enabled` is false for a shell that is not the one on screen: it must
 * not write at all, because React runs a parent's effects after its child's
 * and a hidden parent shell would overwrite the visible child shell's value.
 */
export function useShowPreviewWorkspace(
  enabled: boolean,
  projectId: string | null,
  worktreePath: string | null,
): void {
  const key = projectId ? previewWorkspaceKey(projectId, worktreePath) : null;
  useEffect(() => {
    if (enabled) usePreviewStore.getState().setShownWorkspace(key);
  }, [enabled, key]);
}

/** Key of the workspace whose preview tab the tab bar and panel show. */
export function useShownPreviewWorkspaceKey(): string | null {
  return usePreviewStore((state) => state.shownWorkspaceKey);
}

/** Show a file in its workspace's preview tab and bring the tab to the front. */
export function openFilePreview(target: FilePreviewTarget): void {
  usePreviewStore.getState().openFile(target);
  useWorkspaceViewStore.getState().showPreview();
}

/** The lines a comment covers, joined with newlines; "" for a whole-file comment. */
export function quoteLines(text: string, startLine: number, endLine: number): string {
  if (startLine <= 0) return "";
  return text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n");
}

/** True when the commented lines no longer read as they did when the comment was written. */
export function isCommentOutdated(comment: FileComment, text: string | null): boolean {
  if (comment.startLine <= 0 || text == null) return false;
  return quoteLines(text, comment.startLine, comment.endLine) !== comment.quote;
}

function quoteBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The prompt the agent receives for review comments on files. Code and the
 * user's notes are quoted line by line, so file contents can never end a
 * block early and pose as instructions.
 */
export function buildFileCommentsPrompt(comments: readonly FileComment[]): string {
  const task =
    comments.length === 1
      ? "Address this comment I left while reviewing a file in this workspace."
      : `Address these ${comments.length} comments I left while reviewing files in this workspace.`;
  const blocks = comments.map((comment, index) => {
    const where =
      comment.startLine <= 0
        ? "the whole file"
        : comment.startLine === comment.endLine
          ? `line ${comment.startLine}`
          : `lines ${comment.startLine}-${comment.endLine}`;
    const parts = [`${index + 1}. File ${encodeContextString(comment.path)}, ${where}`];
    if (comment.quote) parts.push("Code:", quoteBlock(comment.quote));
    parts.push("Comment:", quoteBlock(comment.body));
    return parts.join("\n");
  });
  return [
    task,
    "Paths are relative to the workspace root. Line numbers are from when each comment was written.",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ]
    .join("\n")
    .trimEnd();
}

async function findProject(projectId: string): Promise<Project | null> {
  const active = useProjectStore.getState().activeProject;
  if (active?.id === projectId) return active;
  const projects = await window.omni.projects.list();
  return projects.find((project) => project.id === projectId) ?? null;
}

/**
 * Send comments to the agent in their workspace's own thread (or a new one
 * there), queued as a follow-up when the agent is busy.
 *
 * Only comments still unsent are sent, and they are marked sent before the
 * prompt goes out, so a second click (or "Send now" on a comment a batch is
 * already sending) never sends anything twice. If the prompt can't be
 * dispatched, or the agent's turn fails before it took the comments (it can't
 * start, it needs sign-in), they go back to unsent and `onUndelivered` hears
 * about a turn failure; a dispatch failure is thrown.
 */
export async function sendFileComments(
  workspace: { projectId: string; worktreePath: string | null },
  comments: readonly FileComment[],
  options: { onUndelivered?: (error: unknown) => void } = {},
): Promise<void> {
  const key = previewWorkspaceKey(workspace.projectId, workspace.worktreePath);
  const store = usePreviewStore.getState();
  const saved = store.workspaces[key]?.comments ?? {};
  const pending = comments.filter((comment) =>
    saved[comment.path]?.some((item) => item.id === comment.id && item.status === "draft"),
  );
  if (pending.length === 0) return;
  const ids = pending.map((comment) => comment.id);
  store.setCommentStatus(key, ids, "sent");
  const restore = () => usePreviewStore.getState().setCommentStatus(key, ids, "draft");
  try {
    const project = await findProject(workspace.projectId);
    if (!project) throw new Error("The project for these comments is no longer open.");
    const { turn } = await sendWorkspaceAgentPrompt({
      project,
      worktreePath: workspace.worktreePath,
      message: buildFileCommentsPrompt(pending),
      title: "File review comments",
    });
    turn.catch((error: unknown) => {
      restore();
      options.onUndelivered?.(error);
    });
  } catch (error) {
    restore();
    throw error;
  }
}
