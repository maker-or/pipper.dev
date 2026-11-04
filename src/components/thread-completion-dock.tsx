import { useEffect, useMemo, useRef } from "react";
import { ArrowRight, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import type { Thread } from "../../contracts/threads.ts";
import { TOAST_TITLE_MAX, clampToastText, toast } from "@/components/ui/toast";
import { openThreadAnywhere, selectThread } from "@/lib/thread-actions";
import { useOpenTabsQuery } from "@/lib/thread-queries";
import { cn } from "@/lib/utils";
import {
  startThreadCompletionWatcher,
  useThreadCompletionStore,
} from "@/store/thread-completion-store";
import { useThreadStore } from "@/store/thread-store";

/** Toasts linger long enough to read across a project switch, no longer. */
const COMPLETION_TOAST_MS = 8_000;

function threadLabel(thread: Thread | undefined): string {
  return thread?.title?.trim() || "Untitled thread";
}

/**
 * Persistent strip under the conversation listing the oldest finished
 * background thread, with an arrow that jumps to it. Also owns the
 * completion watcher and the arrival toasts, so mounting it once in the
 * shell is the whole feature.
 */
export function ThreadCompletionDock({ projects }: { projects: Project[] }) {
  const queue = useThreadCompletionStore((state) => state.queue);
  const acknowledge = useThreadCompletionStore((state) => state.acknowledge);
  const knownThreads = useThreadStore((state) => state.threads);
  const openThreads = useOpenTabsQuery().data?.openThreads;

  const threadsById = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const thread of knownThreads) map.set(thread.id, thread);
    // Open tabs carry the freshest title (session_info_update renames land there first).
    for (const thread of openThreads ?? []) map.set(thread.id, thread);
    return map;
  }, [knownThreads, openThreads]);

  // The watcher fires from a store subscription, outside React, so it reads
  // the latest lookup tables through refs instead of re-subscribing per render.
  const threadsRef = useRef(threadsById);
  threadsRef.current = threadsById;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const open = async (threadId: string) => {
    const thread = threadsRef.current.get(threadId);
    // Viewing it is the acknowledgement; drop it before the switch so a slow
    // switch never shows the arrow pointing at the thread already opening.
    acknowledge(threadId);
    if (!thread) {
      // Unknown to the renderer (e.g. its project list was never paged in):
      // a plain switch still works when the thread is in the active workspace.
      await selectThread(threadId).catch((err) => {
        toast({
          icon: <WarningCircle weight="duotone" className="size-5 text-destructive" />,
          title: "Could not open thread",
          description: err instanceof Error ? err.message : "The thread is no longer available.",
        });
      });
      return;
    }
    try {
      await openThreadAnywhere(thread, projectsRef.current);
    } catch (err) {
      toast({
        icon: <WarningCircle weight="duotone" className="size-5 text-destructive" />,
        title: "Could not open thread",
        description: err instanceof Error ? err.message : "The thread is no longer available.",
      });
    }
  };
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(
    () =>
      startThreadCompletionWatcher((threadId) => {
        const thread = threadsRef.current.get(threadId);
        const project = projectsRef.current.find((item) => item.id === thread?.project_id);
        toast({
          icon: <CheckCircle weight="duotone" className="size-5 text-emerald-500" />,
          // Cap the label so " finished" survives the toast's own clamp.
          title: `${clampToastText(threadLabel(thread), TOAST_TITLE_MAX - 9)} finished`,
          description: project ? `Agent run completed in ${project.name}.` : "Agent run completed.",
          duration: COMPLETION_TOAST_MS,
          action: {
            label: "Open",
            onClick: () => void openRef.current(threadId),
          },
        });
      }),
    [],
  );

  const headId = queue[0];
  if (!headId) return null;
  const head = threadsById.get(headId);
  return (
    <ThreadCompletionDockView
      title={threadLabel(head)}
      projectName={projects.find((item) => item.id === head?.project_id)?.name ?? null}
      remaining={queue.length - 1}
      onDismiss={() => acknowledge(headId)}
      onOpen={() => void open(headId)}
    />
  );
}

/** Presentational strip; the container above resolves titles and actions. */
export function ThreadCompletionDockView({
  title,
  projectName,
  remaining,
  onDismiss,
  onOpen,
}: {
  title: string;
  projectName: string | null;
  /** Further finished threads queued behind this one. */
  remaining: number;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-pipper-id="thread-completion-dock"
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-t border-border bg-surface-2 px-3",
        "text-[12px] text-muted-foreground",
      )}
    >
      <CheckCircle weight="duotone" className="size-4 shrink-0 text-emerald-500" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{title}</span>
        {projectName ? <span className="text-muted-foreground/70"> · {projectName}</span> : null}
        <span> finished</span>
        {remaining > 0 ? (
          <span className="text-muted-foreground/70">
            {" "}
            · {remaining} more {remaining === 1 ? "thread" : "threads"} waiting
          </span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`Dismiss ${title}`}
        className="grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        onClick={onDismiss}
      >
        <X size={13} />
      </button>
      <button
        type="button"
        aria-label={`Open ${title}`}
        data-pipper-id="thread-completion-next"
        className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-surface-3 px-2 text-[12px] font-medium text-foreground outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        onClick={onOpen}
      >
        Open
        <ArrowRight size={13} weight="bold" />
      </button>
    </div>
  );
}
