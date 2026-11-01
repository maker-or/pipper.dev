import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CaretRight, GitPullRequest, GithubLogo, PlusMinus } from "@phosphor-icons/react";
import type { ConnectorSnapshot } from "../../contracts/connectors.ts";
import type { WorkspaceGitStatus } from "../../contracts/git.ts";
import type { Project } from "../../contracts/projects.ts";
import { BranchSwitcher, WorktreeSwitcher } from "@/components/session-workspace-switchers";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { formatTokenCount } from "@/lib/format-tokens";
import { cn } from "@/lib/utils";
import { prBlocker, useWorkspaceGitStatus, workspaceGitTone } from "@/lib/workspace-git-status";
import type { HeaderTone } from "@/lib/workspace-tone";
import { WorkspaceStateSurface } from "@/components/workspace-state";
import { useAgentStore } from "@/store/agent-store";
import { useDiffStore } from "@/store/diff-store";
import { useProjectStore } from "@/store/project-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function LineTotals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-500">+{formatCount(additions)}</span>{" "}
      <span className="text-red-400">−{formatCount(deletions)}</span>
    </span>
  );
}

function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0">
      {title ? <h3 className="pb-1 text-[13px] font-medium text-foreground">{title}</h3> : null}
      {children}
    </section>
  );
}

function Row({
  icon,
  children,
  trailing,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  title?: string;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2.5 text-[13px]" title={title}>
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 truncate text-foreground">{children}</div>
      {trailing ? <div className="shrink-0 text-muted-foreground">{trailing}</div> : null}
    </div>
  );
}

/** A section heading that expands its body, with a value on the right. */
function Disclosure({
  label,
  value,
  open,
  onToggle,
  children,
}: {
  label: string;
  value: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border px-4 py-3 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md text-left text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="font-medium text-foreground">{label}</span>
        <CaretRight
          size={10}
          weight="fill"
          className={cn(
            "text-muted-foreground transition-transform duration-80",
            open && "rotate-90",
          )}
        />
        <span className="ml-auto flex items-center gap-2 text-muted-foreground">{value}</span>
      </button>
      {open ? <div className="mt-2 flex flex-col gap-1">{children}</div> : null}
    </section>
  );
}

/** Connectors as main reports them, following changes and removals live. */
function useConnectors(): ConnectorSnapshot[] | null {
  const [connectors, setConnectors] = useState<ConnectorSnapshot[] | null>(null);
  useEffect(() => {
    const api = window.omni?.connectors;
    if (!api) return;
    let live = true;
    api
      .list()
      .then((list) => live && setConnectors(list))
      .catch(() => live && setConnectors([]));
    const offChanged = api.onChanged((next) =>
      setConnectors((current) => {
        const list = current ?? [];
        return list.some((item) => item.id === next.id)
          ? list.map((item) => (item.id === next.id ? next : item))
          : [...list, next].sort((a, b) => a.name.localeCompare(b.name));
      }),
    );
    const offRemoved = api.onRemoved?.((id) =>
      setConnectors((current) => current?.filter((item) => item.id !== id) ?? current),
    );
    return () => {
      live = false;
      offChanged();
      offRemoved?.();
    };
  }, []);
  return connectors;
}

function connectorTone(connector: ConnectorSnapshot): { dot: string; label: string } {
  if (!connector.enabled) return { dot: "bg-muted-foreground/40", label: "Off" };
  switch (connector.status) {
    case "connected":
      return { dot: "bg-emerald-500", label: "Connected" };
    case "needs_sign_in":
      return { dot: "bg-amber-500", label: "Needs sign-in" };
    case "error":
      return { dot: "bg-red-400", label: connector.lastError ?? "Error" };
    default:
      return { dot: "bg-muted-foreground/40", label: "Not checked" };
  }
}

function checksDot(state: WorkspaceGitStatus["checksState"]): string | null {
  switch (state) {
    case "passing":
      return "bg-emerald-500";
    case "failing":
      return "bg-red-400";
    case "pending":
      return "bg-amber-500";
    default:
      return null;
  }
}

export interface SessionWorkspace {
  draft: boolean;
  project: Project | null;
  cwd: string | null;
  threadId: string | null;
  isStreaming: boolean;
  status: WorkspaceGitStatus | null;
  refresh: (force?: boolean) => Promise<void>;
  /** Git-state tone of the workspace, as the advanced shell colors it. */
  tone: HeaderTone;
}

