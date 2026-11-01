import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretUpDown, Folder, GitBranch } from "@phosphor-icons/react";
import type { GitBranch as GitBranchInfo, Worktree } from "../../contracts/worktrees.ts";
import { orderWorktreesForDisplay } from "../../contracts/worktrees.ts";
import type { Project } from "../../contracts/projects.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { worktreeName } from "@/components/composer-worktree-picker";
import { Dropdown } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { cn } from "@/lib/utils";
import { pickThreadWorktree } from "@/lib/worktree-pick";

/** Branch lists longer than this get a filter field. */
const FILTER_THRESHOLD = 8;

/** Home directory shortened to `~`, as a terminal prompt shows it. */
function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, "~");
}

/** The project's worktrees, following creates and deletes from anywhere. */
function useWorktrees(projectId: string): Worktree[] {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      window.omni.worktrees
        .list(projectId)
        .then((items) => !cancelled && setWorktrees(orderWorktreesForDisplay(items)))
        .catch(() => !cancelled && setWorktrees([]));
    void load();
    const unsubscribe = window.omni.worktrees.onChanged((event) => {
      if (event.projectId === projectId) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);
  return worktrees;
}

/**
 * A panel row that opens a menu under it. Closes on a pick, an outside
 * click or Escape.
 */
function MenuRow({
  icon,
  label,
  title,
  disabled,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "group/row -mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] outline-none transition-colors duration-80",
          "hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none",
          open && "bg-hover",
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
        <CaretUpDown
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground opacity-0 transition-opacity duration-80 group-hover/row:opacity-100",
            open && "opacity-100",
          )}
        />
      </button>
      {open ? <div className="absolute inset-x-0 top-full z-[200] mt-1">{children}</div> : null}
    </div>
  );
}

/**
 * Which worktree the thread runs in. Picking one binds a draft to it or moves
 * the live thread there, as the composer's picker does.
 */
export function WorktreeSwitcher({
  project,
  cwd,
  draft,
  threadId,
}: {
  project: Project;
  cwd: string;
  draft: boolean;
  threadId: string | null;
}) {
  const worktrees = useWorktrees(project.id);
  const [open, setOpen] = useState(false);
  const current = normalizeWorkspacePath(cwd, project.path);
  const isCurrent = (worktree: Worktree) =>
    current === null
      ? worktree.isProjectRoot
      : !worktree.isProjectRoot && normalizeWorkspacePath(worktree.path, project.path) === current;
  const checkedIndex = worktrees.findIndex(isCurrent);

  return (
    <MenuRow
      icon={<Folder size={16} />}
      title={`${cwd}\nChange worktree`}
      open={open}
      onOpenChange={setOpen}
      label={
        <>
          {project.name}
          <span className="text-muted-foreground"> · {tildePath(cwd)}</span>
        </>
      }
    >
      <Dropdown
        checkedIndex={checkedIndex === -1 ? undefined : checkedIndex}
        className="w-full max-h-80"
        aria-label="Worktrees"
      >
        {worktrees.map((worktree, index) => (
          <MenuItem
            key={worktree.path}
            index={index}
            label={worktreeName(worktree)}
            description={
              worktree.isProjectRoot ? "Project folder" : (worktree.branch ?? "Detached HEAD")
            }
            checked={isCurrent(worktree)}
            onSelect={() => {
              setOpen(false);
              if (!isCurrent(worktree)) void pickThreadWorktree(worktree, { draft, threadId });
            }}
          />
        ))}
      </Dropdown>
    </MenuRow>
  );
}

/**
 * The branch checked out in the thread's worktree. A free branch is checked
 * out in place; one another worktree holds can't be (git allows a branch in
 * one worktree only), so picking it moves the thread to that worktree.
 */
export function BranchSwitcher({
  project,
  cwd,
  branch,
  draft,
  threadId,
  busy,
  onSwitched,
}: {
  project: Project;
  cwd: string;
  branch: string | null;
  draft: boolean;
  threadId: string | null;
  /** The agent is mid-turn in this worktree; checking out under it would pull files from under its edits. */
  busy: boolean;
  onSwitched: () => void;
}) {
  const worktrees = useWorktrees(project.id);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFilter("");
    window.omni.worktrees
      .listBranches({ projectId: project.id })
      .then((items) => !cancelled && setBranches(items))
      .catch(() => !cancelled && setBranches([]));
    return () => {
      cancelled = true;
    };
  }, [open, project.id]);

  const here = normalizeWorkspacePath(cwd, project.path) ?? project.path;
  const holder = (item: GitBranchInfo): Worktree | null => {
    if (!item.worktreePath) return null;
    const path = normalizeWorkspacePath(item.worktreePath, project.path) ?? project.path;
    if (path === here) return null;
    return (
      worktrees.find(
        (worktree) =>
          (normalizeWorkspacePath(worktree.path, project.path) ?? project.path) === path,
      ) ?? null
    );
  };
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const list = branches ?? [];
    return query ? list.filter((item) => item.name.toLowerCase().includes(query)) : list;
  }, [branches, filter]);

  const choose = async (item: GitBranchInfo) => {
    setOpen(false);
    if (item.name === branch) return;
    const elsewhere = holder(item);
    if (elsewhere) {
      await pickThreadWorktree(elsewhere, { draft, threadId });
      return;
    }
    setSwitching(true);
    try {
      await window.omni.worktrees.switchBranch({
        projectId: project.id,
        path: cwd,
        branch: item.name,
        activate: false,
      });
    } catch (err) {
      toast(errorToast(err instanceof Error ? err.message : "Could not switch branches."));
    } finally {
      setSwitching(false);
      onSwitched();
    }
  };

  const checkedIndex = visible.findIndex((item) => item.name === branch);

  return (
    <MenuRow
      icon={<GitBranch size={16} />}
      title={busy ? "Switch branches after this turn" : "Switch branch"}
      disabled={busy || switching}
      open={open}
      onOpenChange={setOpen}
      label={
        switching ? (
          <span className="text-muted-foreground">Switching…</span>
        ) : (
          (branch ?? <span className="text-muted-foreground">Detached HEAD</span>)
        )
      }
    >
      <Dropdown
        checkedIndex={checkedIndex === -1 ? undefined : checkedIndex}
        className="w-full max-h-80"
        aria-label="Branches"
      >
        {(branches?.length ?? 0) > FILTER_THRESHOLD ? (
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter branches"
            aria-label="Filter branches"
            autoFocus
            className="mx-1 mb-1 mt-1 rounded-md bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none ring-1 ring-border placeholder:text-muted-foreground/60 focus:ring-ring"
          />
        ) : null}
        {branches === null ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">Loading branches…</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">No branches</p>
        ) : (
          visible.map((item, index) => {
            const elsewhere = holder(item);
            return (
              <MenuItem
                key={item.name}
                index={index}
                label={item.name}
                description={elsewhere ? `Checked out in ${worktreeName(elsewhere)}` : undefined}
                checked={item.name === branch}
                onSelect={() => void choose(item)}
              />
            );
          })
        )}
      </Dropdown>
    </MenuRow>
  );
}
