import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Reorder } from "framer-motion";
import { ArrowDown, ArrowUp, Trash } from "@phosphor-icons/react";
import type { Project } from "../../contracts/projects.ts";
import { ProjectTile } from "@/components/project-tile";
import { toast } from "@/components/ui/toast";
import { Elevated } from "@/lib/elevated";
import { errorToast } from "@/lib/error-toast";
import { moveItem, RAIL_TILE_HEIGHT, railSlotHeight } from "@/lib/project-order";
import { ScrollEdgeCue, useScrollEdges } from "@/lib/scroll-fade";
import type { HeaderTone } from "@/lib/workspace-tone";

const MENU_WIDTH = 176;

/** A single project in the rail, with its right-click menu. */
function ProjectCard({
  project,
  selected,
  tone,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMove,
  onDelete,
}: {
  project: Project;
  selected: boolean;
  /** Git-state tone of the displayed thread's workspace, shown when selected. */
  tone: HeaderTone;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuOpen = menuPosition !== null;
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!cardRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setMenuPosition(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuPosition(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const menuItem = (label: string, icon: React.ReactNode, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={
        danger
          ? "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-destructive"
          : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-foreground"
      }
      onClick={() => {
        setMenuPosition(null);
        run();
      }}
    >
      {icon} {label}
    </button>
  );

  return (
    <ProjectTile
      rootRef={cardRef}
      project={project}
      selected={selected}
      tone={tone}
      onClick={() => {
        setMenuPosition(null);
        onSelect();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        // The menu key and Shift+F10 open it with no pointer position.
        if (event.clientX === 0 && event.clientY === 0) {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition({ x: rect.left, y: rect.bottom + 6 });
          return;
        }
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {menuPosition &&
        createPortal(
          <Elevated
            ref={menuRef}
            offset={2}
            role="menu"
            data-pipper-id="project-context-menu"
            className="fixed z-[500] w-44 rounded-lg border border-border p-1"
            style={{
              left: Math.max(8, Math.min(menuPosition.x, window.innerWidth - MENU_WIDTH - 8)),
              top: Math.max(8, Math.min(menuPosition.y, window.innerHeight - 112)),
            }}
          >
            {canMoveUp && menuItem("Move up", <ArrowUp size={14} />, () => onMove(-1))}
            {canMoveDown && menuItem("Move down", <ArrowDown size={14} />, () => onMove(1))}
            {menuItem("Delete project", <Trash size={14} />, onDelete, true)}
          </Elevated>,
          document.body,
        )}
    </ProjectTile>
  );
}

/**
 * The project rail: one tile per project in the saved order. Drag a tile to
 * move it, or use Move up / Move down in its right-click menu; the order is saved
 * when the drag ends. If saving fails, the rail reloads the saved order.
 * It fills the rail's height with 5–6 projects and scrolls the rest, with
 * edge cues where there's more, and keeps the selected project in view.
 */
export function ProjectRail({
  projects,
  onProjectsChange,
  selectedId,
  tone,
  onOpen,
  onDelete,
}: {
  projects: Project[];
  onProjectsChange: (projects: Project[]) => void;
  selectedId: string | null;
  tone: HeaderTone;
  onOpen: (project: Project) => void;
  onDelete: (project: Project) => void;
}) {
  // The order a drag has produced, saved when the drag ends.
  const pendingOrder = useRef<Project[] | null>(null);
  // A drag ends with a click on the tile under the pointer; don't open it.
  const suppressClick = useRef(false);
  // Only the latest save may restore the list after a failure.
  const saveSeq = useRef(0);

  const save = (order: Project[]) => {
    const seq = ++saveSeq.current;
    window.omni.projects.reorder(order.map((project) => project.id)).catch((err: unknown) => {
      if (seq !== saveSeq.current) return;
      toast(errorToast(err instanceof Error ? err.message : "Could not save the project order."));
      void window.omni.projects
        .list()
        .then((saved) => {
          if (seq === saveSeq.current) onProjectsChange(saved);
        })
        .catch(() => {});
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    const next = moveItem(projects, index, index + delta);
    onProjectsChange(next);
    save(next);
  };

  const scrollerRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scrollerRef);
  const [slotHeight, setSlotHeight] = useState(RAIL_TILE_HEIGHT);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSlotHeight(railSlotHeight(entry.contentRect.height));
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Opening a project from elsewhere (a link, the launcher) scrolls it in.
  useEffect(() => {
    if (!selectedId) return;
    scrollerRef.current
      ?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <Reorder.Group
      ref={scrollerRef}
      as="div"
      axis="y"
      values={projects}
      onReorder={(next: Project[]) => {
        pendingOrder.current = next;
        onProjectsChange(next);
      }}
      // The list is its own scroller; layoutScroll keeps drag positions right
      // after it has scrolled.
      layoutScroll
      className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none]"
    >
      <ScrollEdgeCue edge="top" visible={edges.top} size="tight" inset={0} />
      {projects.map((project, index) => (
        <Reorder.Item
          as="div"
          key={project.id}
          value={project}
          data-project-id={project.id}
          className="relative flex shrink-0 flex-col justify-center"
          style={{ height: slotHeight }}
          whileDrag={{ scale: 1.06, zIndex: 10 }}
          onDragStart={() => {
            suppressClick.current = true;
          }}
          onDragEnd={() => {
            // The click that ends a drag fires before the next frame.
            requestAnimationFrame(() => {
              suppressClick.current = false;
            });
            if (pendingOrder.current) save(pendingOrder.current);
            pendingOrder.current = null;
          }}
          onClickCapture={(event) => {
            if (!suppressClick.current) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <ProjectCard
            project={project}
            selected={project.id === selectedId}
            tone={tone}
            canMoveUp={index > 0}
            canMoveDown={index < projects.length - 1}
            onSelect={() => onOpen(project)}
            onMove={(delta) => move(index, delta)}
            onDelete={() => onDelete(project)}
          />
        </Reorder.Item>
      ))}
      <ScrollEdgeCue edge="bottom" visible={edges.bottom} size="tight" inset={0} />
    </Reorder.Group>
  );
}
