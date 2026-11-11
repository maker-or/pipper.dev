import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChatCircleIcon } from "@phosphor-icons/react";
import { useDragReorder, type DragReorder } from "@/components/drag-reorder";
import { SortableTab } from "@/components/sortable-tabs";
import { TabItem, Tabs, TabsList } from "@/components/ui/tabs";

/**
 * The global tab bar's drag, for the spec posters: the real hook, the real
 * SortableTab, TabsList and TabItem, with three fixed thread tabs. The full
 * GlobalTabBar needs the app's stores and IPC, so it isn't mounted here;
 * everything that moves during a drag is the same code.
 */

export const SUBJECT_TABS = [
  { id: "auth", title: "Fix login redirect" },
  { id: "rail", title: "Rail spacing" },
  { id: "notes", title: "Release notes" },
] as const;
const FIRST_ORDER: string[] = SUBJECT_TABS.map((tab) => tab.id);

export interface TabStripController {
  reorder: DragReorder;
  list: HTMLDivElement | null;
  order: readonly string[];
  /** Back to the first order. */
  resetOrder: () => void;
}

export function TabStripSubject({
  controller,
}: {
  controller: RefObject<TabStripController | null>;
}) {
  const [ids, setIds] = useState<string[]>(FIRST_ORDER);
  const listRef = useRef<HTMLDivElement>(null);
  const reorder = useDragReorder({
    axis: "x",
    ids,
    listRef,
    onCommit: (order) => setIds(order),
  });
  // (handed out for the poster's driver: it reads the hook, never writes it)
  useLayoutEffect(() => {
    controller.current = {
      reorder,
      list: listRef.current,
      order: ids,
      resetOrder: () => setIds(FIRST_ORDER),
    };
  });
  const selected = "auth";
  const quiet = reorder.heldId ?? (reorder.liftedIds.includes(selected) ? selected : null);
  return (
    <Tabs value={selected} onValueChange={() => {}}>
      <TabsList ref={listRef} heldValue={quiet} className="gap-1 p-1" data-subject-root>
        {reorder.order.map((id) => {
          const tab = SUBJECT_TABS.find((item) => item.id === id)!;
          return (
            <SortableTab key={id} reorder={reorder} id={id} value={id}>
              <TabItem value={id} label={tab.title} icon={ChatCircleIcon} />
            </SortableTab>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
