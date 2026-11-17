import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeCheck,
  CircleAlert,
  CircleDashed,
  CircleX,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { ProviderLogo } from "@/components/provider-logos";
import { useAgentInstancesStore } from "@/store/agent-instances-store";
import type {
  AcpAgentInstance,
  AgentAccountSchema,
  AgentProbeResult,
} from "../../contracts/acp.ts";

interface StatusView {
  label: string;
  textClass: string;
  icon: LucideIcon;
}

function statusView(result: AgentProbeResult | undefined, probing: boolean): StatusView {
  if (probing) {
    return { label: "Checking…", textClass: "text-muted-foreground", icon: Loader2 };
  }
  if (!result) {
    return { label: "Not checked", textClass: "text-muted-foreground/70", icon: CircleDashed };
  }
  switch (result.status) {
    case "ready":
      return { label: "Signed in", textClass: "text-emerald-500", icon: BadgeCheck };
    case "needs-auth":
      return { label: "Sign-in required", textClass: "text-amber-500", icon: CircleAlert };
    case "needs-install":
      return { label: "Not installed", textClass: "text-amber-500", icon: CircleAlert };
    // The agent could not be launched or failed its handshake. This says
    // nothing about the account's sign-in, so it is not labelled as one.
    case "error":
      return { label: "Couldn't start", textClass: "text-destructive", icon: CircleX };
    default:
      return { label: "Unknown", textClass: "text-muted-foreground/70", icon: CircleDashed };
  }
}

/**
 * The most telling line of a probe failure. Crash output is mostly stack
 * trace, so prefer a thrown error's own line (`Error: …`), then any line
 * naming an error, then the first line.
 */
function errorHeadline(message: string | undefined): string {
  const lines = (message ?? "")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /^[A-Za-z]*Error: /.test(line)) ??
    lines.find((line) => /\berror\b(?!\s*\()/i.test(line)) ??
    lines[0] ??
    "unknown error"
  );
}

function StatusIcon({ result, probing }: { result?: AgentProbeResult; probing: boolean }) {
  const view = statusView(result, probing);
  const Icon = view.icon;
  return (
    <span
      title={result?.message ?? view.label}
      aria-label={view.label}
      className={`inline-flex shrink-0 items-center ${view.textClass}`}
    >
      <Icon className={`size-4 ${probing ? "animate-spin" : ""}`} strokeWidth={2} />
    </span>
  );
}