/**
 * The workspace the hybrid shell's displayed thread (or draft) runs in, and
 * its live git status. Owned by the shell, so the git-state tone keeps
 * coloring the project card and composer while the panel is collapsed.
 */
export function useSessionWorkspace(projects: Project[]): SessionWorkspace {
  const draft = useWorkspaceViewStore((state) => state.draft);
  const activeProject = useProjectStore((state) => state.activeProject);
  const threadProjectId = useAgentStore((state) => state.state?.projectId ?? null);
  const threadCwd = useAgentStore((state) => state.state?.cwd ?? null);
  const threadId = useAgentStore((state) => state.state?.threadId ?? null);
  const isStreaming = useAgentStore((state) => state.state?.isStreaming ?? false);
  const editedFileCount = useDiffStore((state) => state.order.length);

  // The panel is thread-specific: a draft has no thread, so no session yet.
  const projectId = draft ? null : threadProjectId;
  const project = useMemo(
    () =>
      projects.find((item) => item.id === projectId) ??
      (activeProject?.id === projectId ? activeProject : null),
    [projects, projectId, activeProject],
  );
  const cwd = draft ? null : threadCwd;
  const { status, refresh } = useWorkspaceGitStatus(project?.id ?? null, cwd);

  // The agent's work moves the workspace: re-read when a turn ends and when
  // it edits another file, rather than waiting for the poll.
  useEffect(() => {
    if (!isStreaming) void refresh();
  }, [isStreaming, refresh]);
  useEffect(() => {
    if (editedFileCount === 0) return;
    const id = setTimeout(() => void refresh(), 750);
    return () => clearTimeout(id);
  }, [editedFileCount, refresh]);

  return {
    draft: draft !== null,
    project,
    cwd,
    threadId,
    isStreaming,
    status,
    refresh,
    tone: status ? workspaceGitTone(status) : "neutral",
  };
}

/**
 * The hybrid shell's right-hand session panel: where the displayed thread (or
 * draft) runs, how full its context is, the connectors its agent can reach,
 * and its workspace's changes and pull request. Every value comes from state
 * Pipper already keeps; a section with nothing to show is left out.
 */
