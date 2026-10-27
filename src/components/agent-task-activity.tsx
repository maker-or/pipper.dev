"use client";

import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowSquareOut, ArrowBendUpLeft } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Elevated } from "@/lib/elevated";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { taskStatusText } from "@/lib/agent-task-tree";

type TaskState = "starting" | "working" | "permission" | "question";

const STATE_DOT: Record<TaskState, string> = {
  starting: "bg-muted-foreground",
  working: "bg-blue-500",
  permission: "bg-amber-500",
  question: "bg-amber-500",
};

const STATE_LABEL: Record<TaskState, string> = {
  starting: "Starting",
  working: "Working",
  permission: "Needs permission",
  question: "Has a question",
};

/** What the parent thread should show for a task, or null when it needs nothing. */
export function taskState(task: AgentTaskSnapshot): TaskState | null {
  if (task.status === "starting") return "starting";
  if (task.status === "running") return task.waitingForPermission ? "permission" : "working";
  if (task.status === "idle" && task.outcome === "needs_input") return "question";
  return null;
}

interface AgentTaskActivityProps {
  tasks: AgentTaskSnapshot[];
  agents: AcpAgentDescriptor[];
  /** The thread being viewed; only tasks it started are shown. */
  parentThreadId: string | null;
  onOpenThread: (threadId: string) => void;
  className?: string;
}

/**
 * Tasks the viewed thread started that are running or waiting on someone,
 * fed by "agent-tasks" bridge events. Each task is a real thread; a row opens
 * it. Settled tasks drop off: their thread and receipt stay available.
 */
export function AgentTaskActivity({
  tasks,
  agents,
  parentThreadId,
  onOpenThread,
  className,
}: AgentTaskActivityProps) {
  const prefersReducedMotion = useReducedMotion();

  const visible = useMemo(() => {
    if (!parentThreadId) return [];
    return tasks
      .filter((task) => task.parentThreadId === parentThreadId && taskState(task) !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [tasks, parentThreadId]);

  const agentName = (agentId: string) =>
    agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;

  return (
    <AnimatePresence initial={false}>
      {visible.length > 0 && (
        <motion.div
          data-pipper-id="agent-task-activity"
          aria-label="Agent tasks"
          initial={{
            opacity: 0,
            y: prefersReducedMotion ? 0 : 12,
            scale: prefersReducedMotion ? 1 : 0.98,
          }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            prefersReducedMotion
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.15, ease: "easeIn" } }
          }
          transition={
            prefersReducedMotion ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 }
          }
          style={{ transformOrigin: "bottom center" }}
          className={className}
        >
          <Elevated offset={1} shadowLevel={2} className="rounded-xl px-2 py-2">
            <div className="flex items-center justify-between px-1.5 pb-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Tasks
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {visible.length}
              </span>
            </div>
            <ul className="flex flex-col">
              {visible.map((task) => {
                const state = taskState(task)!;
                const working = state === "working" || state === "starting";
                const childThreadId = task.childThreadId;
                return (
                  <li key={task.taskId} data-status={state}>
                    <button
                      type="button"
                      disabled={!childThreadId}
                      onClick={() => childThreadId && onOpenThread(childThreadId)}
                      title={childThreadId ? "Open this task's thread" : STATE_LABEL[state]}
                      className="group flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-foreground/5 disabled:cursor-default"
                    >
                      <span className="relative flex size-1.5 shrink-0 items-center justify-center">
                        {state === "working" && (
                          <span className="absolute inline-flex size-1.5 animate-ping rounded-full bg-blue-500/60" />
                        )}
                        <span className={cn("relative size-1.5 rounded-full", STATE_DOT[state])} />
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[13px] font-medium",
                          working ? "animate-text-shimmer" : "text-foreground",
                        )}
                      >
                        {agentName(task.agentId)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                        {task.title}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {STATE_LABEL[state]}
                      </span>
                      {childThreadId && (
                        <ArrowSquareOut
                          size={12}
                          className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Elevated>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface AgentTaskOriginProps {
  tasks: AgentTaskSnapshot[];
  /** The thread being viewed; shown only when it is a task. */
  threadId: string | null;
  onOpenThread: (threadId: string) => void;
  className?: string;
}

/** In a task's own thread: where it came from, with a way back. */
export function AgentTaskOrigin({
  tasks,
  threadId,
  onOpenThread,
  className,
}: AgentTaskOriginProps) {
  const task = threadId ? tasks.find((candidate) => candidate.childThreadId === threadId) : null;
  if (!task) return null;
  return (
    <div
      data-pipper-id="agent-task-origin"
      className={cn("flex items-center gap-2 px-2 text-[11px] text-muted-foreground", className)}
    >
      <span className="min-w-0 truncate">
        Task started by another agent · {taskStatusText(task)}
      </span>
      <button
        type="button"
        onClick={() => onOpenThread(task.parentThreadId)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-foreground/5 hover:text-foreground"
      >
        <ArrowBendUpLeft size={12} />
        Open parent thread
      </button>
    </div>
  );
}
