import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowSquareOut,
  CheckCircleIcon,
  CircleNotch,
  SealCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { ConnectorTile, errorText, hostOf, INPUT_CLASS } from "@/components/connector-settings";
import { Button } from "@/components/ui/button";
import { connectorRequestKey } from "@/lib/connector-request-links";
import { cn } from "@/lib/utils";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { useThreadStore } from "@/store/thread-store";
import { connectorCatalogEntry } from "../../contracts/connector-catalog.ts";
import type { ConnectorRequestRef, ConnectorRequestSnapshot } from "../../contracts/connectors.ts";

/**
 * The card an agent's `add_connector` call shows: from the ask, through the
 * sign-in, to connected. Keys and values typed here go straight to Pipper's
 * main process; the agent and the transcript never see them.
 */
export function ConnectorRequestCard({ requestRef }: { requestRef: ConnectorRequestRef }) {
  const queryClient = useQueryClient();
  const refKey = connectorRequestKey(requestRef);
  const queryKey = ["connector-request", refKey];
  const { data: request, isPending } = useQuery({
    queryKey,
    // By id, or by what the call asked for (see docs/harness-differences.md).
    queryFn: (): Promise<ConnectorRequestSnapshot | null> =>
      window.omni.connectorRequests.find(requestRef),
    staleTime: 30_000,
  });
  const requestId = request?.requestId ?? null;
  const agentId = useThreadStore(
    (state) => state.threads.find((thread) => thread.id === request?.threadId)?.agent_id,
  );
  const agentName = useAgentRegistryStore(
    (state) => state.agents.find((agent) => agent.id === agentId)?.displayName,
  );

  // Sign-ins finish in the browser; main tells every window when a card moves.
  useEffect(
    () =>
      window.omni.connectorRequests.onChanged((next) => {
        if (next.requestId === requestId) {
          queryClient.setQueryData(["connector-request", refKey], next);
        }
      }),
    [requestId, refKey, queryClient],
  );

  if (isPending || !request) return null;
  return (
    <ConnectorRequestCardView
      request={request}
      agentName={agentName ?? "your agent"}
      onConnect={async (answer) => {
        const next = await window.omni.connectorRequests.connect(request.requestId, answer);
        queryClient.setQueryData(queryKey, next);
      }}
      onCancel={() => void window.omni.connectorRequests.cancel(request.requestId)}
      onDecline={async () => {
        const next = await window.omni.connectorRequests.decline(request.requestId);
        queryClient.setQueryData(queryKey, next);
      }}
    />
  );
}

interface ViewProps {
  request: ConnectorRequestSnapshot;
  /** The asking thread's agent: "Let Claude Code use Linear". */
  agentName: string;
  onConnect: (answer: { key?: string; values?: Record<string, string> }) => Promise<void>;
  onCancel: () => void;
  onDecline: () => Promise<void>;
}