export function SessionPanel({ session }: { session: SessionWorkspace }) {
  const { draft, project, cwd, threadId, isStreaming, status, refresh, tone } = session;
  const threadTitle = useAgentStore((state) => state.state?.title ?? null);
  const usage = useAgentStore((state) => (draft ? null : (state.state?.usage ?? null)));
  const connectors = useConnectors();
  const [contextOpen, setContextOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  if (!project || !cwd) {
    return (
      <p className="px-4 py-3 text-[13px] text-muted-foreground/70">
        Open a thread to see its session.
      </p>
    );
  }

  const git = status?.repoState === "ready" ? status : null;
  const contextPercent =
    usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null;
  const connected = connectors?.filter((item) => item.enabled && item.status === "connected");
  const pr = git?.pr?.state === "open" ? git.pr : null;
  const dirty = git ? git.staged + git.unstaged + git.untracked : 0;
  const onBase = git?.branch != null && git.baseBranch?.replace(/^origin\//, "") === git.branch;
  const canOfferPr = git != null && !pr && !onBase && git.branch != null && git.aheadOfBase > 0;
  // A branch with nothing against its base has no changes row to show.
  const branchLines =
    git?.branchLines && (git.branchLines.additions > 0 || git.branchLines.deletions > 0)
      ? git.branchLines
      : null;
  const blocker = git
    ? (prBlocker(git) ?? (dirty > 0 ? "Commit your changes first; a PR carries commits" : null))
    : null;

  const createPr = async () => {
    if (!git || creatingPr) return;
    setCreatingPr(true);
    try {
      // A PR covers the whole branch: publish local commits first.
      if (!git.upstream || git.ahead > 0) {
        await window.omni.git.push({ projectId: project.id, path: cwd });
      }
      const result = await window.omni.git.createPr({
        projectId: project.id,
        path: cwd,
        title: threadTitle?.trim() || git.branch || project.name,
      });
      if (result.url) void window.omni.shell.openExternal(result.url).catch(() => {});
    } catch (err) {
      toast(errorToast(err instanceof Error ? err.message : "Could not create the PR."));
    } finally {
      await refresh(true);
      setCreatingPr(false);
    }
  };

  return (
    <div className="flex flex-col pb-3" data-pipper-id="session-panel">
      <WorkspaceStateSurface
        tone={tone}
        variant="header"
        className="flex flex-col gap-1 rounded-none border-b border-border px-4 pb-3 pt-3"
        data-pipper-id="session-panel-header"
      >
        <WorktreeSwitcher project={project} cwd={cwd} draft={draft} threadId={threadId} />
        {git?.repository ? <Row icon={<GithubLogo size={16} />}>{git.repository}</Row> : null}
        {git ? (
          <BranchSwitcher
            project={project}
            cwd={cwd}
            branch={git.branch}
            draft={draft}
            threadId={threadId}
            busy={!draft && isStreaming}
            onSwitched={() => void refresh()}
          />
        ) : null}
      </WorkspaceStateSurface>

      {usage && contextPercent !== null ? (
        <Disclosure
          label="Context"
          open={contextOpen}
          onToggle={() => setContextOpen((open) => !open)}
          value={
            <>
              <span className="tabular-nums">{contextPercent}%</span>
              <span
                aria-hidden="true"
                className="h-1.5 w-10 overflow-hidden rounded-full bg-muted-foreground/20"
              >
                <span
                  className="block h-full rounded-full bg-foreground/70"
                  style={{ width: `${contextPercent}%` }}
                />
              </span>
            </>
          }
        >
          <p className="text-[12px] text-muted-foreground">
            {formatTokenCount(usage.used)} of {formatTokenCount(usage.size)} tokens used
          </p>
          {usage.cost ? (
            <p className="text-[12px] text-muted-foreground">
              {usage.cost.amount.toLocaleString(undefined, {
                style: "currency",
                currency: usage.cost.currency,
              })}{" "}
              this session
            </p>
          ) : null}
        </Disclosure>
      ) : null}

      {connectors && connectors.length > 0 ? (
        <Disclosure
          label="Connectors"
          open={connectorsOpen}
          onToggle={() => setConnectorsOpen((open) => !open)}
          value={`${connected?.length ?? 0} connected`}
        >
          {connectors.map((connector) => {
            const tone = connectorTone(connector);
            return (
              <Row
                key={connector.id}
                icon={<span className={cn("size-1.5 rounded-full", tone.dot)} />}
                title={tone.label}
              >
                {connector.name}
              </Row>
            );
          })}
        </Disclosure>
      ) : null}

      {git && (branchLines || pr) ? (
        <Section title="Changes">
          {branchLines ? (
            <Row
              icon={<PlusMinus size={16} />}
              trailing={
                canOfferPr ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={creatingPr || blocker !== null}
                    title={blocker ?? undefined}
                    onClick={() => void createPr()}
                  >
                    {creatingPr ? "Creating…" : "Create PR"}
                  </Button>
                ) : undefined
              }
            >
              <span className="text-muted-foreground">{lastSegment(cwd)}</span>{" "}
              <LineTotals additions={branchLines.additions} deletions={branchLines.deletions} />
            </Row>
          ) : null}
          {pr ? (
            <button
              type="button"
              onClick={() => void window.omni.shell.openExternal(pr.url).catch(() => {})}
              title="Open pull request on GitHub"
              className="-mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-1 text-left text-[13px] outline-none transition-colors duration-80 hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring"
            >
              <GitPullRequest
                size={16}
                className={cn(
                  "mt-0.5 shrink-0",
                  pr.isDraft ? "text-muted-foreground" : "text-emerald-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-foreground">{pr.title}</span>
                <span className="block truncate text-muted-foreground">
                  {git.repository ? `${git.repository.split("/").at(-1)} ` : ""}#{pr.number}
                  {pr.additions != null && pr.deletions != null ? (
                    <>
                      {" "}
                      <LineTotals additions={pr.additions} deletions={pr.deletions} />
                    </>
                  ) : null}
                </span>
              </span>
              {checksDot(git.checksState) ? (
                <span
                  className={cn("mt-2 size-1.5 shrink-0 rounded-full", checksDot(git.checksState))}
                  title={`Checks ${git.checksState}`}
                />
              ) : null}
            </button>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
