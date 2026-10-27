import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { File, Virtualizer, WorkerPoolContextProvider } from "@pierre/diffs/react";
import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { FilePreviewInfo } from "../../../contracts/file-preview.ts";
import { useTheme } from "@/lib/theme";
import { workerFactory } from "@/lib/diff-worker";
import { CODE_HIGHLIGHTER_OPTIONS, CODE_THEMES } from "@/lib/code-highlighting";
import { isCommentOutdated, quoteLines } from "@/lib/file-preview-actions";
import { usePreviewStore, type FileComment } from "@/store/preview-store";
import { CommentCard, CommentComposer, lineRangeLabel } from "./file-comment";

type CodeAnnotation =
  | { kind: "composer"; startLine: number; endLine: number }
  | { kind: "comment"; comment: FileComment };

const EMPTY_COMMENTS: FileComment[] = [];

// Same surface pinning as the diff view: the library's theme layer would
// otherwise paint its own background over ours.
const CODE_UNSAFE_CSS = `
  :host {
    --diffs-bg: var(--surface-1) !important;
    --diffs-bg-buffer: var(--surface-1) !important;
    --diffs-bg-context: var(--surface-1) !important;
    --diffs-bg-context-gutter: var(--surface-1) !important;
    --diffs-fg: var(--foreground) !important;
  }
`;

function orderedRange(range: SelectedLineRange): { startLine: number; endLine: number } {
  return { startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) };
}

/**
 * Read-only code with line comments. Hover a line number and press + (drag
 * to cover several lines) to comment; comments show under their last line.
 */
export function CodeFileView({
  info,
  workspaceKey,
  onSendNow,
}: {
  info: FilePreviewInfo;
  workspaceKey: string;
  onSendNow: (comment: FileComment) => void;
}) {
  const { resolvedTheme } = useTheme();
  const text = info.text ?? "";
  const comments =
    usePreviewStore((state) => state.workspaces[workspaceKey]?.comments[info.path]) ??
    EMPTY_COMMENTS;
  const addComment = usePreviewStore((state) => state.addComment);
  const updateComment = usePreviewStore((state) => state.updateComment);
  const deleteComment = usePreviewStore((state) => state.deleteComment);
  const [composer, setComposer] = useState<{ startLine: number; endLine: number } | null>(null);

  const file = useMemo(
    () => ({ name: info.name, contents: text, cacheKey: `${info.path}:${info.mtimeMs}` }),
    [info.name, info.path, info.mtimeMs, text],
  );

  const lineCount = useMemo(() => text.split("\n").length, [text]);
  const lineAnnotations = useMemo<LineAnnotation<CodeAnnotation>[]>(
    () => [
      ...comments
        .filter((comment) => comment.startLine > 0)
        .map((comment) => ({
          // The file may have shrunk since the comment was written (the
          // agent edited it); keep the comment on a line that still exists.
          // It reads as outdated because its quoted lines no longer match.
          lineNumber: Math.min(comment.endLine, lineCount),
          metadata: { kind: "comment" as const, comment },
        })),
      ...(composer
        ? [{ lineNumber: composer.endLine, metadata: { kind: "composer" as const, ...composer } }]
        : []),
    ],
    [comments, composer, lineCount],
  );

  const options = useMemo(
    () => ({
      theme: CODE_THEMES,
      themeType: resolvedTheme,
      overflow: "scroll" as const,
      disableFileHeader: true,
      unsafeCSS: CODE_UNSAFE_CSS,
      enableLineSelection: true,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: SelectedLineRange) => setComposer(orderedRange(range)),
    }),
    [resolvedTheme],
  );

  const renderAnnotation = (annotation: LineAnnotation<CodeAnnotation>): ReactNode => {
    const meta = annotation.metadata;
    if (meta.kind === "composer") {
      return (
        <CommentComposer
          label={lineRangeLabel(meta.startLine, meta.endLine)}
          onCancel={() => setComposer(null)}
          onSubmit={(body) => {
            addComment(workspaceKey, {
              path: info.path,
              startLine: meta.startLine,
              endLine: meta.endLine,
              quote: quoteLines(text, meta.startLine, meta.endLine),
              body,
            });
            setComposer(null);
          }}
        />
      );
    }
    const { comment } = meta;
    return (
      <CommentCard
        comment={comment}
        outdated={isCommentOutdated(comment, text)}
        onUpdate={(body) => updateComment(workspaceKey, info.path, comment.id, body)}
        onDelete={() => deleteComment(workspaceKey, info.path, comment.id)}
        onSendNow={() => onSendNow(comment)}
      />
    );
  };

  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory }}
      highlighterOptions={CODE_HIGHLIGHTER_OPTIONS}
    >
      <Virtualizer
        className="h-full w-full overflow-auto"
        style={{ "--diffs-font-family": "var(--font-mono)" } as CSSProperties}
      >
        <File
          file={file}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          selectedLines={
            composer ? { start: composer.startLine, end: composer.endLine } : undefined
          }
        />
      </Virtualizer>
    </WorkerPoolContextProvider>
  );
}
