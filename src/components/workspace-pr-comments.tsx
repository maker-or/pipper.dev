import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ClipFade } from "@/components/clip-fade";
import { ArrowUpRight, CaretDown, ChatCircle } from "@phosphor-icons/react";
import type { WorkspacePrComment } from "../../contracts/git.ts";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Elevated } from "@/lib/elevated";
import {
  commentSeverity,
  commentTitle,
  commentToMarkdown,
  type CommentSeverity,
  groupCommentsByAuthor,
  highestSeverity,
  isInlineComment,
  sortComments,
} from "@/lib/pr-comment-text";
import { useContentOverflow } from "@/lib/use-content-overflow";
import { cn } from "@/lib/utils";

type SortOrder = "latest" | "oldest";

const BODY_COLLAPSED_PX = 160;
const SEVERITY_RANK: Record<CommentSeverity, number> = { high: 3, medium: 2, low: 1 };

function Avatar({
  url,
  name,
  size,
  className,
}: {
  url: string | null;
  name: string;
  size: number;
  className?: string;
}) {
  return url ? (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full bg-surface-2 object-cover", className)}
    />
  ) : (
    <span
      style={{ width: size, height: size }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

function SeverityDot({ level }: { level: CommentSeverity }) {
  const tone = level === "high" ? "bg-red-500" : level === "medium" ? "bg-amber-500" : "bg-sky-500";
  return (
    <span
      title={`${level} severity`}
      className={cn("size-1.5 shrink-0 rounded-full", tone)}
      aria-label={`${level} severity`}
    />
  );
}

/**
 * Minimal anchored menu: a trigger plus an `Elevated` popup that closes on
 * outside pointer-down. `items` render inside; each closes the menu itself
 * via the `close` callback.
 */
function PopMenu({
  trigger,
  align = "right",
  width,
  children,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  align?: "left" | "right";
  width: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <Elevated
          offset={2}
          className={cn(
            "absolute top-full z-50 mt-1 rounded-lg border border-border p-1",
            align === "right" ? "right-0" : "left-0",
            width,
          )}
        >
          {children(() => setOpen(false))}
        </Elevated>
      ) : null}
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortOrder; onChange: (v: SortOrder) => void }) {
  return (
    <PopMenu
      width="w-28"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          {value === "latest" ? "Latest" : "Oldest"}
          <CaretDown size={11} />
        </button>
      )}
    >
      {(close) =>
        (["latest", "oldest"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              onChange(option);
              close();
            }}
            className={cn(
              "flex w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-hover",
              option === value ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {option === "latest" ? "Latest" : "Oldest"}
          </button>
        ))
      }
    </PopMenu>
  );
}

function CommentCard({
  comment,
  onAdd,
}: {
  comment: WorkspacePrComment;
  onAdd?: (comment: WorkspacePrComment) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const markdown = useMemo(() => commentToMarkdown(comment.body), [comment.body]);
  const title = useMemo(() => commentTitle(comment), [comment]);
  const severity = useMemo(() => commentSeverity(comment), [comment]);
  const inline = isInlineComment(comment);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Rendered height, not character count, decides whether anything is clipped.
  const clipped = useContentOverflow(bodyRef, [markdown, expanded]);
  return (
    <article className="flex flex-col gap-1.5 py-3">
      <header className="flex items-center gap-2">
        {severity ? (
          <SeverityDot level={severity} />
        ) : (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              inline ? "bg-amber-500/70" : "bg-muted-foreground/30",
            )}
            title={inline ? "Inline review comment" : "Comment"}
          />
        )}
        <h4
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground",
            inline && "font-mono",
          )}
          title={title}
        >
          {title}
        </h4>
        {onAdd ? (
          <button
            type="button"
            onClick={() => onAdd(comment)}
            title="Add this comment to chat"
            className="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
            aria-label="Add to chat"
          >
            <ChatCircle size={14} />
          </button>
        ) : null}
        {comment.url ? (
          <button
            type="button"
            onClick={() => void window.omni.shell.openHttps(comment.url!).catch(() => {})}
            className="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
            aria-label="Open comment on GitHub"
          >
            <ArrowUpRight size={14} />
          </button>
        ) : null}
      </header>
      <div
        ref={bodyRef}
        className="relative overflow-hidden"
        style={expanded ? undefined : { maxHeight: BODY_COLLAPSED_PX }}
      >
        <MarkdownRenderer className="text-[13px] leading-6 text-muted-foreground">
          {markdown}
        </MarkdownRenderer>
        {clipped && !expanded ? <ClipFade /> : null}
      </div>
      {clipped && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          Show more
        </button>
      ) : null}
    </article>
  );
}

export function WorkspacePrComments({
  comments,
  onAddComments,
}: {
  comments: WorkspacePrComment[];
  onAddComments?: (comments: WorkspacePrComment[]) => void;
}) {
  const groups = useMemo(() => groupCommentsByAuthor(comments), [comments]);
  const [order, setOrder] = useState<SortOrder>("latest");

  // Surface the bot with the most severe findings first, then the most recent.
  const orderedGroups = useMemo(() => {
    const rank = (group: (typeof groups)[number]) => {
      const level = highestSeverity(group.comments);
      return level ? SEVERITY_RANK[level] : 0;
    };
    const recency = (group: (typeof groups)[number]) =>
      Math.max(0, ...group.comments.map((comment) => Date.parse(comment.createdAt) || 0));
    return [...groups].sort((a, b) => rank(b) - rank(a) || recency(b) - recency(a));
  }, [groups]);

  if (groups.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
          Review comments
        </h3>
        <SortMenu value={order} onChange={setOrder} />
      </div>

      <Accordion
        type="multiple"
        className="w-full"
        defaultValue={orderedGroups[0] ? [orderedGroups[0].author] : []}
      >
        {orderedGroups.map((group, index) => {
          const severity = highestSeverity(group.comments);
          const inlineCount = group.comments.filter(isInlineComment).length;
          // Findings (inline, with a file) first, then the bot's general notes.
          const ordered = sortComments(group.comments, order).sort(
            (a, b) => Number(isInlineComment(b)) - Number(isInlineComment(a)),
          );
          return (
            <AccordionItem
              key={group.author}
              value={group.author}
              index={index}
              className="border-b border-border/50 last:border-b-0"
            >
              <AccordionTrigger>
                <span className="flex w-full min-w-0 items-center gap-2">
                  <Avatar url={group.avatarUrl} name={group.author} size={18} />
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {group.author}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {group.comments.length}
                  </span>
                  {severity ? <SeverityDot level={severity} /> : null}
                  {inlineCount > 0 ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
                      {inlineCount} inline
                    </span>
                  ) : null}
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="flex flex-col divide-y divide-border/50">
                  {ordered.map((comment) => (
                    <CommentCard
                      key={comment.id}
                      comment={comment}
                      onAdd={onAddComments ? (item) => onAddComments([item]) : undefined}
                    />
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </section>
  );
}
