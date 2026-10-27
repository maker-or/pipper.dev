import { randomBytes, createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
  FilePreviewInfo,
  FilePreviewKind,
  FilePreviewTarget,
} from "../contracts/file-preview.ts";

/**
 * Read-only file previews for the renderer.
 *
 * The renderer never sees absolute paths or `file://` URLs. It asks for a
 * file by workspace and relative path; `stat` checks the workspace belongs to
 * the project, resolves symlinks and refuses anything outside the workspace,
 * then hands back a `pipper-file://<token>/<root>/<path>` URL. The protocol
 * handler repeats the same checks on every request, and only serves roots
 * that `stat` registered, so a page that guesses a URL gets nothing.
 */

export const FILE_PREVIEW_SCHEME = "pipper-file";

/** Text above this size is not loaded into the renderer. */
export const TEXT_PREVIEW_LIMIT_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".apng": "image/apng",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};
const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
};
const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};
/**
 * Formats the OS may open with their default app. Everything else (scripts,
 * executables, unknown binaries) can only be revealed in the file manager, so
 * a click in the preview never runs code.
 */
const EXTERNAL_DOCUMENT_TYPES = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".key",
  ".numbers",
  ".pages",
  ".rtf",
  ".psd",
  ".sketch",
  ".fig",
  ".heic",
  ".tif",
  ".tiff",
  ".mkv",
  ".avi",
]);

export class FilePreviewError extends Error {}

export function classifyByExtension(name: string): {
  kind: FilePreviewKind | null;
  mimeType: string | null;
} {
  const ext = extname(name).toLowerCase();
  if (IMAGE_TYPES[ext]) return { kind: "image", mimeType: IMAGE_TYPES[ext] };
  if (VIDEO_TYPES[ext]) return { kind: "video", mimeType: VIDEO_TYPES[ext] };
  if (AUDIO_TYPES[ext]) return { kind: "audio", mimeType: AUDIO_TYPES[ext] };
  return { kind: null, mimeType: null };
}

/** Text unless the first bytes contain NUL, which text formats never do. */
export function looksLikeText(head: Uint8Array): boolean {
  return !head.includes(0);
}

export function canOpenExternally(name: string, kind: FilePreviewKind): boolean {
  if (kind === "image" || kind === "video" || kind === "audio") return true;
  return EXTERNAL_DOCUMENT_TYPES.has(extname(name).toLowerCase());
}

/**
 * Resolve `relativePath` under `realRoot` (already realpath'd) and return the
 * file's real path. Rejects absolute paths, `..`, NUL bytes, symlinks that
 * leave the root, and anything that is not a regular file.
 */
export async function resolveFileInRoot(realRoot: string, relativePath: string): Promise<string> {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath)
  ) {
    throw new FilePreviewError("Invalid file path.");
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new FilePreviewError("Invalid file path.");
  }
  let real: string;
  try {
    real = await realpath(join(realRoot, ...segments));
  } catch {
    throw new FilePreviewError("This file no longer exists. It may have been moved or deleted.");
  }
  if (!isInside(realRoot, real)) throw new FilePreviewError("File is outside the workspace.");
  const info = await stat(real);
  if (!info.isFile()) throw new FilePreviewError("Not a file.");
  return real;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

export interface FilePreviewDeps {
  /** The project's root checkout path, or null when the project is unknown. */
  getProjectPath(projectId: string): string | null;
  /** Every worktree checkout of the project, including the root. */
  listWorktreePaths(projectPath: string): Promise<string[]>;
}

export class FilePreviewService {
  /** Per-process secret host, so URLs can't be guessed by other content. */
  readonly token = randomBytes(16).toString("hex");
  private readonly roots = new Map<string, string>();
  private readonly deps: FilePreviewDeps;

  constructor(deps: FilePreviewDeps) {
    this.deps = deps;
  }

  /** Real path of the workspace root, after checking it belongs to the project. */
  async workspaceRoot(projectId: string, worktreePath: string | null): Promise<string> {
    const projectPath = this.deps.getProjectPath(projectId);
    if (!projectPath) throw new FilePreviewError("Unknown project.");
    const realProject = await realpath(projectPath).catch(() => {
      throw new FilePreviewError("Project folder not found.");
    });
    if (!worktreePath) return realProject;
    const realWorktree = await realpath(worktreePath).catch(() => {
      throw new FilePreviewError("Workspace folder not found.");
    });
    if (realWorktree === realProject) return realProject;
    const known = await this.deps.listWorktreePaths(projectPath);
    for (const candidate of known) {
      if ((await realpath(candidate).catch(() => null)) === realWorktree) return realWorktree;
    }
    throw new FilePreviewError("Workspace does not belong to this project.");
  }

