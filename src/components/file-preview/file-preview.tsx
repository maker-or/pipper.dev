import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowSquareOutIcon,
  ChatCircleTextIcon,
  CopyIcon,
  FileIcon,
  FolderOpenIcon,
  PaperPlaneRightIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { FilePreviewInfo, FilePreviewTarget } from "../../../contracts/file-preview.ts";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { Elevated } from "@/lib/elevated";
import { sendFileComments } from "@/lib/file-preview-actions";
import {
  currentPreviewTarget,
  draftComments,
  usePreviewStore,
  type FileComment,
} from "@/store/preview-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { useDiffStore } from "@/store/diff-store";
import { CodeFileView } from "./code-file-view";
import { CommentCard, CommentComposer } from "./file-comment";

const EMPTY_COMMENTS: FileComment[] = [];

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function reportError(title: string, error: unknown) {
  toast({
    icon: <WarningIcon className="size-5 text-red-500" />,
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/**
 * The workspace's preview tab: one file at a time, read-only, with comments
 * the user can send to the agent.
 */
export function FilePreview({ workspaceKey }: { workspaceKey: string }) {
  const preview = usePreviewStore((state) => state.workspaces[workspaceKey]);
  const isActive = useWorkspaceViewStore((state) => state.mode === "preview");
  const target = currentPreviewTarget(preview);
  const [sending, setSending] = useState(false);

  const queryKey = ["file-preview", target?.projectId, target?.worktreePath, target?.path];
  const query = useQuery({
    queryKey,
    queryFn: () => window.omni.files.stat(target as FilePreviewTarget),
    enabled: target !== null,
    retry: false,
  });

  // The preview stays mounted while another tab is shown. Reload the file when
  // it comes back into view, and whenever the agent edits it.
  const queryClient = useQueryClient();
  const agentEditedAt = useDiffStore((state) => {
    if (!target) return 0;
    let latest = 0;
    for (const path of state.order) {
      if (path === target.path || path.endsWith(`/${target.path}`)) {
        latest = Math.max(latest, state.files[path]?.updatedAt ?? 0);
      }
    }
    return latest;
  });
  const queryKeyText = JSON.stringify(queryKey);
  useEffect(() => {
    if (!isActive) return;
    void queryClient.invalidateQueries({ queryKey: JSON.parse(queryKeyText) as unknown[] });
  }, [isActive, agentEditedAt, queryClient, queryKeyText]);

  if (!preview || !target) return null;
  const drafts = draftComments(preview);

  const send = async (comments: readonly FileComment[]) => {
    setSending(true);
    try {
      await sendFileComments(preview, comments, {
        onTurnFailed: (error, markUnsent) =>
          toast({
            icon: <WarningIcon className="size-5 text-red-500" />,
            title: "The agent's turn ended with an error",
            description: `${error instanceof Error ? error.message : String(error)} Your comments stay marked as sent.`,
            action: { label: "Mark unsent", onClick: markUnsent },
          }),
      });
    } catch (error) {
      reportError("Could not send comments", error);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1" data-pipper-id="file-preview">
      <PreviewHeader target={target} info={query.data ?? null} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {query.isPending ? (
          <div className="px-4 py-3 text-[12px] text-muted-foreground">Loading…</div>
        ) : query.isError ? (
          <Notice icon={<WarningIcon size={20} />} title="Can't preview this file">
            {query.error instanceof Error ? query.error.message : String(query.error)}
          </Notice>
        ) : (
          <PreviewBody
            info={query.data}
            target={target}
            workspaceKey={workspaceKey}
            onSendNow={(comment) => void send([comment])}
          />
        )}
      </div>
      {drafts.length > 0 && (
        <div
          className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2"
          data-pipper-id="file-comments-bar"
        >
          <span className="text-[12px] text-muted-foreground">
            {drafts.length} unsent {drafts.length === 1 ? "comment" : "comments"}
          </span>
          <Button
            className="ml-auto"
            variant="primary"
            size="sm"
            leadingIcon={PaperPlaneRightIcon}
            disabled={sending}
            onClick={() => void send(drafts)}
          >
            Send to agent
          </Button>
        </div>
      )}
    </div>
  );
}

function PreviewHeader({
  target,
  info,
}: {
  target: FilePreviewTarget;
  info: FilePreviewInfo | null;
}) {
  const slash = target.path.lastIndexOf("/");
  const directory = slash >= 0 ? target.path.slice(0, slash + 1) : "";
  const name = target.path.slice(slash + 1);
  const run = (title: string, action: () => Promise<void>) => {
    action().catch((error) => reportError(title, error));
  };
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2"
      data-pipper-id="file-preview-header"
    >
      <div className="ml-2 min-w-0 flex-1 truncate font-mono text-[12px]" title={target.path}>
        <span className="text-muted-foreground">{directory}</span>
        <span className="text-foreground">{name}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy path"
        title="Copy path"
        onClick={() =>
          run("Could not copy the path", () => navigator.clipboard.writeText(target.path))
        }
      >
        <CopyIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reveal in file manager"
        title="Reveal in Finder"
        onClick={() => run("Could not reveal the file", () => window.omni.files.reveal(target))}
      >
        <FolderOpenIcon />
      </Button>
      {info?.canOpenExternally && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open in default app"
          title="Open in default app"
          onClick={() =>
            run("Could not open the file", () => window.omni.files.openExternal(target))
          }
        >
          <ArrowSquareOutIcon />
        </Button>
      )}
    </div>
  );
}

/** File-level comments: the only kind for images, video, audio and other files. */
function FileLevelComments({
  info,
  workspaceKey,
  onSendNow,
}: {
  info: FilePreviewInfo;
  workspaceKey: string;
  onSendNow: (comment: FileComment) => void;
}) {
  const comments =
    usePreviewStore((state) => state.workspaces[workspaceKey]?.comments[info.path]) ??
    EMPTY_COMMENTS;
  const addComment = usePreviewStore((state) => state.addComment);
  const updateComment = usePreviewStore((state) => state.updateComment);
  const deleteComment = usePreviewStore((state) => state.deleteComment);
  const [composing, setComposing] = useState(false);
  const fileComments = comments.filter((comment) => comment.startLine <= 0);
  return (
    <div className="shrink-0" data-pipper-id="file-level-comments">
      {fileComments.map((comment) => (
        <CommentCard
          key={comment.id}
          comment={comment}
          outdated={false}
          onUpdate={(body) => updateComment(workspaceKey, info.path, comment.id, body)}
          onDelete={() => deleteComment(workspaceKey, info.path, comment.id)}
          onSendNow={() => onSendNow(comment)}
        />
      ))}
      {composing ? (
        <CommentComposer
          label="Whole file"
          onCancel={() => setComposing(false)}
          onSubmit={(body) => {
            addComment(workspaceKey, {
              path: info.path,
              startLine: 0,
              endLine: 0,
              quote: "",
              body,
            });
            setComposing(false);
          }}
        />
      ) : (
        <div className="px-3 py-1">
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={ChatCircleTextIcon}
            onClick={() => setComposing(true)}
          >
            Comment on file
          </Button>
        </div>
      )}
    </div>
  );
}

function PreviewBody({
  info,
  target,
  workspaceKey,
  onSendNow,
}: {
  info: FilePreviewInfo;
  target: FilePreviewTarget;
  workspaceKey: string;
  onSendNow: (comment: FileComment) => void;
}) {
  const commentsHeader = (
    // Keyed by file: an open comment box or error must not carry over to the next file.
    <FileLevelComments
      key={info.path}
      info={info}
      workspaceKey={workspaceKey}
      onSendNow={onSendNow}
    />
  );
  if (info.kind === "text" && !info.tooLarge) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {commentsHeader}
        <div className="min-h-0 flex-1">
          <CodeFileView
            key={info.path}
            info={info}
            workspaceKey={workspaceKey}
            onSendNow={onSendNow}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {commentsHeader}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {info.kind === "image" ? (
          <ImageView key={info.url} info={info} />
        ) : info.kind === "video" ? (
          <MediaView key={info.url} info={info} target={target} kind="video" />
        ) : info.kind === "audio" ? (
          <MediaView key={info.url} info={info} target={target} kind="audio" />
        ) : (
          <FallbackCard
            info={info}
            target={target}
            reason={
              info.tooLarge
                ? `This file is ${formatBytes(info.size)}, too large to preview.`
                : "Pipper can't preview this type of file."
            }
          />
        )}
      </div>
    </div>
  );
}

function ImageView({ info }: { info: FilePreviewInfo }) {
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <Notice icon={<WarningIcon size={20} />} title="Can't show this image">
        The file may be damaged or in a format Pipper can't display.
      </Notice>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center gap-2">
      <button
        type="button"
        className={
          fit ? "flex min-h-0 flex-1 items-center justify-center cursor-zoom-in" : "cursor-zoom-out"
        }
        title={fit ? "Show actual size" : "Fit to window"}
        onClick={() => setFit((value) => !value)}
      >
        <img
          src={info.url}
          alt={info.name}
          draggable={false}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setFailed(true)}
          className={fit ? "max-h-full max-w-full object-contain" : "max-w-none"}
        />
      </button>
      {size && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {size.width} × {size.height}
        </span>
      )}
    </div>
  );
}

