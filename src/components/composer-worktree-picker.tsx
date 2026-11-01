import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus } from "@phosphor-icons/react";
import type { Worktree } from "../../contracts/worktrees.ts";
import { orderWorktreesForDisplay } from "../../contracts/worktrees.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { Button } from "@/components/ui/button";
import { Elevated } from "@/lib/elevated";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/store/agent-store";

/**
 * Display name for a workspace. The project root has no name of its own, so
 * it goes by the branch it has checked out, which is what the session panel
 * shows too; "main" only when git reports none.
 */
export function worktreeName(worktree: Worktree): string {
  if (worktree.isProjectRoot) return worktree.branch ?? "main";
  return (
    worktree.workspaceName ?? worktree.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"
  );
}

/**
 * Hybrid shell's workspace control, in the composer rail beside the model.
 * The sidebar picks the project; this picks which of its worktrees the
 * composer's thread runs in. What "pick" means (bind a draft, move a live
 * thread) belongs to the caller.
 */
export function ComposerWorktreePicker({
  projectId,
  projectPath,
  currentPath,
  disabled = false,
  onSelect,
}: {
  projectId: string;
  projectPath: string;
  /** The thread's (or draft's) directory; null or the project path for main. */
  currentPath: string | null;
  disabled?: boolean;
  onSelect: (worktree: Worktree) => Promise<void> | void;
}) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [open, setOpen] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Load per project, and follow creates/deletes from anywhere (an agent too).
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      window.omni.worktrees
        .list(projectId)
        .then((items) => {
          if (!cancelled) setWorktrees(orderWorktreesForDisplay(items));
        })
        .catch(() => {
          if (!cancelled) setWorktrees([]);
        });
    void load();
    const unsubscribe = window.omni.worktrees.onChanged((event) => {
      if (event.projectId === projectId) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  // Branches change outside Pipper too (an agent's own `git switch`): re-read
  // on open and when a turn ends, so the label never names a stale branch.
  const turnRunning = useAgentStore((state) => state.state?.isStreaming ?? false);
  useEffect(() => {
    if (!open && turnRunning) return;
    let cancelled = false;
    window.omni.worktrees
      .list(projectId)
      .then((items) => !cancelled && setWorktrees(orderWorktreesForDisplay(items)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, turnRunning, projectId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setIsFormOpen(false);
    setName("");
  };

  const current = normalizeWorkspacePath(currentPath, projectPath);
  const isCurrent = (worktree: Worktree) =>
    current === null
      ? worktree.isProjectRoot
      : !worktree.isProjectRoot && normalizeWorkspacePath(worktree.path, projectPath) === current;
  const selected = worktrees.find(isCurrent) ?? null;
  // Name the workspace from its path until the list loads, never "Workspace".
  const label = selected
    ? worktreeName(selected)
    : current === null
      ? "main"
      : (current.split(/[\\/]/).filter(Boolean).at(-1) ?? "main");

  const pick = async (worktree: Worktree) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await onSelect(worktree);
      close();
    } finally {
      setIsBusy(false);
    }
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || isBusy) return;
    setIsBusy(true);
    let worktree: Worktree;
    try {
      worktree = await window.omni.worktrees.create({ projectId, name: trimmed });
    } catch (err) {
      toast(errorToast(err instanceof Error ? err.message : "Could not create the worktree."));
      setIsBusy(false);
      return;
    }
    setWorktrees((items) =>
      orderWorktreesForDisplay([worktree, ...items.filter((item) => item.path !== worktree.path)]),
    );
    setIsBusy(false);
    await pick(worktree);
  };

  return (
    <div ref={rootRef} className="relative" data-pipper-id="composer-worktree-picker">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Change worktree, currently ${label}`}
        title="Change worktree"
        onClick={() => (open ? close() : setOpen(true))}
        leadingIcon={GitBranch}
        className="max-w-[14rem] text-[12px] text-muted-foreground"
      >
        <span className="block truncate">{label}</span>
      </Button>
      {open ? (
        <Elevated
          offset={2}
          data-pipper-id="composer-worktree-menu"
          className="absolute bottom-full left-0 z-[240] mb-2 w-80 overflow-hidden rounded-xl border border-border p-1.5"
        >
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Worktrees
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {worktrees.map((worktree) => {
              const active = isCurrent(worktree);
              return (
                <button
                  key={worktree.path}
                  type="button"
                  role="menuitem"
                  disabled={active || isBusy}
                  onClick={() => void pick(worktree)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-default",
                    active
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-hover hover:text-foreground",
                  )}
                >
                  <GitBranch weight="duotone" className="size-3.5 shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">
                      {worktreeName(worktree)}
                    </span>
                    <span className="block truncate font-mono text-[10px] opacity-70">
                      {worktree.isProjectRoot
                        ? "Project folder"
                        : (worktree.branch ?? "Detached HEAD")}
                    </span>
                  </span>
                  {active && <span className="size-1.5 rounded-full bg-foreground" />}
                </button>
              );
            })}
          </div>
          <div className="mt-1 border-t border-border/60 pt-1">
            {isFormOpen ? (
              <form
                className="flex gap-1 px-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void create();
                }}
              >
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="New worktree name"
                  aria-label="New worktree name"
                  autoFocus
                  className="min-w-0 flex-1 rounded-md bg-surface-2 px-2 py-1.5 text-[12px] text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-ring"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || isBusy}
                  className="rounded-md bg-foreground px-2 text-[11px] font-medium text-background disabled:opacity-50"
                >
                  {isBusy ? "…" : "Create"}
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                onClick={() => setIsFormOpen(true)}
              >
                <Plus weight="duotone" className="size-3.5" />
                New worktree
              </button>
            )}
          </div>
        </Elevated>
      ) : null}
    </div>
  );
}
