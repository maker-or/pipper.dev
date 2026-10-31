import { useQuery } from "@tanstack/react-query";
import { ArrowRight, WarningCircle } from "@phosphor-icons/react";
import type { Thread } from "../../contracts/threads.ts";
import { ProviderLogo } from "@/components/provider-logos";
import { taskNeedsUser, taskStatusText } from "@/lib/agent-task-tree";
import { toast } from "@/components/ui/toast";
import { openThreadAnywhere } from "@/lib/thread-actions";
import type { ThreadLink } from "@/lib/thread-links";
import { cn } from "@/lib/utils";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { useAgentStore } from "@/store/agent-store";

const KIND_LABEL: Record<ThreadLink["kind"], string> = {
  thread: "New thread",
  subthread: "Subthread",
};

interface ThreadLinkCardViewProps {
  title: string;
  kind: ThreadLink["kind"];
  agentName: string;
  /** Provider / agent key for the logo. */
  provider: string;
  running: boolean;
  /** The thread is gone (deleted); the card stays as a record but can't open it. */
  missing: boolean;
  /** A subthread's status ("Done", "Has a question"); a plain thread shows "Working" or nothing. */
  status?: string | null;
  /** A subthread waits on the user: an amber ring, and the status reads as a call to act. */
  needsUser?: boolean;
  /** A settled subthread's wrap_up recap, or the tail of its report. */
  recap?: string | null;
  onOpen: () => void;
}

/** Presentational card; the container below resolves the thread and opens it. */
export function ThreadLinkCardView({
  title,
  kind,
  agentName,
  provider,
  running,
  missing,
  status,
  needsUser = false,
  recap,
  onOpen,
}: ThreadLinkCardViewProps) {
  const statusText = missing ? "Deleted" : (status ?? (running ? "Working" : null));
  return (
    <button
      type="button"
      data-pipper-id="thread-link-card"
      disabled={missing}
      onClick={onOpen}
      aria-label={missing ? `${title} (deleted)` : `Open ${title}`}
      className={cn(
        "group flex w-full max-w-md items-center gap-3 rounded-2xl border border-border/70 bg-surface-2/70 px-3 py-2.5 text-left",
        "outline-none transition-colors duration-100 hover:bg-hover",
        "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]",
        "disabled:cursor-default disabled:hover:bg-surface-2/70",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "subthread-orb relative flex size-8 shrink-0 items-center justify-center rounded-full text-foreground",
          needsUser ? "subthread-orb-waiting" : running && "subthread-orb-working",
        )}
      >
        <ProviderLogo provider={provider} label={agentName} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
        <span className="truncate text-[12px] text-muted-foreground">
          {KIND_LABEL[kind]} · {agentName}
          {statusText && (
            <>
              {" · "}
              <span className={cn(needsUser && "text-amber-600 dark:text-amber-400")}>
                {statusText}
              </span>
            </>
          )}
        </span>
        {recap && !running && !missing && (
          <span
            data-pipper-id="thread-link-recap"
            className="mt-1 line-clamp-2 break-words text-[12px] text-muted-foreground"
          >
            {recap}
          </span>
        )}
      </span>
      {!missing && (
        <ArrowRight
          size={14}
          className="shrink-0 text-muted-foreground transition-transform duration-100 group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      )}
    </button>
  );
}

/**
 * A link, in the turn that started it, to a thread the agent started with
 * `create_thread` or `start_subthread`. A subthread's card follows its task:
 * live status, "Has a question" when it waits on the user, and its recap
 * once it stops. Opening it switches project and workspace first when the
 * thread lives elsewhere.
 */
export function ThreadLinkCard({ link }: { link: ThreadLink }) {
  const { data: thread, isPending } = useQuery({
    queryKey: ["thread-link", link.threadId],
    queryFn: async (): Promise<Thread | null> =>
      (await window.omni.threads.listByIds([link.threadId]))[0] ?? null,
    staleTime: 30_000,
  });
  const running = useAgentStore((state) => state.runningThreadIds.includes(link.threadId));
  const task = useAgentStore((state) =>
    state.agentTasks.find((candidate) => candidate.childThreadId === link.threadId),
  );
  const agent = useAgentRegistryStore((state) =>
    thread ? state.agents.find((candidate) => candidate.id === thread.agent_id) : undefined,
  );

  const open = async () => {
    if (!thread) return;
    try {
      await openThreadAnywhere(thread);
    } catch (err) {
      toast({
        icon: <WarningCircle weight="duotone" className="size-5 text-destructive" />,
        title: "Could not open thread",
        description: err instanceof Error ? err.message : "The thread is no longer available.",
      });
    }
  };

  return (
    <ThreadLinkCardView
      title={thread?.title?.trim() || (isPending ? "Starting thread…" : "Untitled thread")}
      kind={link.kind}
      agentName={agent?.displayName ?? thread?.agent_id ?? "Agent"}
      provider={agent?.icon ?? agent?.driverId ?? thread?.agent_id ?? "generic"}
      running={running || task?.status === "starting"}
      missing={!isPending && !thread}
      status={task ? taskStatusText(task) : null}
      needsUser={task ? taskNeedsUser(task) : false}
      recap={task?.reportPreview ?? null}
      onOpen={() => void open()}
    />
  );
}