function MediaView({
  info,
  target,
  kind,
}: {
  info: FilePreviewInfo;
  target: FilePreviewTarget;
  kind: "video" | "audio";
}) {
  const [failed, setFailed] = useState(false);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const isActive = useWorkspaceViewStore((state) => state.mode === "preview");
  // The preview stays mounted behind other tabs; it must not keep playing there.
  useEffect(() => {
    if (!isActive) mediaRef.current?.pause();
  }, [isActive]);
  if (failed) {
    return (
      <FallbackCard
        info={info}
        target={target}
        reason={`Pipper can't play this ${kind} format. Open it in your default app instead.`}
      />
    );
  }
  return kind === "video" ? (
    <video
      ref={(element) => {
        mediaRef.current = element;
      }}
      src={info.url}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      className="max-h-full max-w-full rounded-md"
    />
  ) : (
    <audio
      ref={(element) => {
        mediaRef.current = element;
      }}
      src={info.url}
      controls
      preload="metadata"
      onError={() => setFailed(true)}
      className="w-full max-w-[480px]"
    />
  );
}

function FallbackCard({
  info,
  target,
  reason,
}: {
  info: FilePreviewInfo;
  target: FilePreviewTarget;
  reason: string;
}) {
  const run = (title: string, action: () => Promise<void>) => {
    action().catch((error) => reportError(title, error));
  };
  return (
    <Notice icon={<FileIcon size={20} />} title={info.name}>
      <span>{reason}</span>
      <div className="mt-3 flex justify-center gap-2">
        {info.canOpenExternally && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              run("Could not open the file", () => window.omni.files.openExternal(target))
            }
          >
            Open in default app
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => run("Could not reveal the file", () => window.omni.files.reveal(target))}
        >
          Reveal in Finder
        </Button>
      </div>
    </Notice>
  );
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <Elevated
        offset={1}
        className="flex max-w-[420px] flex-col items-center gap-2 rounded-xl border border-border px-6 py-5 text-center"
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="break-all text-[13px] font-medium text-foreground">{title}</span>
        <div className="text-[12px] text-muted-foreground">{children}</div>
      </Elevated>
    </div>
  );
}
