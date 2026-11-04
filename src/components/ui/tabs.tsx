"use client";

import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  createContext,
  useContext,
  forwardRef,
  Children,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ComponentPropsWithoutRef,
} from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { motion, AnimatePresence } from "framer-motion";
import type { IconComponent } from "@/lib/icon-context";
import { cn } from "@/lib/utils";
import { springs } from "@/lib/springs";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { useProximityHover } from "@/hooks/use-proximity-hover";
import { X } from "@phosphor-icons/react";

/* ─────────────────────── Contexts ─────────────────────── */

interface TabsValueOrderContextValue {
  valueOrder: string[];
  setValueOrder: (order: string[]) => void;
  selectedValue: string | undefined;
  isControlled: boolean;
}

const TabsValueOrderContext = createContext<TabsValueOrderContextValue | null>(null);

interface TabsListContextValue {
  registerTab: (index: number, value: string, el: HTMLElement | null) => void;
  hoveredIndex: number | null;
  selectedValue: string | undefined;
  setOptimisticIdx: (index: number) => void;
  isControlled: boolean;
}

const TabsListContext = createContext<TabsListContextValue | null>(null);

function useTabsList() {
  const ctx = useContext(TabsListContext);
  if (!ctx) throw new Error("TabItem must be used within a TabsList");
  return ctx;
}

/* ─────────────────────── Tabs (Root) ─────────────────────── */

interface TabsProps extends Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Root>,
  "onValueChange" | "value" | "defaultValue" | "onSelect"
> {
  value?: string;
  onValueChange?: (value: string) => void;
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  defaultValue?: string;
}

const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  ({ value, onValueChange, selectedIndex, onSelect, defaultValue, children, ...props }, ref) => {
    const [valueOrder, setValueOrder] = useState<string[]>([]);
    const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(defaultValue);
    const updateValueOrder = useCallback((order: string[]) => {
      setValueOrder((current) => {
        if (current.length === order.length && current.every((v, i) => v === order[i])) {
          return current;
        }
        return order;
      });
    }, []);

    const resolvedValue =
      value ?? (selectedIndex != null ? valueOrder[selectedIndex] : uncontrolledValue);
    const isControlled = value !== undefined || selectedIndex != null;

    // Base UI passes (value, eventDetails); we only need value.
    const handleValueChange = useCallback(
      (newValue: unknown) => {
        const v = newValue as string;
        if (value === undefined && selectedIndex == null) {
          setUncontrolledValue(v);
        }
        onValueChange?.(v);
        if (onSelect) {
          const idx = valueOrder.indexOf(v);
          if (idx !== -1) onSelect(idx);
        }
      },
      [onValueChange, onSelect, valueOrder, value, selectedIndex],
    );

    return (
      <TabsValueOrderContext.Provider
        value={{
          valueOrder,
          setValueOrder: updateValueOrder,
          selectedValue: resolvedValue,
          isControlled,
        }}
      >
        <TabsPrimitive.Root
          ref={ref}
          value={resolvedValue}
          onValueChange={handleValueChange}
          defaultValue={resolvedValue == null ? defaultValue : undefined}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </TabsValueOrderContext.Provider>
    );
  },
);

Tabs.displayName = "Tabs";

/* ─────────────────────── TabsList ─────────────────────── */

