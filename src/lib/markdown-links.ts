/**
 * What a markdown link points at. Agents write two kinds: web pages
 * (`https://…`) and files in the workspace they work in (`src/app.ts`,
 * `./a.ts:12`, `/abs/path/a.ts#L12`, `file:///abs/a.ts`). Anything else
 * (`javascript:`, app schemes, bare anchors) is not followed.
 */
export type MarkdownLinkTarget =
  | { kind: "web"; url: string }
  | { kind: "file"; path: string; absolute: boolean; line: number | null }
  | { kind: "none" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `:12`, `:12:4` or `#L12` / `#L12-L20` after a path. */
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;

export function classifyMarkdownHref(href: string | undefined | null): MarkdownLinkTarget {
  const raw = href?.trim();
  if (!raw || raw.startsWith("#")) return { kind: "none" };

  if (/^https?:\/\//i.test(raw)) {
    try {
      return { kind: "web", url: new URL(raw).toString() };
    } catch {
      return { kind: "none" };
    }
  }

  let path = raw;
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return { kind: "none" };
    }
  } else if (SCHEME.test(path)) {
    return { kind: "none" };
  } else {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the raw text: a stray `%` is part of the name.
    }
  }

  const match = LINE_SUFFIX.exec(path);
  const line = match ? Number(match[1] ?? match[2]) : null;
  if (match) path = path.slice(0, match.index);
  path = path.replace(/[?#].*$/, "");
  if (!path) return { kind: "none" };

  const absolute = path.startsWith("/");
  if (!absolute) path = path.replace(/^(\.\/)+/, "");
  if (!path || path.split("/").includes("..")) return { kind: "none" };
  return { kind: "file", path, absolute, line };
}

/**
 * A file link's path relative to the workspace root, with `/` separators, or
 * null when an absolute path lies outside it.
 */
export function workspaceRelativePath(
  target: Extract<MarkdownLinkTarget, { kind: "file" }>,
  workspaceRoot: string,
): string | null {
  if (!target.absolute) return target.path;
  const root = workspaceRoot.replace(/\/+$/, "");
  if (!target.path.startsWith(`${root}/`)) return null;
  return target.path.slice(root.length + 1) || null;
}
