"use client";

import { useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowBendUpLeft } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { ProviderLogo } from "@/components/provider-logos";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { taskStatusText } from "@/lib/agent-task-tree";

type TaskState = "starting" | "working" | "permission" | "question";

const STATE_LABEL: Record<TaskState, string> = {
  starting: "Starting",
  working: "Working",
  permission: "Needs permission",
  question: "Has a question",
};

/** Circles shown before the rest collapse into a "+N" count. */
const MAX_ORBS = 4;

/** What the parent thread should show for a task, or null when it needs nothing. */
export function taskState(task: AgentTaskSnapshot): TaskState | null {
  if (task.status === "starting") return "starting";
  if (task.status === "running") return task.waitingForPermission ? "permission" : "working";
  if (task.status === "idle" && task.outcome === "needs_input") return "question";
  return null;
}

interface SubthreadOrbsProps {
  tasks: AgentTaskSnapshot[];
  agents: AcpAgentDescriptor[];
  /** The thread being viewed; only subthreads it started are shown. */
  parentThreadId: string | null;
  onOpenThread: (threadId: string) => void;
  className?: string;
}

/**
 * Subthreads the viewed thread started that are running or waiting on
 * someone, as small provider-logo circles in the composer rail. A working
 * subthread shimmers; one waiting on the user gets an amber ring and
 * dot. Each circle opens its thread. Settled subthreads drop off: their
 * thread and receipt stay available.
 */
export function SubthreadOrbs({
  tasks,
  agents,
  parentThreadId,
  onOpenThread,
  className,
}: SubthreadOrbsProps) {
  const prefersReducedMotion = useReducedMotion();

  const visible = useMemo(() => {
    if (!parentThreadId) return [];
    return tasks
      .filter((task) => task.parentThreadId === parentThreadId && taskState(task) !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [tasks, parentThreadId]);

  if (visible.length === 0) return null;

  const agentFor = (agentId: string) => agents.find((agent) => agent.id === agentId);
  const shown = visible.slice(0, MAX_ORBS);
  const hidden = visible.length - shown.length;

  return (
    <ul
      data-pipper-id="subthread-orbs"
      aria-label="Running subthreads"
      className={cn("flex items-center gap-1", className)}
    >
      <AnimatePresence initial={false}>
        {shown.map((task) => {
          const state = taskState(task)!;
          const waiting = state === "permission" || state === "question";
          const agent = agentFor(task.agentId);
          const agentName = agent?.displayName ?? task.agentId;
          const childThreadId = task.childThreadId;
          const label = `${task.title} · ${agentName} · ${STATE_LABEL[state]}`;
          return (
            <motion.li
              key={task.taskId}
              data-status={state}
              initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.6 }}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { type: "spring", duration: 0.3, bounce: 0 }
              }
            >
              <button
                type="button"
                disabled={!childThreadId}
                onClick={() => childThreadId && onOpenThread(childThreadId)}
                aria-label={childThreadId ? `Open ${label}` : label}
                title={label}
                className={cn(
                  "relative flex size-6 items-center justify-center rounded-full outline-none",
                  "transition-transform duration-100 hover:scale-110",
                  "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]",
                  "disabled:cursor-default disabled:hover:scale-100",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "subthread-orb absolute inset-0 flex items-center justify-center rounded-full text-foreground",
                    waiting ? "subthread-orb-waiting" : "subthread-orb-working",
                  )}
                >
                  <ProviderLogo
                    provider={agent?.icon ?? agent?.driverId ?? task.agentId}
                    label={agentName}
                    size={12}
                  />
                </span>
                {waiting && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-0.5 -top-0.5 size-2 rounded-full border border-background bg-amber-500"
                  />
                )}
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
      {hidden > 0 && (
        <li
          className="px-1 text-[11px] tabular-nums text-muted-foreground"
          title={`${hidden} more running`}
        >
          +{hidden}
        </li>
      )}
    </ul>
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
