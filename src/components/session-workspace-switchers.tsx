import { useEffect, useState, type ReactNode } from "react";
import { CaretUpDown, GitBranch } from "@phosphor-icons/react";
import { FolderGitIcon } from "@/components/icons/folder-git-icon";
import type { GitBranch as GitBranchInfo, Worktree } from "../../contracts/worktrees.ts";
import { orderWorktreesForDisplay } from "../../contracts/worktrees.ts";
import type { Project } from "../../contracts/projects.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";
import { worktreeName } from "@/components/composer-worktree-picker";
import { toast } from "@/components/ui/toast";
import { errorToast } from "@/lib/error-toast";
import { popupNativeMenu } from "@/lib/native-menu";
import { cn } from "@/lib/utils";
import { pickThreadWorktree } from "@/lib/worktree-pick";

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
 * A panel row that opens an OS menu from itself. The row stays highlighted
 * while the menu is up; a second press while it is opening does nothing.
 */
function MenuRow({
  icon,
  label,
  title,
  disabled,
  onOpen,
}: {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  disabled?: boolean;
  /** Shows the menu; resolves once it has closed. */
  onOpen: (anchor: HTMLElement) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-haspopup="menu"
      aria-expanded={open}
      title={title}
      onClick={(event) => {
        if (open) return;
        const anchor = event.currentTarget;
        setOpen(true);
        void onOpen(anchor)
          .catch((err) =>
            toast(errorToast(err instanceof Error ? err.message : "Could not open the menu.")),
          )
          .finally(() => setOpen(false));
      }}
      className={cn(
        "group/row -mx-1.5 flex min-h-7 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-md px-1.5 text-left text-[13px] outline-none transition-colors duration-80",
        "focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
      <CaretUpDown
        size={12}
        className={cn(
          "shrink-0 text-muted-foreground opacity-0 transition-opacity duration-80 group-hover/row:opacity-100",
          open && "opacity-100",
        )}
      />
    </button>
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
  const current = normalizeWorkspacePath(cwd, project.path);
  const isCurrent = (worktree: Worktree) =>
    current === null
      ? worktree.isProjectRoot
      : !worktree.isProjectRoot && normalizeWorkspacePath(worktree.path, project.path) === current;
  const currentWorktree = worktrees.find(isCurrent) ?? null;
  // The branch row below already names the branch, so the project folder
  // goes by the project's name rather than the branch it has checked out.
  const name =
    current === null
      ? project.name
      : currentWorktree
        ? worktreeName(currentWorktree)
        : (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd);

  const openMenu = async (anchor: HTMLElement) => {
    const picked = await popupNativeMenu(
      anchor,
      worktrees.map((worktree) => ({
        type: "item",
        id: worktree.path,
        label: worktreeName(worktree),
        sublabel: worktree.isProjectRoot ? "Project folder" : (worktree.branch ?? "Detached HEAD"),
        checked: isCurrent(worktree),
      })),
    );
    const worktree = worktrees.find((item) => item.path === picked);
    if (worktree && !isCurrent(worktree)) await pickThreadWorktree(worktree, { draft, threadId });
  };

  return (
    <MenuRow
      icon={<FolderGitIcon size={16} />}
      title={`${tildePath(cwd)}\nChange worktree`}
      disabled={worktrees.length === 0}
      onOpen={openMenu}
      label={name}
    />
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
  const [switching, setSwitching] = useState(false);

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

  const choose = async (item: GitBranchInfo) => {
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

  // Branches are read fresh each time, so ones made elsewhere show up.
  const openMenu = async (anchor: HTMLElement) => {
    const branches = await window.omni.worktrees.listBranches({ projectId: project.id });
    if (branches.length === 0) return;
    const picked = await popupNativeMenu(
      anchor,
      branches.map((item) => {
        const elsewhere = holder(item);
        return {
          type: "item",
          id: item.name,
          label: item.name,
          sublabel: elsewhere ? `Checked out in ${worktreeName(elsewhere)}` : undefined,
          checked: item.name === branch,
        };
      }),
    );
    const item = branches.find((candidate) => candidate.name === picked);
    if (item) await choose(item);
  };

  return (
    <MenuRow
      icon={<GitBranch size={16} weight="duotone" />}
      title={busy ? "Switch branches after this turn" : "Switch branch"}
      disabled={busy || switching}
      onOpen={openMenu}
      label={
        switching ? (
          <span className="text-muted-foreground">Switching…</span>
        ) : (
          (branch ?? <span className="text-muted-foreground">Detached HEAD</span>)
        )
      }
    />
  );
}
