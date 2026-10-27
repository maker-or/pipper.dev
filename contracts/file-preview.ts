/**
 * Read-only file previews. The renderer names a file by its workspace and a
 * path relative to it; main checks the file is inside that workspace and
 * serves its bytes through the `pipper-file://` protocol.
 */

/** A file inside a project workspace. */
export interface FilePreviewTarget {
  projectId: string;
  /** Worktree checkout, or null for the project's root checkout. */
  worktreePath: string | null;
  /** Path relative to the workspace root, with `/` separators. */
  path: string;
}

export type FilePreviewKind = "text" | "image" | "video" | "audio" | "binary";

export interface FilePreviewInfo {
  path: string;
  name: string;
  kind: FilePreviewKind;
  /** MIME type guessed from the extension, when known. */
  mimeType: string | null;
  size: number;
  mtimeMs: number;
  /** `pipper-file://` URL for images, video and audio. */
  url: string;
  /** File contents for text files under the size limit. */
  text: string | null;
  /** True when a text file is over the preview size limit. */
  tooLarge: boolean;
  /** Whether "Open in default app" is allowed for this file type. */
  canOpenExternally: boolean;
}