  async stat(target: FilePreviewTarget): Promise<FilePreviewInfo> {
    const root = await this.workspaceRoot(target.projectId, target.worktreePath);
    const real = await resolveFileInRoot(root, target.path);
    const info = await stat(real);
    const name = basename(real);
    const byExtension = classifyByExtension(name);
    let kind: FilePreviewKind = byExtension.kind ?? "binary";
    let text: string | null = null;
    let tooLarge = false;
    if (!byExtension.kind) {
      const head = await readHead(real, Math.min(info.size, SNIFF_BYTES));
      if (looksLikeText(head)) {
        kind = "text";
        if (info.size > TEXT_PREVIEW_LIMIT_BYTES) tooLarge = true;
        else text = new TextDecoder("utf-8").decode(await readHead(real, info.size));
      }
    }
    const rootId = this.registerRoot(root);
    const urlPath = relative(root, real).split(sep).map(encodeURIComponent).join("/");
    return {
      path: target.path,
      name,
      kind,
      mimeType: byExtension.mimeType,
      size: info.size,
      mtimeMs: info.mtimeMs,
      url: `${FILE_PREVIEW_SCHEME}://${this.token}/${rootId}/${urlPath}?v=${Math.round(info.mtimeMs)}`,
      text,
      tooLarge,
      canOpenExternally: canOpenExternally(name, kind),
    };
  }

  /** Real path for "Reveal" / "Open", after the same checks as `stat`. */
  async resolve(target: FilePreviewTarget): Promise<{ real: string; kind: FilePreviewKind }> {
    const root = await this.workspaceRoot(target.projectId, target.worktreePath);
    const real = await resolveFileInRoot(root, target.path);
    return { real, kind: classifyByExtension(real).kind ?? "binary" };
  }

  /**
   * The real path a `pipper-file://` URL points to, or null when it is not a
   * URL this process issued or it points outside its workspace.
   */
  async resolveRequest(requestUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    if (url.protocol !== `${FILE_PREVIEW_SCHEME}:` || url.hostname !== this.token) return null;
    const [rootId, ...rest] = url.pathname.split("/").filter(Boolean);
    const root = rootId ? this.roots.get(rootId) : undefined;
    if (!root || rest.length === 0) return null;
    let relativePath: string;
    try {
      relativePath = rest.map(decodeURIComponent).join("/");
    } catch {
      return null;
    }
    try {
      return await resolveFileInRoot(root, relativePath);
    } catch {
      return null;
    }
  }

  private registerRoot(root: string): string {
    const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
    this.roots.set(id, root);
    return id;
  }
}

async function readHead(path: string, length: number): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array();
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** A single `bytes=` range, or null to serve the whole file. "invalid" can't be satisfied. */
export function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges in one request: serve the whole file instead.
  if (!match) return header.includes(",") ? null : "invalid";
  const [, from, to] = match;
  if (!from && !to) return "invalid";
  let start: number;
  let end: number;
  if (!from) {
    // Suffix range: the last N bytes.
    start = Math.max(0, size - Number(to));
    end = size - 1;
  } else {
    start = Number(from);
    end = to ? Math.min(Number(to), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/**
 * Answer a preview request for a resolved file. Range requests get a 206 with
 * Content-Range, which Chromium needs before it treats video and audio as
 * seekable.
 */
export async function servePreviewFile(
  realPath: string,
  rangeHeader: string | null,
): Promise<Response> {
  const { size } = await stat(realPath);
  const headers = new Headers({
    "Content-Type": classifyByExtension(realPath).mimeType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    // If a file is ever loaded as a document (an SVG or HTML opened in a
    // frame), it renders without scripts or same-origin access.
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "no-cache",
  });
  const range = parseByteRange(rangeHeader, size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  const body =
    size === 0
      ? null
      : (Readable.toWeb(createReadStream(realPath, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}
