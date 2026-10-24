import { CircleNotch, WarningCircle, X } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import {
  setupFailureTitle,
  useWorkspaceSetupStore,
  type WorkspaceSetupEntry,
} from "@/store/workspace-setup-store";

/** One-line setup state on a workspace card; nothing once setup is done. */
export function WorkspaceSetupBadge({ entry }: { entry: WorkspaceSetupEntry | undefined }) {
  if (!entry) return null;
  if (entry.status === "running") {
    return (
      <span
        role="status"
        data-pipper-id="workspace-setup-running"
        className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground"
      >
        <CircleNotch size={11} weight="bold" className="shrink-0 animate-spin" aria-hidden />
        Setting up…
      </span>
    );
  }
  return (
    <span
      data-pipper-id="workspace-setup-failed"
      className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive"
    >
      <WarningCircle size={12} weight="fill" className="shrink-0" aria-hidden />
      Setup failed
    </span>
  );
}

/**
 * Failed workspace setups, across every project, under the conversation.
 * They stay until dismissed: a setup that failed while the user was looking
 * elsewhere still has to be seen, and its output read.
 */
export function WorkspaceSetupFailures({ projects }: { projects: Project[] }) {
  const entries = useWorkspaceSetupStore((state) => state.entries);
  const dismiss = useWorkspaceSetupStore((state) => state.dismiss);
  const failures = Object.values(entries).filter((entry) => entry.status === "failed");
  if (failures.length === 0) return null;
  return (
    <div className="flex max-h-[40%] shrink-0 flex-col overflow-y-auto divide-y divide-border border-t border-border">
      {failures.map((entry) => (
        <SetupFailure
          key={entry.worktreePath}
          entry={entry}
          projectName={projects.find((project) => project.id === entry.projectId)?.name ?? null}
          onDismiss={() => dismiss(entry.worktreePath)}
        />
      ))}
    </div>
  );
}

function SetupFailure({
  entry,
  projectName,
  onDismiss,
}: {
  entry: WorkspaceSetupEntry & { status: "failed" };
  projectName: string | null;
  onDismiss: () => void;
}) {
  const origin =
    entry.source === "script"
      ? "From this project’s setup script — edit it in Settings → Projects."
      : "From the automatic dependency install.";
  return (
    <div
      role="alert"
      data-pipper-id="workspace-setup-failure"
      className="flex gap-2 bg-surface-2 px-3 py-2 text-[12px] text-muted-foreground"
    >
      <WarningCircle weight="duotone" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate">
          <span className="font-medium text-foreground">{setupFailureTitle(entry)}</span>
          <span> in {entry.workspaceName}</span>
          {projectName ? <span className="text-muted-foreground/70"> · {projectName}</span> : null}
        </p>
        <p className="text-[11px] text-muted-foreground/80">{origin}</p>
        <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-muted-foreground">
          {entry.message}
        </pre>
      </div>
      <button
        type="button"
        aria-label={`Dismiss setup error for ${entry.workspaceName}`}
        className="grid size-6 shrink-0 place-items-center rounded-md outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        onClick={onDismiss}
      >
        <X size={13} />
      </button>
    </div>
  );
}
