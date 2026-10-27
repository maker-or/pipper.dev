import { memo, useMemo, useRef, useState, type CSSProperties } from "react";
import { CodeView, WorkerPoolContextProvider } from "@pierre/diffs/react";
import { parseDiffFromFile, type CodeViewDiffItem } from "@pierre/diffs";
import type { DiffFileEntry } from "@/store/diff-store";
import { RowsIcon, ColumnsIcon } from "@phosphor-icons/react";
import { useDiffStore } from "@/store/diff-store";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { Elevated } from "@/lib/elevated";
import { workerFactory } from "@/lib/diff-worker";
import { CODE_HIGHLIGHTER_OPTIONS, CODE_THEMES } from "@/lib/code-highlighting";

// The library's own theme layer re-declares --diffs-bg/-fg (and the
// color-mix()'d variants derived from them) after our light/dark overrides,
// so pin them from the highest-priority "unsafe" CSS layer instead of
// fighting the cascade with plain custom properties.
const DIFF_UNSAFE_CSS = `
  :host {
    --diffs-bg: var(--surface-2) !important;
    --diffs-bg-buffer: var(--surface-2) !important;
    --diffs-bg-context: var(--surface-2) !important;
    --diffs-bg-context-gutter: var(--surface-2) !important;
    --diffs-bg-separator: var(--surface-2) !important;
    --diffs-fg: var(--foreground) !important;
  }
`;

// No props: reads everything from stores directly. Memoized so it doesn't
// re-render (and thrash CodeView's scroll) every time OthersView re-renders
// for unrelated reasons — e.g. a background terminal streaming PTY output.
export const DiffView = memo(function DiffView() {
  const files = useDiffStore((state) => state.files);
  const order = useDiffStore((state) => state.order);
  const [layout, setLayout] = useState<"split" | "unified">("split");
  const { resolvedTheme } = useTheme();

  // Cache parsed diffs per path so a change to one file doesn't force every
  // other item to be recomputed and handed to CodeView as a new object —
  // that churn is what was thrashing the virtualizer's scroll position.
  const itemCacheRef = useRef<Map<string, { entry: DiffFileEntry; item: CodeViewDiffItem }>>(
    new Map(),
  );

  // Stack every changed file (across every turn), not just the most recently
  // touched one — an agent that edits file A then file B should still show
  // both, not have B replace A.
  const items: CodeViewDiffItem[] = useMemo(() => {
    const cache = itemCacheRef.current;
    const nextCache = new Map<string, { entry: DiffFileEntry; item: CodeViewDiffItem }>();
    const result = order
      .map((path) => files[path])
      .filter((file): file is DiffFileEntry => Boolean(file))
      .map((file) => {
        const cached = cache.get(file.path);
        if (cached && cached.entry === file) {
          nextCache.set(file.path, cached);
          return cached.item;
        }
        const item: CodeViewDiffItem = {
          id: file.path,
          type: "diff" as const,
          // CodeView does targeted updates keyed off this version; it must
          // change whenever the item's content changes.
          version: file.updatedAt,
          fileDiff: parseDiffFromFile(
            {
              name: file.path,
              contents: file.oldText,
              cacheKey: `${file.path}:${file.updatedAt}`,
            },
            {
              name: file.path,
              contents: file.newText,
              cacheKey: `${file.path}:${file.updatedAt}`,
            },
          ),
        };
        nextCache.set(file.path, { entry: file, item });
        return item;
      });
    itemCacheRef.current = nextCache;
    return result;
  }, [order, files]);

  // Keep non-primitive props stable across renders (per the docs): the options
  // object is recreated only when its inputs change, not on every render.
  const options = useMemo(
    () => ({
      diffStyle: layout,
      theme: CODE_THEMES,
      themeType: resolvedTheme,
      unsafeCSS: DIFF_UNSAFE_CSS,
      stickyHeaders: true,
    }),
    [layout, resolvedTheme],
  );

  if (order.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[13px] text-muted-foreground">
        No file changes yet.
      </div>
    );
  }

  return (
    <Elevated
      offset={1}
      className="flex h-full w-full min-h-0 rounded-none"
      style={
        {
          "--diffs-font-family": "var(--font-mono)",
          colorScheme: resolvedTheme,
        } as CSSProperties
      }
    >
      <div data-pipper-id="diff-view" className="flex min-h-0 flex-1 flex-col ">
        <div className="flex h-9 shrink-0 items-center justify-between rounded-2xl px-3">
          <span className="truncate text-[12px] text-muted-foreground">
            {order.length} file{order.length === 1 ? "" : "s"} changed
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              active={layout === "split"}
              title="Split view"
              onClick={() => setLayout("split")}
            >
              <ColumnsIcon size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              active={layout === "unified"}
              title="Stacked view"
              onClick={() => setLayout("unified")}
            >
              <RowsIcon size={14} />
            </Button>
          </div>
        </div>
        {/* CodeView attaches its scroll listener directly to the div it
            renders (via `className`), so that same element — not a wrapping
            ancestor — must own the bounded height + overflow-y. */}
        <div className="min-h-0 flex-1">
          <WorkerPoolContextProvider
            poolOptions={{ workerFactory }}
            highlighterOptions={CODE_HIGHLIGHTER_OPTIONS}
          >
            <CodeView items={items} options={options} className="h-full w-full overflow-y-auto" />
          </WorkerPoolContextProvider>
        </div>
      </div>
    </Elevated>
  );
});
