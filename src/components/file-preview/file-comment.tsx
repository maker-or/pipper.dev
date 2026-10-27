import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Elevated } from "@/lib/elevated";
import type { FileComment } from "@/store/preview-store";

export function lineRangeLabel(startLine: number, endLine: number): string {
  if (startLine <= 0) return "Whole file";
  return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
}

/** Text box for a new or edited comment. ⌘/Ctrl+Enter saves, Escape cancels. */
export function CommentComposer({
  label,
  initialBody = "",
  submitLabel = "Comment",
  onSubmit,
  onCancel,
}: {
  label: string;
  initialBody?: string;
  submitLabel?: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  const canSubmit = body.trim().length > 0;
  return (
    <Elevated
      offset={2}
      className="mx-3 my-2 flex max-w-[640px] flex-col gap-2 rounded-lg border border-border p-2 font-sans"
      data-pipper-id="file-comment-composer"
    >
      <span className="px-1 text-[11px] text-muted-foreground">{label}</span>
      <textarea
        ref={textareaRef}
        value={body}
        rows={3}
        placeholder="Leave a note for the agent…"
        aria-label="Comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSubmit) {
            event.preventDefault();
            onSubmit(body);
          }
        }}
        className="min-h-[64px] w-full resize-y rounded-md bg-transparent px-1 text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!canSubmit} onClick={() => onSubmit(body)}>
          {submitLabel}
        </Button>
      </div>
    </Elevated>
  );
}

/** A saved comment, shown under the lines it belongs to. */
export function CommentCard({
  comment,
  outdated,
  onUpdate,
  onDelete,
  onSendNow,
}: {
  comment: FileComment;
  outdated: boolean;
  onUpdate: (body: string) => void;
  onDelete: () => void;
  onSendNow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = lineRangeLabel(comment.startLine, comment.endLine);
  if (editing) {
    return (
      <CommentComposer
        label={label}
        initialBody={comment.body}
        submitLabel="Save"
        onSubmit={(body) => {
          onUpdate(body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  const sent = comment.status === "sent";
  return (
    <Elevated
      offset={2}
      className="mx-3 my-2 flex max-w-[640px] flex-col gap-1 rounded-lg border border-border px-3 py-2 font-sans"
      data-pipper-id="file-comment"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{label}</span>
        {sent && (
          <span className="flex items-center gap-1">
            <CheckIcon size={12} /> Sent to agent
          </span>
        )}
        {outdated && (
          <span className="flex items-center gap-1" title="These lines changed since you commented">
            <WarningIcon size={12} /> Outdated
          </span>
        )}
        <div className="ml-auto flex items-center">
          {!sent && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Send this comment to the agent now"
                title="Send now"
                onClick={onSendNow}
              >
                <PaperPlaneRightIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Edit comment"
                title="Edit"
                onClick={() => setEditing(true)}
              >
                <PencilSimpleIcon />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete comment"
            title="Delete"
            onClick={onDelete}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground">
        {comment.body}
      </p>
    </Elevated>
  );
}
