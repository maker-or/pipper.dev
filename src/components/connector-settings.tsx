import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CheckCircleIcon,
  CircleNotch,
  Plus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Elevated } from "@/lib/elevated";
import { cn } from "@/lib/utils";
import { CONNECTOR_LOGOS } from "@/lib/connector-logos";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  connectorCatalogEntry,
  type ConnectorCatalogEntry,
} from "../../contracts/connector-catalog.ts";
import type {
  ConnectorAddInput,
  ConnectorSnapshot,
  ConnectorUpdateInput,
} from "../../contracts/connectors.ts";

export const INPUT_CLASS =
  "h-8 min-w-0 rounded-lg border border-border/70 bg-surface-1 px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-border";

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in main with where they came from.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function without(record: Record<string, string>, id: string): Record<string, string> {
  const next = { ...record };
  delete next[id];
  return next;
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Every tile has the same neutral background; a catalog connector shows its
 * logo on it, anything else its initial.
 */
export function ConnectorTile({
  name,
  catalogId,
  size = "md",
}: {
  name: string;
  catalogId?: string | null;
  /** "lg" for the card in a thread. */
  size?: "md" | "lg";
}) {
  const logo = catalogId ? CONNECTOR_LOGOS[catalogId] : undefined;
  const mark = size === "lg" ? "size-[28px]" : "size-[22px]";
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border border-border/70 bg-surface-3 font-semibold text-muted-foreground",
        size === "lg" ? "size-12 rounded-[14px] text-[18px]" : "size-10 rounded-[12px] text-[15px]",
      )}
    >
      {logo ? (
        <>
          <img
            src={logo.light}
            alt=""
            draggable={false}
            className={cn(mark, "object-contain", logo.dark && "dark:hidden")}
          />
          {logo.dark && (
            <img
              src={logo.dark}
              alt=""
              draggable={false}
              className={cn(mark, "hidden object-contain dark:block")}
            />
          )}
        </>
      ) : (
        name.trim().charAt(0).toUpperCase() || "?"
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Name/value rows for headers and env

interface Pair {
  name: string;
  value: string;
  /** Pipper already has a value for this name; leaving it empty keeps it. */
  saved: boolean;
}

function PairsEditor({
  pairs,
  onChange,
  namePlaceholder,
  addLabel,
}: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  namePlaceholder: string;
  addLabel: string;
}) {
  const set = (index: number, change: Partial<Pair>) =>
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...change } : pair)));
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={pair.name}
            disabled={pair.saved}
            onChange={(event) => set(index, { name: event.target.value })}
            placeholder={namePlaceholder}
            aria-label="Name"
            className={cn(INPUT_CLASS, "w-[40%] font-mono")}
          />
          <input
            value={pair.value}
            type="password"
            autoComplete="off"
            onChange={(event) => set(index, { value: event.target.value })}
            placeholder={pair.saved ? "Saved — leave empty to keep" : "Value"}
            aria-label={`Value of ${pair.name || "this entry"}`}
            className={cn(INPUT_CLASS, "flex-1")}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${pair.name || "this entry"}`}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { name: "", value: "", saved: false }])}
        className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Plus size={12} />
        {addLabel}
      </button>
    </div>
  );
}

function pairsToRecord(pairs: Pair[]): Record<string, string> {
  return Object.fromEntries(
    pairs
      .filter((pair) => pair.name.trim() && (pair.value || pair.saved))
      .map((pair) => [pair.name.trim(), pair.value]),
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-4 text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Forms

/** A custom URL or command, new or being edited. */
function CustomConnectorForm({
  existing,
  onSubmit,
  onCancel,
}: {
  existing?: ConnectorSnapshot;
  onSubmit: (input: ConnectorAddInput | ConnectorUpdateInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<"remote" | "local">(
    existing?.transport === "stdio" ? "local" : "remote",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [command, setCommand] = useState(existing?.command ?? "");
  const [args, setArgs] = useState((existing?.args ?? []).join("\n"));
  const [pairs, setPairs] = useState<Pair[]>(
    (existing?.transport === "stdio" ? existing.envNames : (existing?.headerNames ?? [])).map(
      (saved) => ({ name: saved, value: "", saved: true }),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const values = pairsToRecord(pairs);
    const input: ConnectorAddInput | ConnectorUpdateInput =
      kind === "remote"
        ? existing
          ? { name, url, headers: values }
          : { name, transport: "http", url, headers: values }
        : {
            ...(existing ? {} : { transport: "stdio" as const }),
            name,
            command,
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
            env: values,
          };
    try {
      await onSubmit(input);
    } catch (submitError) {
      setError(errorText(submitError));
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="text-[13px] font-medium text-foreground">
        {existing ? `Edit ${existing.name}` : "Custom connector"}
      </div>
      {!existing && (
        <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5 text-[12px]" role="radiogroup">
          {(
            [
              ["remote", "Remote URL"],
              ["local", "Local command"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => {
                setKind(value);
                setPairs([]);
              }}
              className={cn(
                "flex-1 rounded-md px-2 py-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
                kind === value
                  ? "bg-surface-1 text-foreground shadow-surface-1"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <Field label="Name">
        <input
          autoFocus={!existing}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={kind === "remote" ? "Acme Tracker" : "Postgres"}
          className={INPUT_CLASS}
        />
      </Field>
      {kind === "remote" ? (
        <>
          <Field
            label="URL"
            hint={
              existing
                ? "Changing the URL signs you out of this connector."
                : "Its MCP endpoint. If it asks you to sign in, Pipper opens the page in your browser."
            }
          >
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </Field>
          <Field label="Headers" hint="For a server that takes an API key. Stored encrypted.">
            <PairsEditor
              pairs={pairs}
              onChange={setPairs}
              namePlaceholder="Authorization"
              addLabel="Add header"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Command">
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx"
              spellCheck={false}
              className={cn(INPUT_CLASS, "font-mono")}
            />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <textarea
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-postgres"}
              rows={3}
              spellCheck={false}
              className={cn(INPUT_CLASS, "h-auto py-1.5 font-mono")}
            />
          </Field>
          <Field label="Environment" hint="Stored encrypted and given only to this server.">
            <PairsEditor
              pairs={pairs}
              onChange={setPairs}
              namePlaceholder="API_KEY"
              addLabel="Add variable"
            />
          </Field>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Each thread's agent starts this command on this computer, in the thread's folder, with
            your permissions.
          </p>
        </>
      )}
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={saving}>
          {existing ? "Save" : "Add and connect"}
        </Button>
      </div>
    </form>
  );
}

/** The key for a catalog connector that signs in with one. */
function KeyForm({
  entry,
  replacing,
  onSubmit,
  onCancel,
}: {
  entry: ConnectorCatalogEntry;
  replacing: boolean;
  onSubmit: (key: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (entry.auth.kind !== "key") return null;
  const auth = entry.auth;
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        onSubmit(key).catch((submitError: unknown) => {
          setError(errorText(submitError));
          setSaving(false);
        });
      }}
    >
      <Field
        label={auth.label}
        hint={
          <>
            Stored encrypted; agents never see it.{" "}
            <button
              type="button"
              onClick={() => void window.omni?.shell?.openExternal?.(auth.helpUrl)}
              className="inline-flex items-center gap-0.5 underline underline-offset-4 hover:text-foreground"
            >
              Make one on {entry.name}
              <ArrowSquareOut size={11} />
            </button>
          </>
        }
      >
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className={INPUT_CLASS}
        />
      </Field>
      {error && (
        <p className="text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={saving} disabled={!key.trim()}>
          {replacing ? "Save" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// A connector the user has

/**
 * Connects a remote connector. Only one that may sign in in the browser goes
 * through `connect`; a keyed or open catalog server that refuses is a bad
 * key or a server problem, which a browser sign-in wouldn't fix.
 */
function connectConnector(connector: ConnectorSnapshot): Promise<ConnectorSnapshot> {
  const auth = connectorCatalogEntry(connector.catalogId)?.auth.kind;
  return auth === "key" || auth === "none"
    ? window.omni!.connectors.check(connector.id)
    : window.omni!.connectors.connect(connector.id);
}

function StatusLine({
  connector,
  busy,
  onCancelSignIn,
}: {
  connector: ConnectorSnapshot;
  busy: string | null;
  onCancelSignIn: () => void;
}) {
  const base = "inline-flex items-center gap-1.5 text-[11px] leading-4";
  if (connector.signingIn) {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <CircleNotch size={13} className="animate-spin" />
        Finish signing in to {connector.name} in your browser…
        <button
          type="button"
          onClick={onCancelSignIn}
          className="underline underline-offset-4 hover:text-foreground"
        >
          Cancel
        </button>
      </span>
    );
  }
  if (busy) {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        <CircleNotch size={13} className="animate-spin" />
        {busy}
      </span>
    );
  }
  if (!connector.enabled) return <span className={cn(base, "text-muted-foreground")}>Off</span>;
  if (connector.transport === "stdio") {
    return (
      <span className={cn(base, "text-muted-foreground")}>
        Local · each thread's agent starts it
      </span>
    );
  }
  switch (connector.status) {
    case "connected":
      return (
        <span className={cn(base, "text-foreground")}>
          <CheckCircleIcon size={14} weight="fill" />
          Connected · {connector.tools.length} {connector.tools.length === 1 ? "tool" : "tools"}
        </span>
      );
    case "needs_sign_in":
      return (
        <span className={cn(base, "text-amber-500")}>
          <WarningCircle size={14} weight="fill" />
          {connectorCatalogEntry(connector.catalogId)?.auth.kind === "key"
            ? `${connector.name} didn't accept the key`
            : "Needs sign-in"}
        </span>
      );
    case "error":
      return (
        <span
          className={cn(base, "max-w-full text-amber-500")}
          title={connector.lastError ?? undefined}
        >
          <WarningCircle size={14} weight="fill" className="shrink-0" />
          <span className="truncate">{connector.lastError ?? "Couldn't connect"}</span>
        </span>
      );
    default:
      return <span className={cn(base, "text-muted-foreground")}>Not connected yet</span>;
  }
}

function LinkButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring",
        danger
          ? "text-destructive/80 hover:text-destructive"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ConnectorRow({
  connector,
  busy,
  error,
  run,
  onUpdate,
  onRemove,
}: {
  connector: ConnectorSnapshot;
  busy: string | null;
  error: string | null;
  run: (label: string, work: () => Promise<unknown>) => void;
  onUpdate: (input: ConnectorUpdateInput) => Promise<void>;
  onRemove: () => void;
}) {
  const omni = window.omni!;
  const entry = connectorCatalogEntry(connector.catalogId);
  const [mode, setMode] = useState<"idle" | "tools" | "edit" | "remove">("idle");
  const remote = connector.transport !== "stdio";
  const idle = !busy && !connector.signingIn;
  const signsIn = remote && entry?.auth.kind !== "key" && entry?.auth.kind !== "none";
  const editable = !entry || entry.auth.kind === "key";

  const subtitle = remote
    ? entry
      ? hostOf(connector.url)
      : (connector.url ?? "")
    : [connector.command, ...connector.args].join(" ");

  return (
    <div data-pipper-id={`settings-connector-${connector.id}`}>
      <div className="flex min-h-[76px] items-center gap-4 px-4 py-3">
        <ConnectorTile name={connector.name} catalogId={connector.catalogId} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-foreground">{connector.name}</span>
            <span
              className="truncate font-mono text-[10.5px] text-muted-foreground/80"
              title={subtitle}
            >
              {subtitle}
            </span>
          </div>
          <div className="mt-1 flex min-w-0">
            <StatusLine
              connector={connector}
              busy={busy}
              onCancelSignIn={() => void omni.connectors.cancelSignIn(connector.id)}
            />
          </div>
          {idle && mode !== "edit" && mode !== "remove" && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {connector.enabled && signsIn && connector.status === "needs_sign_in" && (
                <Button
                  type="button"
                  size="sm"
                  variant="tertiary"
                  onClick={() => run("Connecting…", () => omni.connectors.connect(connector.id))}
                >
                  {connector.signedIn ? "Sign in again" : "Sign in"}
                </Button>
              )}
              {connector.enabled &&
                remote &&
                (connector.status === "error" || connector.status === "unknown") && (
                  <Button
                    type="button"
                    size="sm"
                    variant="tertiary"
                    onClick={() => run("Connecting…", () => connectConnector(connector))}
                  >
                    {connector.status === "error" ? "Try again" : "Connect"}
                  </Button>
                )}
              {connector.tools.length > 0 && (
                <button
                  type="button"
                  aria-expanded={mode === "tools"}
                  onClick={() => setMode(mode === "tools" ? "idle" : "tools")}
                  className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                >
                  Tools
                  <CaretDown
                    size={11}
                    className={cn("transition-transform", mode === "tools" && "rotate-180")}
                  />
                </button>
              )}
              {connector.enabled && remote && connector.status === "connected" && (
                <LinkButton
                  onClick={() => run("Checking…", () => omni.connectors.check(connector.id))}
                >
                  Check again
                </LinkButton>
              )}
              {signsIn && connector.signedIn && (
                <LinkButton
                  onClick={() => run("Signing out…", () => omni.connectors.signOut(connector.id))}
                >
                  Sign out
                </LinkButton>
              )}
              {editable && (
                <LinkButton onClick={() => setMode("edit")}>
                  {entry
                    ? `Replace ${entry.auth.kind === "key" ? entry.auth.label.toLowerCase() : "key"}`
                    : "Edit"}
                </LinkButton>
              )}
              <LinkButton danger onClick={() => setMode("remove")}>
                Remove
              </LinkButton>
            </div>
          )}
          {error && idle && (
            <p className="mt-1 text-[11px] leading-4 text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center self-start pt-1.5">
          <Switch
            label={connector.enabled ? `Turn off ${connector.name}` : `Turn on ${connector.name}`}
            checked={connector.enabled}
            disabled={!idle}
            onToggle={() =>
              run(connector.enabled ? "Turning off…" : "Turning on…", async () => {
                const next = await omni.connectors.setEnabled(connector.id, !connector.enabled);
                // Turning a remote one on connects it, so its status is current.
                if (next.enabled && remote) return omni.connectors.check(connector.id);
                return next;
              })
            }
            className="gap-0 px-0 py-0 [&>span:last-of-type]:sr-only"
            data-pipper-id={`settings-connector-switch-${connector.id}`}
          />
        </div>
      </div>

      {mode === "tools" && (
        <ul className="mx-4 mb-3 flex max-h-[220px] flex-col gap-1.5 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2.5">
          {connector.tools.map((tool) => (
            <li key={tool.name} className="text-[11px] leading-4">
              <span className="font-mono text-foreground">{tool.name}</span>
              {tool.description && (
                <span className="line-clamp-2 text-muted-foreground">{tool.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {mode === "remove" && (
        <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2.5">
          <span className="text-[12px] text-foreground">
            Remove {connector.name}?{" "}
            <span className="text-muted-foreground">
              {remote
                ? "Its sign-in is deleted. Threads that have it lose its tools."
                : "Threads that have it lose its tools."}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode("idle")}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" size="sm" onClick={onRemove}>
              Remove
            </Button>
          </span>
        </div>
      )}

      {mode === "edit" &&
        (entry ? (
          <KeyForm
            entry={entry}
            replacing
            onCancel={() => setMode("idle")}
            onSubmit={async (key) => {
              await onUpdate({ key });
              setMode("idle");
            }}
          />
        ) : (
          <div className="border-t border-border/70">
            <CustomConnectorForm
              existing={connector}
              onCancel={() => setMode("idle")}
              onSubmit={async (input) => {
                await onUpdate(input as ConnectorUpdateInput);
                setMode("idle");
              }}
            />
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The catalog

/** How many entries a category shows before "View all": two rows. */
const CATEGORY_PREVIEW = 4;

function CatalogItem({
  entry,
  added,
  adding,
  onConnect,
}: {
  entry: ConnectorCatalogEntry;
  added: boolean;
  adding: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-3 py-2.5"
      title={entry.description}
      data-pipper-id={`settings-connector-catalog-${entry.id}`}
    >
      <ConnectorTile name={entry.name} catalogId={entry.id} />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
        {entry.name}
      </span>
      {added ? (
        <span className="inline-flex items-center gap-1 pr-2 text-[12px] text-muted-foreground">
          <CheckCircleIcon size={14} weight="fill" />
          Added
        </span>
      ) : (
        <Button
          type="button"
          variant="secondary"
          className="rounded-full px-5"
          aria-label={`Connect ${entry.name}`}
          active={adding}
          onClick={onConnect}
        >
          Connect
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section

export function ConnectorSettings() {
  const omni = window.omni;
  const [connectors, setConnectors] = useState<ConnectorSnapshot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** A catalog id waiting for its key, or "custom". */
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const upsert = useCallback((next: ConnectorSnapshot) => {
    setConnectors((current) => {
      const list = current ?? [];
      return list.some((c) => c.id === next.id)
        ? list.map((c) => (c.id === next.id ? next : c))
        : [...list, next].sort((a, b) => a.name.localeCompare(b.name));
    });
  }, []);

  useEffect(() => {
    if (!omni?.connectors) return;
    let live = true;
    omni.connectors
      .list()
      .then((list) => live && setConnectors(list))
      .catch((error: unknown) => live && setLoadError(errorText(error)));
    const off = omni.connectors.onChanged(upsert);
    return () => {
      live = false;
      off();
    };
  }, [omni, upsert]);

  const run = useCallback(
    (id: string, label: string, work: () => Promise<unknown>) => {
      setBusy((current) => ({ ...current, [id]: label }));
      setErrors((current) => without(current, id));
      work()
        .then((result) => {
          if (result && typeof result === "object" && "id" in result) {
            upsert(result as ConnectorSnapshot);
          }
        })
        .catch((error: unknown) => {
          const message = errorText(error);
          if (message.endsWith("The sign-in was cancelled.")) return;
          setErrors((current) => ({ ...current, [id]: message }));
        })
        .finally(() => setBusy((current) => without(current, id)));
    },
    [upsert],
  );

  const add = useCallback(
    async (input: ConnectorAddInput) => {
      if (!omni) return;
      setAddError(null);
      const created = await omni.connectors.add(input);
      upsert(created);
      setAdding(null);
      // Local ones start in each thread; remote ones connect (and sign in) now.
      if (created.transport !== "stdio") {
        run(created.id, "Connecting…", () => connectConnector(created));
      }
    },
    [omni, run, upsert],
  );

  const added = useMemo(
    () => new Set((connectors ?? []).map((c) => c.catalogId).filter(Boolean)),
    [connectors],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!omni?.connectors) {
    return (
      <p className="px-1 text-[12px] text-muted-foreground">Connectors need the desktop app.</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        {connectors === null ? (
          <Elevated offset={1} className="rounded-xl border border-border/70">
            <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
              {loadError ?? "Loading…"}
            </div>
          </Elevated>
        ) : connectors.length === 0 ? (
          <Elevated offset={1} className="rounded-xl border border-border/70">
            <div className="px-4 py-6 text-center text-[12px] leading-5 text-muted-foreground">
              No connectors yet. Add one below and every thread on every agent can use it.
            </div>
          </Elevated>
        ) : (
          <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
            <div className="divide-y divide-border/70">
              {connectors.map((connector) => (
                <ConnectorRow
                  key={connector.id}
                  connector={connector}
                  busy={busy[connector.id] ?? null}
                  error={errors[connector.id] ?? null}
                  run={(label, work) => run(connector.id, label, work)}
                  onUpdate={async (input) => {
                    const updated = await omni.connectors.update(connector.id, input);
                    upsert(updated);
                    if (updated.enabled && updated.transport !== "stdio") {
                      run(updated.id, "Connecting…", () => connectConnector(updated));
                    }
                  }}
                  onRemove={() =>
                    run(connector.id, "Removing…", async () => {
                      await omni.connectors.remove(connector.id);
                      setConnectors((current) =>
                        (current ?? []).filter((c) => c.id !== connector.id),
                      );
                    })
                  }
                />
              ))}
            </div>
          </Elevated>
        )}
        <p className="px-1 text-[11px] leading-4 text-muted-foreground">
          Threads get a connector when their session starts; ones already running keep what they
          had. Your agent still asks before running its tools, as for any MCP tool.
        </p>
      </section>

      {CONNECTOR_CATEGORIES.map((category) => {
        const entries = CONNECTOR_CATALOG.filter((entry) => entry.category === category.id);
        const open = expanded.has(category.id);
        // Keep an entry whose key form is open in view.
        const shown =
          open || entries.length <= CATEGORY_PREVIEW
            ? entries
            : entries.filter((entry, index) => index < CATEGORY_PREVIEW || adding === entry.id);
        return (
          <section key={category.id} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-[13px] font-medium text-foreground">{category.label}</h2>
              {entries.length > CATEGORY_PREVIEW && (
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (open) next.delete(category.id);
                      else next.add(category.id);
                      return next;
                    })
                  }
                  className="text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {open ? "Show less" : "View all"}
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-6">
              {shown.map((entry, index) => {
                // A key form opens under the row its entry is in, across both columns.
                const row = shown.slice(index - (index % 2), index - (index % 2) + 2);
                const rowEnds = index % 2 === 1 || index === shown.length - 1;
                const keyEntry = rowEnds ? row.find((item) => item.id === adding) : undefined;
                return (
                  <Fragment key={entry.id}>
                    <CatalogItem
                      entry={entry}
                      added={added.has(entry.id)}
                      adding={adding === entry.id}
                      onConnect={() => {
                        setAddError(null);
                        if (entry.auth.kind === "key") setAdding(entry.id);
                        else
                          add({ catalogId: entry.id }).catch((error: unknown) =>
                            setAddError(errorText(error)),
                          );
                      }}
                    />
                    {keyEntry && (
                      <div className="col-span-2 mb-2 rounded-xl border border-border/70 bg-surface-2 pt-3">
                        <KeyForm
                          entry={keyEntry}
                          replacing={false}
                          onCancel={() => setAdding(null)}
                          onSubmit={(key) => add({ catalogId: keyEntry.id, key })}
                        />
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="flex flex-col gap-1">
        <h2 className="px-1 text-[13px] font-medium text-foreground">Custom</h2>
        {adding === "custom" ? (
          <Elevated offset={1} className="overflow-hidden rounded-xl border border-border/70">
            <CustomConnectorForm
              onCancel={() => setAdding(null)}
              onSubmit={(input) => add(input as ConnectorAddInput)}
            />
          </Elevated>
        ) : (
          <div className="flex items-center gap-3 py-2.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-[12px] border border-border/70 bg-surface-3 text-muted-foreground">
              <Plus size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-foreground">Custom connector</div>
              <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                Any MCP server: a URL, or a command that runs on this computer.
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="rounded-full px-5"
              onClick={() => setAdding("custom")}
            >
              Add
            </Button>
          </div>
        )}
        {addError && (
          <p className="px-1 text-[11px] text-destructive" role="alert">
            {addError}
          </p>
        )}
      </section>
    </div>
  );
}