type TabsListProps = ComponentPropsWithoutRef<typeof TabsPrimitive.List>;

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const isMouseInside = useRef(false);
    const shape = useShape();
    const valueOrderCtx = useContext(TabsValueOrderContext);
    const [optimisticIdx, setOptimisticIdx] = useState<number | null>(null);

    const values = Children.toArray(children)
      .filter(isValidElement)
      .map((child) => (child.props as { value?: string }).value)
      .filter((v): v is string => typeof v === "string");
    const valueOrderKey = values.join(",");
    const setValueOrder = valueOrderCtx?.setValueOrder;

    useLayoutEffect(() => {
      setValueOrder?.(values);
    }, [setValueOrder, valueOrderKey]);

    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects,
      handlers,
      registerItem,
      measureItems,
    } = useProximityHover(containerRef, { axis: "x" });

    const registerTab = useCallback(
      (index: number, _value: string, el: HTMLElement | null) => {
        registerItem(index, el);
      },
      [registerItem],
    );

    useEffect(() => {
      measureItems();
    }, [measureItems, children]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => measureItems());
      ro.observe(el);
      return () => ro.disconnect();
    }, [measureItems]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        isMouseInside.current = true;
        handlers.onMouseMove(e);
      },
      [handlers],
    );

    const handleMouseLeave = useCallback(() => {
      isMouseInside.current = false;
      handlers.onMouseLeave();
    }, [handlers]);

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const selectedValue = valueOrderCtx?.selectedValue;
    const isControlled = valueOrderCtx?.isControlled ?? false;
    const selectedIdx = selectedValue !== undefined ? values.indexOf(selectedValue) : -1;

    useEffect(() => {
      setOptimisticIdx(selectedIdx >= 0 ? selectedIdx : null);
    }, [selectedIdx]);

    const activeSelectedIdx = optimisticIdx;
    const selectedRect = activeSelectedIdx !== null ? itemRects[activeSelectedIdx] : null;
    const hoverRect = hoveredIndex !== null ? itemRects[hoveredIndex] : null;
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const isHoveringSelected = hoveredIndex === activeSelectedIdx;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;

    const indexedChildren = Children.map(children, (child, i) => {
      if (isValidElement(child)) {
        return cloneElement(child, { _index: i } as Record<string, unknown>);
      }
      return child;
    });

    return (
      <TabsListContext.Provider
        value={{
          registerTab,
          hoveredIndex,
          selectedValue,
          setOptimisticIdx,
          isControlled,
        }}
      >
        <TabsPrimitive.List
          // Match Radix's `activationMode="automatic"` — arrow keys move + activate.
          activateOnFocus
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onFocus={(e) => {
            const trigger = (e.target as HTMLElement).closest('[role="tab"]');
            if (!trigger) return;
            const indexAttr = trigger.getAttribute("data-proximity-index");
            if (indexAttr != null) {
              const idx = Number(indexAttr);
              setHoveredIndex(idx);
              setFocusedIndex((e.target as HTMLElement).matches(":focus-visible") ? idx : null);
            }
          }}
          onBlur={(e) => {
            if (containerRef.current?.contains(e.relatedTarget as Node)) return;
            setFocusedIndex(null);
            if (isMouseInside.current) return;
            setHoveredIndex(null);
          }}
          className={cn(
            "relative inline-flex items-center gap-0.5 p-1 select-none bg-muted overflow-x-auto overflow-y-visible",
            shape.container,
            className,
          )}
          {...props}
        >
          {/* Active segment indicator */}
          {selectedRect && (
            <motion.div
              className={cn(
                "absolute pointer-events-none z-0 border border-border/60 bg-surface-4",
                "shadow-surface-3",
                shape.bg,
              )}
              initial={false}
              animate={{
                left: selectedRect.left,
                width: selectedRect.width,
                top: selectedRect.top,
                height: selectedRect.height,
                opacity: isHovering ? 0.85 : 1,
              }}
              transition={{
                ...springs.moderate,
                opacity: { duration: 0.08 },
              }}
            />
          )}

          {/* Hover indicator */}
          <AnimatePresence>
            {hoverRect && !isHoveringSelected && selectedRect && (
              <motion.div
                className={cn("absolute pointer-events-none bg-hover", shape.bg)}
                initial={{
                  left: selectedRect.left,
                  width: selectedRect.width,
                  top: selectedRect.top,
                  height: selectedRect.height,
                  opacity: 0,
                }}
                animate={{
                  left: hoverRect.left,
                  width: hoverRect.width,
                  top: hoverRect.top,
                  height: hoverRect.height,
                  opacity: 0.4,
                }}
                exit={
                  !isMouseInside.current && selectedRect
                    ? {
                        left: selectedRect.left,
                        width: selectedRect.width,
                        top: selectedRect.top,
                        height: selectedRect.height,
                        opacity: 0,
                        transition: {
                          ...springs.moderate,
                          opacity: { duration: 0.06 },
                        },
                      }
                    : { opacity: 0, transition: { duration: 0.06 } }
                }
                transition={{
                  ...springs.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {/* Focus ring */}
          <AnimatePresence>
            {focusRect && (
              <motion.div
                className={cn(
                  "absolute pointer-events-none z-20 border border-[#6B97FF]",
                  shape.focusRing,
                )}
                initial={false}
                animate={{
                  left: focusRect.left - 2,
                  top: focusRect.top - 2,
                  width: focusRect.width + 4,
                  height: focusRect.height + 4,
                }}
                exit={{ opacity: 0, transition: { duration: 0.06 } }}
                transition={{
                  ...springs.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {indexedChildren}
        </TabsPrimitive.List>
      </TabsListContext.Provider>
    );
  },
);

TabsList.displayName = "TabsList";

/* ─────────────────────── TabItem ─────────────────────── */

interface TabItemProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Tab> {
  value: string;
  icon?: IconComponent;
  label: string;
  onClose?: () => void;
  editing?: boolean;
  editValue?: string;
  onEditValueChange?: (value: string) => void;
  onEditCommit?: () => boolean | Promise<boolean>;
  onEditCancel?: () => void;
  /** Keeps the label to a fixed width and reveals overflow while hovered. */
  scrollLabelOnHover?: boolean;
  /**
   * Icon-only tab. The label stays on `aria-label` / `title` so the tab is
   * still named for hover and assistive tech.
   */
  iconOnly?: boolean;
  /** An amber dot on the icon: something in this tab waits on the user. */
  attention?: boolean;
  /** @internal Auto-assigned by TabsList. */
  _index?: number;
}

const TabItem = forwardRef<HTMLButtonElement, TabItemProps>(
  (
    {
      value,
      icon: Icon,
      label,
      onClose,
      editing = false,
      editValue = "",
      onEditValueChange,
      onEditCommit,
      onEditCancel,
      scrollLabelOnHover = false,
      iconOnly = false,
      attention = false,
      _index = 0,
      className,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLButtonElement>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    const labelViewportRef = useRef<HTMLSpanElement>(null);
    const labelTextRef = useRef<HTMLSpanElement>(null);
    const editActionRef = useRef<"submit" | "cancel" | null>(null);
    const [labelOverflow, setLabelOverflow] = useState(0);
    const { registerTab, hoveredIndex, selectedValue, setOptimisticIdx } = useTabsList();

    useEffect(() => {
      registerTab(_index, value, internalRef.current);
      return () => registerTab(_index, value, null);
    }, [_index, value, registerTab]);

    useEffect(() => {
      if (!editing) return;
      editActionRef.current = null;
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }, [editing]);

    useLayoutEffect(() => {
      if (!scrollLabelOnHover) return;
      const viewport = labelViewportRef.current;
      const text = labelTextRef.current;
      if (!viewport || !text) return;

      const measureOverflow = () => {
        const nextOverflow = Math.max(0, text.scrollWidth - viewport.clientWidth);
        setLabelOverflow((current) =>
          Math.abs(current - nextOverflow) < 1 ? current : nextOverflow,
        );
      };

      measureOverflow();
      // A tab can mount while its ancestor is hidden (e.g. a not-yet-active
      // panel) or before the variable webfont finishes swapping in, both of
      // which make the initial scrollWidth/clientWidth read as 0 or wrong.
      // Re-measure once the next frame lands and once webfonts settle; the
      // ResizeObserver below keeps it correct after that.
      const raf = requestAnimationFrame(measureOverflow);
      const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
      fonts?.ready?.then(measureOverflow).catch(() => {});

      const observer = new ResizeObserver(measureOverflow);
      observer.observe(viewport);
      observer.observe(text);
      return () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
      };
    }, [label, scrollLabelOnHover]);

    const isSelected = selectedValue === value;
    const isActive = hoveredIndex === _index || isSelected;

    return (
      <TabsPrimitive.Tab
        onClick={() => {
          setOptimisticIdx(_index);
        }}
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLElement | null>).current =
            node as HTMLButtonElement | null;
          if (typeof ref === "function") ref(node as HTMLButtonElement);
          else if (ref)
            (ref as React.MutableRefObject<HTMLButtonElement | null>).current =
              node as HTMLButtonElement | null;
        }}
        value={value}
        data-proximity-index={_index}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        className={cn(
          // Named group (`group/tab`) so hover styles inside respond to THIS
          // tab only — a bare `group` would also match any `.group` ancestor
          // elsewhere in the layout, animating every label at once.
          "relative z-10 flex shrink-0 items-center cursor-pointer bg-transparent border-none outline-none group/tab",
          iconOnly ? "gap-0 px-2 py-1.5" : "gap-2 px-3 py-1.5",
          className,
        )}
        {...props}
      >
        {Icon && (
          <span className="relative flex shrink-0">
            <Icon
              size={16}
              strokeWidth={isActive ? 2 : 1.5}
              className={cn(
                "transition-[color,stroke-width] duration-80",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
            />
            {attention && (
              <span
                data-pipper-id="tab-attention"
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-amber-500 ring-1 ring-background"
              />
            )}
          </span>
        )}
        {iconOnly && !editing ? null : editing ? (
          <input
            ref={editInputRef}
            value={editValue}
            onChange={(event) => onEditValueChange?.(event.target.value)}
            onBlur={() => {
              if (editActionRef.current) {
                editActionRef.current = null;
                return;
              }
              void (async () => {
                const committed = await onEditCommit?.();
                if (committed === false) {
                  editInputRef.current?.focus();
                  editInputRef.current?.select();
                }
              })();
            }}
            onKeyDown={(event) => {
              const input = event.currentTarget;
              if (event.key === "Enter") {
                event.preventDefault();
                void (async () => {
                  const committed = await onEditCommit?.();
                  if (committed === false) {
                    editInputRef.current?.focus();
                    editInputRef.current?.select();
                    return;
                  }
                  editActionRef.current = "submit";
                  input.blur();
                })();
              } else if (event.key === "Escape") {
                event.preventDefault();
                editActionRef.current = "cancel";
                onEditCancel?.();
                input.blur();
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={cn(
              "min-w-0 w-[16ch] max-w-56 bg-transparent border-none p-0 outline-none",
              "text-[13px] leading-none text-foreground",
            )}
          />
        ) : scrollLabelOnHover ? (
          <span
            ref={labelViewportRef}
            className={cn(
              // max-width (not fixed width) keeps short titles snug while
              // still capping long ones at a consistent 15ch viewport.
              "inline-block max-w-[15ch] overflow-hidden text-[13px] whitespace-nowrap align-middle",
              // Overflowing labels fade out at the right edge instead of
              // hard-clipping; the fade lifts on hover so the scroll reveals
              // the full label.
              labelOverflow > 0 &&
                "[mask-image:linear-gradient(to_right,black_calc(100%_-_12px),transparent_100%)] group-hover/tab:[mask-image:none]",
            )}
            title={label}
          >
            <span
              ref={labelTextRef}
              className={cn(
                "inline-block w-max transition-[color,font-variation-settings] duration-80",
                labelOverflow > 0 &&
                  "group-hover/tab:animate-[tab-label-scroll_2.4s_ease-in-out_350ms_infinite_alternate]",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
              style={
                {
                  fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
                  "--tab-label-scroll-distance": `-${labelOverflow}px`,
                } as CSSProperties
              }
            >
              {label}
            </span>
          </span>
        ) : (
          <span className="inline-grid text-[13px] whitespace-nowrap">
            <span
              className="col-start-1 row-start-1 invisible"
              style={{ fontVariationSettings: fontWeights.semibold }}
              aria-hidden="true"
            >
              {label}
            </span>
            <span
              className={cn(
                "col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80",
                isActive ? "text-foreground" : "text-muted-foreground",
              )}
              style={{
                fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
              }}
            >
              {label}
            </span>
          </span>
        )}
        {onClose && !editing && (
          <span
            role="button"
            tabIndex={0}
            onPointerDown={(e) => {
              // Radix Tabs selects the parent tab during pointer-down. Stop
              // that interaction here so closing an inactive tab does not
              // activate and load it first.
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                onClose();
              }
            }}
            className={cn(
              "relative z-20 ml-1 flex size-4 items-center justify-center rounded-full border-none bg-transparent text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-neutral-200/50 hover:text-foreground dark:hover:bg-neutral-800/50 cursor-pointer",
              isSelected
                ? "opacity-100 scale-100 pointer-events-auto"
                : "opacity-0 scale-75 pointer-events-none group-hover/tab:opacity-100 group-hover/tab:scale-100 group-hover/tab:pointer-events-auto",
            )}
            title="Close Tab"
          >
            <X size={12} />
          </span>
        )}
      </TabsPrimitive.Tab>
    );
  },
);

TabItem.displayName = "TabItem";

/* ─────────────────────── TabPanel ─────────────────────── */

interface TabPanelProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Panel> {
  value: string;
}

const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(({ className, ...props }, ref) => {
  return <TabsPrimitive.Panel ref={ref} className={cn("outline-none", className)} {...props} />;
});

TabPanel.displayName = "TabPanel";

export { Tabs, TabsList, TabItem, TabPanel };
export type { TabsProps, TabsListProps, TabItemProps, TabPanelProps };
