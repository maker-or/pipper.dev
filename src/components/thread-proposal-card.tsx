import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WarningCircle } from "@phosphor-icons/react";
import type { ThreadProposalSnapshot } from "../../contracts/agent-tasks.ts";
import { ProviderLogo } from "@/components/provider-logos";
import { ThreadLinkCard } from "@/components/thread-link-card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { useAgentRegistryStore } from "@/store/agent-registry-store";

const SETTLED_LABEL: Record<"dismissed" | "expired", string> = {
  dismissed: "Dismissed",
  expired: "Expired",
};

interface ThreadProposalCardViewProps {
  title: string;
  agentName: string;
  /** Provider / agent key for the logo. */
  provider: string;
  model: string | null;
  task: string;
  state: "open" | "dismissed" | "expired";
  busy: "start" | "dismiss" | null;
  onStart: () => void;
  onDismiss: () => void;
}

/** Presentational card; the container below loads the proposal and answers it. */
export function ThreadProposalCardView({
  title,
  agentName,
  provider,
  model,
  task,
  state,
  busy,
  onStart,
  onDismiss,
}: ThreadProposalCardViewProps) {
  const open = state === "open";
  return (
    <div
      data-pipper-id="thread-proposal-card"
      data-state={state}
      className={cn(
        "flex w-full max-w-md flex-col gap-2.5 rounded-2xl border border-border/70 bg-surface-2/70 px-3 py-2.5",
        !open && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="subthread-orb relative flex size-8 shrink-0 items-center justify-center rounded-full text-foreground"
        >
          <ProviderLogo provider={provider} label={agentName} size={14} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">{title}</span>
          <span className="truncate text-[12px] text-muted-foreground">
            Proposed thread · {agentName}
            {model ? ` · ${model}` : ""}
            {open ? "" : ` · ${SETTLED_LABEL[state]}`}
          </span>
        </span>
      </div>
      {open && (
        <>
          <p className="line-clamp-3 break-words text-[12px] text-muted-foreground" title={task}>
            {task}
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={onDismiss}
              disabled={busy !== null}
              loading={busy === "dismiss"}
            >
              Dismiss
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={onStart}
              disabled={busy !== null}
              loading={busy === "start"}
            >
              Start
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A thread the agent proposed with `create_thread` (initiation "propose").
 * Nothing runs until the user presses Start; then the card becomes a link to
 * the new thread. Dismissed and expired proposals stay as a record.
 */
export function ThreadProposalCard({ proposalId }: { proposalId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["thread-proposal", proposalId];
  const { data: proposal, isPending } = useQuery({
    queryKey,
    queryFn: async (): Promise<ThreadProposalSnapshot | null> =>
      (await window.omni.agentTasks.getProposals([proposalId]))[0] ?? null,
    staleTime: 30_000,
  });
  const agent = useAgentRegistryStore((state) =>
    proposal ? state.agents.find((candidate) => candidate.id === proposal.agentId) : undefined,
  );
  const [busy, setBusy] = useState<"start" | "dismiss" | null>(null);

  if (isPending || !proposal) return null;
  if (proposal.state === "started") {
    // The thread is being created when threadId is still null.
    return proposal.threadId ? (
      <ThreadLinkCard link={{ threadId: proposal.threadId, kind: "thread" }} />
    ) : null;
  }

  const answer = async (action: "start" | "dismiss") => {
    setBusy(action);
    try {
      const next =
        action === "start"
          ? await window.omni.agentTasks.startProposal(proposalId)
          : await window.omni.agentTasks.dismissProposal(proposalId);
      queryClient.setQueryData(queryKey, next);
    } catch (err) {
      toast({
        icon: <WarningCircle weight="duotone" className="size-5 text-destructive" />,
        title: action === "start" ? "Could not start thread" : "Could not dismiss proposal",
        description: err instanceof Error ? err.message : "Try again.",
      });
      void queryClient.invalidateQueries({ queryKey });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ThreadProposalCardView
      title={proposal.title}
      agentName={agent?.displayName ?? proposal.agentId}
      provider={agent?.icon ?? agent?.driverId ?? proposal.agentId}
      model={proposal.model}
      task={proposal.task}
      state={proposal.state}
      busy={busy}
      onStart={() => void answer("start")}
      onDismiss={() => void answer("dismiss")}
    />
  );
}