function AccountRow({
  instance,
  schema,
  result,
  probing,
  onRemove,
  onSignIn,
  onCheck,
}: {
  instance: AcpAgentInstance;
  schema: AgentAccountSchema;
  result?: AgentProbeResult;
  probing: boolean;
  onRemove: (id: string) => void;
  onSignIn: (id: string) => void;
  onCheck: (id: string) => void;
}) {
  const isDefault = instance.id === instance.driverId;
  // A launch failure is not a sign-in problem; say what failed so the row
  // doesn't read as "not connected".
  const failure =
    !probing && (result?.status === "error" || result?.status === "needs-install")
      ? `${statusView(result, false).label}: ${errorHeadline(result.message)}`
      : null;
  return (
    <div className="group flex items-center gap-3 py-1 pl-[54px] pr-4">
      {/* Name and status on one line, the failure reason on its own line
          below, so neither squeezes the other or the actions. */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] text-muted-foreground">{instance.displayName}</span>
          <StatusIcon result={result} probing={probing} />
        </div>
        {failure ? (
          <span title={result?.message} className="truncate text-[12px] text-destructive">
            {failure}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          aria-label={`Check ${instance.displayName} sign-in status`}
          onClick={() => onCheck(instance.id)}
          disabled={probing}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className="size-4" strokeWidth={1.8} />
        </button>
        {schema.supportsLogin ? (
          <button
            type="button"
            onClick={() => onSignIn(instance.id)}
            className="whitespace-nowrap rounded-lg bg-surface-3 px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-surface-4"
          >
            Sign in
          </button>
        ) : null}
        {isDefault ? (
          <div className="size-7" aria-hidden />
        ) : (
          <button
            type="button"
            aria-label={`Remove ${instance.displayName}`}
            onClick={() => onRemove(instance.id)}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-surface-3 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="size-4" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

function AddAccountForm({
  schema,
  onSubmit,
  onCancel,
}: {
  schema: AgentAccountSchema;
  onSubmit: (input: { displayName: string; secret?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const canSubmit = name.trim().length > 0 && (!schema.authEnvVar || secret.trim().length > 0);

  return (
    <div className="flex flex-col gap-2 py-2 pl-[54px] pr-4">
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Account name (e.g. Work)"
        className="h-8 rounded-lg border border-border/70 bg-surface-1 px-2.5 text-[12px] text-foreground outline-none focus:border-border"
      />
      {schema.authEnvVar ? (
        <input
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={schema.authEnvVar}
          type="password"
          className="h-8 rounded-lg border border-border/70 bg-surface-1 px-2.5 text-[12px] text-foreground outline-none focus:border-border"
        />
      ) : null}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit({ displayName: name.trim(), secret: secret.trim() || undefined })}
          className="rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-foreground shadow-surface-1 disabled:opacity-50"
        >
          Add account
        </button>
      </div>
    </div>
  );
}

/** How long to keep polling for sign-in completion after launching a login. */
const SIGNIN_POLL_INTERVAL_MS = 3_000;
const SIGNIN_POLL_MAX_ATTEMPTS = 40;

/**
 * Settings section for managing provider accounts. Lets the user add a second
 * account for a driver (isolated via its credential-root env var) without
 * touching the default ambient login. Each account shows a live sign-in status
 * (probed via a throwaway ACP session), and is polled after launching login so
 * completion is visible in the app rather than only in the terminal.
 */
export function AgentAccountsSettings() {
  const { instances, schemas, error, load, create, remove, launchLogin } = useAgentInstancesStore();
  const [addingDriverId, setAddingDriverId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, AgentProbeResult>>({});
  const [probingIds, setProbingIds] = useState<Set<string>>(() => new Set());
  const probedRef = useRef<Set<string>>(new Set());
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const inFlight = useRef<Map<string, Promise<AgentProbeResult | null>>>(new Map());
  const multiAccountSchemas = useMemo(
    () => schemas.filter((schema) => schema.supportsMultipleAccounts),
    [schemas],
  );
  // Only the accounts this page lists are probed. Probing launches each
  // agent, so probing every instance would start CLIs the user never sees
  // here (and the bundled mock agent) each time the window opens or regains
  // focus.
  const shownInstances = useMemo(() => {
    const shownDrivers = new Set(multiAccountSchemas.map((schema) => schema.driverId));
    return instances.filter((instance) => shownDrivers.has(instance.driverId));
  }, [instances, multiAccountSchemas]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback((id: string): Promise<AgentProbeResult | null> => {
    const existing = inFlight.current.get(id);
    if (existing) return existing;
    const run = async (): Promise<AgentProbeResult | null> => {
      if (!window.omni?.agent?.probeAgent) return null;
      const probeOnce = async (): Promise<AgentProbeResult> => {
        try {
          return await window.omni.agent.probeAgent(id);
        } catch (err) {
          return {
            agentId: id,
            status: "error",
            message: err instanceof Error ? err.message : "Check failed",
          };
        }
      };
      setProbingIds((prev) => new Set(prev).add(id));
      try {
        let result = await probeOnce();
        // A CLI that was mid-restart (or briefly contended) can close the ACP
        // connection; retry once before reporting a failure.
        if (result.status === "error") {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          result = await probeOnce();
        }
        setProbeResults((prev) => ({ ...prev, [id]: result }));
        return result;
      } finally {
        setProbingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    };
    const promise = run();
    inFlight.current.set(id, promise);
    void promise.finally(() => {
      if (inFlight.current.get(id) === promise) inFlight.current.delete(id);
    });
    return promise;
  }, []);

  const stopPolling = useCallback((id: string) => {
    const timer = pollTimers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      pollTimers.current.delete(id);
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling(id);
      let attempts = 0;
      // Self-scheduling: wait for each probe to finish before the next, so a
      // slow agent can't stack up overlapping processes.
      const tick = async () => {
        attempts += 1;
        const result = await check(id);
        if (result?.status === "ready" || attempts >= SIGNIN_POLL_MAX_ATTEMPTS) {
          stopPolling(id);
          return;
        }
        const timer = setTimeout(() => void tick(), SIGNIN_POLL_INTERVAL_MS);
        pollTimers.current.set(id, timer);
      };
      const timer = setTimeout(() => void tick(), 1_500);
      pollTimers.current.set(id, timer);
    },
    [check, stopPolling],
  );

  // Stop any in-flight polling when the component unmounts.
  useEffect(() => {
    const timers = pollTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Probe each account once so its status is visible without manual action.
  useEffect(() => {
    for (const instance of shownInstances) {
      if (probedRef.current.has(instance.id)) continue;
      probedRef.current.add(instance.id);
      void check(instance.id);
    }
  }, [shownInstances, check]);

  // Re-check when the user comes back to the app — e.g. after finishing a
  // sign-in that was started outside Pipper's own "Sign in" button.
  useEffect(() => {
    const onFocus = () => {
      for (const instance of shownInstances) {
        if (probeResults[instance.id]?.status === "ready") continue;
        void check(instance.id);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [shownInstances, probeResults, check]);

  const handleRemove = async (id: string) => {
    stopPolling(id);
    try {
      await remove(id);
    } catch {
      // Store surfaces the error.
    }
  };

  const handleSignIn = async (id: string) => {
    try {
      const result = await launchLogin(id);
      if (result.opened) {
        setNotice("Finish signing in the terminal window — status updates here automatically.");
        startPolling(id);
      } else {
        try {
          await navigator.clipboard?.writeText(result.command);
          setNotice(`Sign-in command copied to clipboard: ${result.command}`);
        } catch {
          setNotice(`Run this in your terminal: ${result.command}`);
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not start sign-in");
    }
  };

  const handleAdd = async (
    schema: AgentAccountSchema,
    input: { displayName: string; secret?: string },
  ) => {
    try {
      const created = await create({
        driverId: schema.driverId,
        displayName: input.displayName,
        env:
          schema.authEnvVar && input.secret
            ? [{ name: schema.authEnvVar, value: input.secret, sensitive: true }]
            : undefined,
      });
      setAddingDriverId(null);
      setNotice(
        schema.supportsLogin
          ? "Account added. Click Sign in to authenticate it."
          : "Account added.",
      );
      // A newly created account has no probe result yet.
      void check(created.id);
      probedRef.current.add(created.id);
    } catch {
      // Store surfaces the error.
    }
  };

  return (
    <div>
      {error ? <div className="px-4 py-3 text-[11px] text-destructive">{error}</div> : null}
      {notice ? (
        <div className="px-4 py-3 text-[11px] leading-4 text-muted-foreground">{notice}</div>
      ) : null}
      {multiAccountSchemas.map((schema, index) => {
        const accounts = instances.filter((instance) => instance.driverId === schema.driverId);
        const primary =
          accounts.find((instance) => instance.id === instance.driverId) ?? accounts[0];
        return (
          <div key={schema.driverId} className="py-2">
            {index > 0 ? <div className="mb-2 h-px bg-border/70" /> : null}
            <div className="flex items-center gap-3 px-4 py-1.5">
              <ProviderLogo
                provider={schema.driverId}
                label={schema.displayName}
                size={26}
                className="text-foreground"
              />
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                {schema.displayName}
              </span>
              {primary ? (
                <StatusIcon
                  result={probeResults[primary.id]}
                  probing={probingIds.has(primary.id)}
                />
              ) : null}
              <button
                type="button"
                aria-label={`Add ${schema.displayName} account`}
                onClick={() =>
                  setAddingDriverId(addingDriverId === schema.driverId ? null : schema.driverId)
                }
                className="ml-auto flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
              >
                <Plus className="size-4" strokeWidth={2} />
              </button>
            </div>
            <div className="pb-1">
              {accounts.map((instance) => (
                <AccountRow
                  key={instance.id}
                  instance={instance}
                  schema={schema}
                  result={probeResults[instance.id]}
                  probing={probingIds.has(instance.id)}
                  onRemove={handleRemove}
                  onSignIn={handleSignIn}
                  onCheck={(id) => void check(id)}
                />
              ))}
              {addingDriverId === schema.driverId ? (
                <AddAccountForm
                  schema={schema}
                  onSubmit={(input) => void handleAdd(schema, input)}
                  onCancel={() => setAddingDriverId(null)}
                />
              ) : null}
            </div>
          </div>
        );
      })}
      {multiAccountSchemas.length === 0 ? (
        <div className="px-4 py-3 text-[11px] text-muted-foreground">
          No providers with multi-account support are available.
        </div>
      ) : null}
    </div>
  );
}
