"use client";

import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Dropdown } from "@/components/ui/dropdown";
import { MenuItem } from "@/components/ui/menu-item";
import { createProviderLogoIcon } from "@/components/provider-logos";
import { Elevated } from "@/lib/elevated";
import { useAnchoredPopoverPosition } from "@/lib/anchored-popover";
import { useModelCatalogStore } from "@/store/model-catalog-store";
import type { ComposerMentionKind } from "../../contracts/composer.ts";

export type MentionItem = {
  id: string;
  label: string;
  description?: string;
  /** Extra payload for model items (owning agent). */
  agentId?: string;
  /** Provider identity used by the model picker filter. */
  providerId?: string;
  /** Human-readable provider name shown in the model picker. */
  providerLabel?: string;
  /** Project icon name if known. */
  icon?: string | null;
};

export type MentionProvider = {
  id: string;
  label: string;
};

export type MentionPopoverProps = {
  anchorRef: RefObject<HTMLElement | null>;
  pipperId?: string;
  kind: ComposerMentionKind;
  items: MentionItem[];
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
  /** Provider tabs shown above the model list. */
  providers?: MentionProvider[];
  selectedProviderId?: string | null;
  onProviderChange?: (providerId: string | null) => void;
};

const KIND_LABEL: Record<ComposerMentionKind, string> = {
  project: "Projects",
  agent: "Agents",
  model: "Models",
  file: "Files",
};

const KIND_CHIP: Record<ComposerMentionKind, string> = {
  project: "bg-[#FFAA4F] text-[#B1620D] dark:text-[#B1620D] ring-2 ring-inset ring-[#B1620D]",
  agent: "bg-[#8BB8FF] text-[#5F92FE] dark:text-[#5F92FE] ring-1 ring-inset ring-[#5F92FE]/25",
  model: "bg-[#8BB8FF] text-[#2C59B8] dark:text-[#2C59B8] ring-2 ring-inset ring-[#2C59B8]",
  file: "bg-sky-500/15 text-sky-800 dark:text-sky-200 ring-1 ring-inset ring-sky-500/25",
};

export function mentionChipClass(kind: ComposerMentionKind): string {
  return KIND_CHIP[kind];
}

export interface FileMentionPathParts {
  fileName: string;
  directory: string;
}

/** Split a repository-relative file path for the compact file picker row. */
export function splitFileMentionPath(filePath: string): FileMentionPathParts {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return { fileName: normalized || filePath, directory: "project root" };
  }

  return {
    fileName: normalized.slice(separatorIndex + 1) || normalized,
    directory: normalized.slice(0, separatorIndex) || "project root",
  };
}

export function MentionPopover({
  anchorRef,
  pipperId = "mention-popover",
  kind,
  items,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onClose,
  providers = [],
  selectedProviderId = null,
  onProviderChange,
}: MentionPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPopoverPosition(anchorRef, true, 360);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-proximity-index="${selectedIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // A provider with no known models (an account never used yet) has its
  // catalog fetched when the user picks its tab, instead of looking empty.
  const needsCatalog = kind === "model" && Boolean(selectedProviderId) && items.length === 0;
  const loadingModels = useModelCatalogStore((state) =>
    needsCatalog && selectedProviderId ? Boolean(state.loading[selectedProviderId]) : false,
  );
  useEffect(() => {
    if (needsCatalog && selectedProviderId) {
      void useModelCatalogStore.getState().ensure(selectedProviderId);
    }
  }, [needsCatalog, selectedProviderId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!position || typeof document === "undefined") return null;

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const providerHeaderHeight = kind === "model" && providers.length > 0 ? 76 : 8;
  const listMaxHeight = Math.max(0, Math.min(256, position.maxHeight - providerHeaderHeight));

  return createPortal(
    <Elevated
      offset={2}
      shadowLevel={4}
      className="fixed z-[250] overflow-hidden rounded-2xl border border-border/80"
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom,
      }}
      data-pipper-id={pipperId}
      data-placement={position.placement}
      role="listbox"
      aria-label={`${KIND_LABEL[kind]} mentions`}
    >
      <div ref={listRef}>
        {kind === "model" && providers.length > 0 && onProviderChange ? (
          <div className="px-3 pb-2.5 pt-3" aria-label="Model providers">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">
                Provider
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {selectedProvider?.label ?? "All providers"}
              </span>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto">
              {providers.map((provider) => {
                const ProviderIcon = createProviderLogoIcon(provider.id, provider.label);
                const isSelected = selectedProviderId === provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    title={isSelected ? "Show all models" : `Filter models by ${provider.label}`}
                    aria-label={
                      isSelected ? "Show all models" : `Filter models by ${provider.label}`
                    }
                    aria-pressed={isSelected}
                    className={cn(
                      "inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150",
                      isSelected
                        ? "bg-accent text-foreground shadow-sm"
                        : "hover:bg-hover hover:text-foreground",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onProviderChange(isSelected ? null : provider.id)}
                  >
                    <ProviderIcon size={16} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="h-2" aria-hidden="true" />
        <Dropdown
          checkedIndex={selectedIndex}
          className="w-full max-h-64 overflow-y-auto rounded-none bg-transparent shadow-none"
          style={{ maxHeight: listMaxHeight }}
          role="listbox"
          aria-label={`${KIND_LABEL[kind]} mentions`}
        >
          {items.length === 0 ? (
            <div className="px-3 py-5 text-center text-[12px] text-muted-foreground">
              {loadingModels ? "Loading models…" : `No ${KIND_LABEL[kind].toLowerCase()} found`}
            </div>
          ) : (
            items.map((item, index) => {
              const fileParts = kind === "file" ? splitFileMentionPath(item.label) : null;
              return (
                <MenuItem
                  key={item.agentId ? `${item.agentId}:${item.id}` : item.id}
                  label={fileParts?.fileName ?? item.label}
                  secondaryLabel={fileParts?.directory}
                  description={item.description}
                  index={index}
                  className="w-full px-3 py-2.5"
                  title={kind === "file" ? item.label : undefined}
                  aria-label={kind === "file" ? item.label : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onMouseEnter={() => onSelectedIndexChange(index)}
                  onSelect={() => onPick(item)}
                />
              );
            })
          )}
        </Dropdown>
      </div>
    </Elevated>,
    document.body,
  );
}