/** One row: the service's tile, its name, what connecting does, and the action. */
export function ConnectorRequestCardView({
  request,
  agentName,
  onConnect,
  onCancel,
  onDecline,
}: ViewProps) {
  const entry = connectorCatalogEntry(request.catalogId);
  const [key, setKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"connect" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const local = Boolean(request.command);
  const valueNames = request.connector ? [] : local ? request.envNames : request.headerNames;
  // A connector that already exists (off, or signed out) needs no key unless it's keyed.
  const needsKey =
    entry?.auth.kind === "key" &&
    (!request.connector ||
      request.connector.status === "needs_sign_in" ||
      request.state === "failed");
  const open = request.state === "requested" || request.state === "failed";
  const connecting = request.state === "connecting" || busy === "connect";
  const signingIn = request.connector?.signingIn ?? false;
  const settled = request.state === "declined" || request.state === "expired";
  const shownError = error ?? request.error;
  const where = local ? [request.command, ...request.args].join(" ") : request.url;

  const run = async (action: "connect" | "decline") => {
    setBusy(action);
    setError(null);
    try {
      if (action === "connect") await onConnect({ key: key.trim() || undefined, values });
      else await onDecline();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };

  // Connected shows no line: the thread only gets the tools once it reloads after its turn.
  const subtitle =
    request.state === "connected"
      ? null
      : connecting
        ? signingIn
          ? `Finish signing in to ${request.name} in your browser`
          : "Connecting…"
        : request.state === "declined"
          ? "You didn't connect it"
          : request.state === "expired"
            ? "This request expired"
            : request.connector?.status === "needs_sign_in" && entry?.auth.kind !== "key"
              ? `Sign in again so ${agentName} can use ${request.name}`
              : `Let ${agentName} use ${request.name}`;

  return (
    <div
      data-pipper-id="connector-request-card"
      data-state={request.state}
      className={cn(
        "flex w-full max-w-xl flex-col rounded-[22px] border border-border/60 bg-surface-2/70 px-4 py-3.5",
        settled && "opacity-70",
      )}
    >
      <div className="flex min-w-0 items-center gap-4">
        <ConnectorTile name={request.name} catalogId={request.catalogId} size="lg" />
        <div className="min-w-0 flex-1" title={open ? request.reason : undefined}>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[15px] font-medium text-foreground">{request.name}</span>
            {entry && (
              <SealCheck
                size={17}
                weight="fill"
                className="shrink-0 text-sky-500"
                aria-label="In Pipper's catalog"
              />
            )}
          </div>
          {subtitle && (
            <div className="mt-0.5 truncate text-[13px] text-muted-foreground">{subtitle}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {open && !connecting && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void run("decline")}
                disabled={busy !== null}
                loading={busy === "decline"}
              >
                Not now
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="rounded-full px-5"
                onClick={() => void run("connect")}
                disabled={busy !== null || (needsKey && !key.trim())}
              >
                {request.state === "failed" ? "Try again" : "Connect"}
              </Button>
            </>
          )}
          {connecting && (
            <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
              <CircleNotch size={15} className="animate-spin" />
              {signingIn && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Cancel
                </button>
              )}
            </span>
          )}
          {request.state === "connected" && (
            <span className="inline-flex items-center gap-1.5 pr-1 text-[13px] text-foreground">
              <CheckCircleIcon size={16} weight="fill" />
              Connected
            </span>
          )}
        </div>
      </div>

      {open && !connecting && (needsKey || valueNames.length > 0 || !entry || shownError) && (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-border/60 pt-3">
          {!entry && (
            <p className="text-[12px] leading-[18px] text-muted-foreground">
              <span className="break-all font-mono text-foreground/80">{where}</span>
              <br />
              Not in Pipper's catalog.{" "}
              {local
                ? `${agentName} runs this command on this computer, with your permissions.`
                : `Only connect a server you trust (${hostOf(request.url)}).`}
            </p>
          )}
          {needsKey && entry?.auth.kind === "key" && (
            <label className="flex flex-col gap-1">
              <span className="flex items-center justify-between text-[11px] font-medium text-foreground">
                {entry.auth.label}
                <button
                  type="button"
                  onClick={() =>
                    entry.auth.kind === "key" &&
                    void window.omni?.shell?.openExternal?.(entry.auth.helpUrl)
                  }
                  className="inline-flex items-center gap-0.5 font-normal text-muted-foreground underline underline-offset-4 hover:text-foreground"
                >
                  Make one on {entry.name}
                  <ArrowSquareOut size={11} />
                </button>
              </span>
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          )}
          {valueNames.map((name) => (
            <label key={name} className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-foreground">{name}</span>
              <input
                type="password"
                autoComplete="off"
                value={values[name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [name]: event.target.value }))
                }
                className={INPUT_CLASS}
              />
            </label>
          ))}
          {shownError && (
            <p
              className="inline-flex items-start gap-1.5 text-[12px] leading-4 text-destructive"
              role="alert"
            >
              <WarningCircle size={14} weight="fill" className="mt-px shrink-0" />
              {shownError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
