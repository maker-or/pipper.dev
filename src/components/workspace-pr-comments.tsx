import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { WorkspacePrComment } from "../../contracts/git.ts";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Elevated } from "@/lib/elevated";
import { fontWeights } from "@/lib/font-weight";
import {
  type CommentFinding,
  groupCommentsByAuthor,
  highestSeverity,
  orderFindings,
  SEVERITY_RANK,
} from "@/lib/pr-comment-text";
import { cn } from "@/lib/utils";

type SortOrder = "latest" | "oldest";

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

/** Title text with its inline code set as code, the way GitHub shows it. */
function InlineTitle({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={index} className="rounded bg-hover px-1 font-mono text-[12px]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** `launch.json:15` first, its folder after, so the file reads at a glance. */
function CommentLocation({ path, line }: { path: string; line: number | null }) {
  const slash = path.lastIndexOf("/");
  const file = path.slice(slash + 1);
  const folder = slash > 0 ? path.slice(0, slash) : "";
  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground"
      // The trigger bolds its label when open; the location stays regular.
      style={{ fontVariationSettings: fontWeights.normal }}
      title={`${path}${line ? `:${line}` : ""}`}
    >
      <span className="shrink-0">
        {file}
        {line ? `:${line}` : ""}
      </span>
      {folder ? <span className="min-w-0 truncate text-muted-foreground/60">{folder}</span> : null}
    </span>
  );
}

function CommentItem({
  comment,
  finding,
  index,
}: {
  comment: WorkspacePrComment;
  finding: CommentFinding;
  index: number;
}) {
  return (
    <AccordionItem value={comment.id} index={index}>
      <AccordionTrigger className="items-start" hideChevron>
        <span className="flex min-w-0 flex-col gap-1">
          {/* A fixed weight and ink: the trigger's open/hover restyle would
              make the title jump; addressed findings recede instead. */}
          <span
            className={cn(
              "line-clamp-2 text-[14px] leading-5",
              finding.addressed ? "text-muted-foreground/70" : "text-foreground",
            )}
            style={{ fontVariationSettings: fontWeights.medium }}
          >
            <InlineTitle text={finding.title} />
          </span>
          {comment.path ? <CommentLocation path={comment.path} line={comment.line} /> : null}
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="flex flex-col gap-2">
          {finding.body ? (
            <MarkdownRenderer className="text-[13px] leading-6 text-muted-foreground">
              {finding.body}
            </MarkdownRenderer>
          ) : null}
          {comment.url ? (
            <button
              type="button"
              onClick={() => void window.omni.shell.openHttps(comment.url!).catch(() => {})}
              className="self-start text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              View on GitHub
            </button>
          ) : null}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

export function WorkspacePrComments({ comments }: { comments: WorkspacePrComment[] }) {
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
        variant="plain"
        className="w-full"
        defaultValue={orderedGroups[0] ? [orderedGroups[0].author] : []}
      >
        {orderedGroups.map((group, index) => {
          const findings = orderFindings(group.comments, order);
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
                </span>
              </AccordionTrigger>
              <AccordionContent className="-mt-1">
                {/* One row per finding; open one to read it. */}
                {/* The first finding starts open, so the rows read as foldable. */}
                <Accordion
                  type="multiple"
                  variant="plain"
                  className="w-full gap-0"
                  defaultValue={findings[0] ? [findings[0].comment.id] : []}
                >
                  {findings.map(({ comment, finding }, commentIndex) => (
                    <CommentItem
                      key={comment.id}
                      comment={comment}
                      finding={finding}
                      index={commentIndex}
                    />
                  ))}
                </Accordion>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </section>
  );
}
