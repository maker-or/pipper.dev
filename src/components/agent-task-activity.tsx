"use client";

import { ArrowBendUpLeft, CaretRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { taskStatusText } from "@/lib/agent-task-tree";

interface AgentTaskOriginProps {
  tasks: AgentTaskSnapshot[];
  /** The thread being viewed; shown only when it is a task. */
  threadId: string | null;
  /** The parent's title, when Pipper has the thread loaded. */
  threadTitle: (threadId: string) => string | null;
  onOpenThread: (threadId: string) => void;
  className?: string;
}

/** In a subthread: a breadcrumb back to the thread that started it. */
export function AgentTaskOrigin({
  tasks,
  threadId,
  threadTitle,
  onOpenThread,
  className,
}: AgentTaskOriginProps) {
  const task = threadId ? tasks.find((candidate) => candidate.childThreadId === threadId) : null;
  if (!task) return null;
  const parentTitle = threadTitle(task.parentThreadId)?.trim() || "Parent thread";
  return (
    <nav
      data-pipper-id="agent-task-origin"
      aria-label="Subthread of"
      className={cn(
        "flex min-w-0 items-center gap-1 px-2 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onOpenThread(task.parentThreadId)}
        title={`Back to ${parentTitle}`}
        className="inline-flex min-w-0 max-w-[45%] items-center gap-1 rounded-md px-1.5 py-0.5 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
      >
        <ArrowBendUpLeft size={12} className="shrink-0" />
        <span className="truncate">{parentTitle}</span>
      </button>
      <CaretRight size={10} aria-hidden="true" className="shrink-0 opacity-60" />
      <span className="min-w-0 truncate text-foreground/80">{task.title}</span>
      <span className="shrink-0">· {taskStatusText(task)}</span>
    </nav>
  );
}
