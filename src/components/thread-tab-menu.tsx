import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { GitBranch, WarningIcon } from "@phosphor-icons/react";
import { Dropdown, DropdownLabel } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { toast } from "@/components/ui/toast";
import type { Thread, ThreadMoveResult } from "../../contracts/threads.ts";
import { orderWorktreesForDisplay, type Worktree } from "../../contracts/worktrees.ts";
import { normalizeWorkspacePath } from "../../contracts/workspace-scope.ts";

interface ThreadTabMenuProps {
  thread: Thread;
  projectPath: string;
  /** Where the user right-clicked, in viewport pixels. */
  position: { x: number; y: number };
  onClose: () => void;
}

const MENU_WIDTH = 240;

/**
 * A thread tab's right-click menu: move the thread to another workspace of
 * its project. The move runs through the same operation agents use
 * (`threads:move`); a running turn finishes first.
 */
export function ThreadTabMenu({ thread, projectPath, position, onClose }: ThreadTabMenuProps) {
  const [workspaces, setWorkspaces] = useState<Worktree[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = normalizeWorkspacePath(thread.worktree_path, projectPath);

  useEffect(() => {
    let cancelled = false;
    void window.omni.worktrees
      .list(thread.project_id)
      .then((items) => {
        if (!cancelled) setWorkspaces(orderWorktreesForDisplay(items));
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.project_id]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const move = async (workspace: Worktree) => {
    onClose();
    try {
      const result = await window.omni.threads.move({
        threadId: thread.id,
        workspace: workspace.path,
      });
      toast(moveToast(result));
    } catch (error) {
      toast({
        icon: <WarningIcon className="size-5 text-red-500" />,
        title: "Couldn't move the thread",
        description: error instanceof Error ? error.message : "The workspace may be gone.",
      });
    }
  };

  const left = Math.min(position.x, window.innerWidth - MENU_WIDTH - 8);
  return createPortal(
    <div
      ref={menuRef}
      data-pipper-id="thread-tab-menu"
      className="fixed z-[250]"
      style={{ left, top: position.y + 4, width: MENU_WIDTH } as CSSProperties}
    >
      <Dropdown className="w-full">
        <DropdownLabel>Move to workspace</DropdownLabel>
        {workspaces === null ? (
          <DropdownLabel>Loading…</DropdownLabel>
        ) : (
          workspaces.map((workspace, index) => {
            const isCurrent = normalizeWorkspacePath(workspace.path, projectPath) === current;
            return (
              <MenuItem
                key={workspace.path}
                index={index}
                icon={GitBranch}
                label={workspaceLabel(workspace)}
                checked={isCurrent}
                onSelect={isCurrent ? onClose : () => void move(workspace)}
              />
            );
          })
        )}
      </Dropdown>
    </div>,
    document.body,
  );
}

function workspaceLabel(workspace: Worktree): string {
  if (workspace.isProjectRoot) return workspace.workspaceName ?? "main";
  return workspace.workspaceName ?? workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function moveToast(result: ThreadMoveResult) {
  const leftBehind =
    result.leftBehind.length > 0
      ? ` ${result.leftBehind.length} file${result.leftBehind.length === 1 ? "" : "s"} with uncommitted changes stay in the old workspace.`
      : "";
  if (result.status === "after_turn") {
    return {
      icon: <GitBranch weight="duotone" className="size-5 text-muted-foreground" />,
      title: `Moves to ${result.workspace} when its turn ends`,
      description: `The agent finishes its current turn first.${leftBehind}`,
    };
  }
  return {
    icon: <GitBranch weight="duotone" className="size-5 text-muted-foreground" />,
    title: `Moved to ${result.workspace}`,
    description: `From its next turn the agent works in ${result.cwd}.${leftBehind}`,
  };
}
