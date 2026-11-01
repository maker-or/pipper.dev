"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { StopIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { ContextWindowRing } from "@/components/ui/context-window-ring";
import { SliderComfortable } from "@/components/ui/slider";
import { Elevated } from "@/lib/elevated";
import { springs } from "@/lib/springs";
import {
  MentionPopover,
  type MentionItem,
  type MentionProvider,
} from "@/components/mention-popover";

export interface ReasoningLevelOption {
  value: string;
  name: string;
}

type ContextWindowRingProps = ComponentProps<typeof ContextWindowRing>;

interface AgentRuntimeControlsProps {
  reasoningLevels: ReasoningLevelOption[];
  currentReasoningIndex: number;
  currentReasoningLabel?: string;
  disabled?: boolean;
  onReasoningChange: (value: string) => void;
  contextUsage?: ContextWindowRingProps["contextUsage"];
  modelName?: string;
  autoCompactionEnabled?: boolean;
  sessionTokens?: number;
  sessionCost?: number;
  rateLimit?: ContextWindowRingProps["rateLimit"];
  modelId?: string;
  modelItems?: MentionItem[];
  modelProviders?: MentionProvider[];
  onModelChange?: (modelId: string) => void;
  isStreaming?: boolean;
  isStopping?: boolean;
  onStop?: () => void;
  /** Running subthreads, shown at the start of the right-hand group. */
  subthreads?: ReactNode;
  /** Workspace picker (hybrid shell), shown after the model. */
  workspace?: ReactNode;
}

export function AgentRuntimeControls({
  reasoningLevels,
  currentReasoningIndex,
  currentReasoningLabel,
  disabled = false,
  onReasoningChange,
  contextUsage,
  modelName,
  autoCompactionEnabled,
  sessionTokens,
  sessionCost,
  rateLimit,
  modelId,
  modelItems = [],
  modelProviders = [],
  onModelChange,
  isStreaming = false,
  isStopping = false,
  onStop,
  subthreads,
  workspace,
}: AgentRuntimeControlsProps) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [selectedModelProviderId, setSelectedModelProviderId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!reasoningOpen && !modelOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[data-pipper-id="runtime-model-popover"]')
      ) {
        return;
      }
      setReasoningOpen(false);
      setModelOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [modelOpen, reasoningOpen]);

  const hasReasoningLevels = reasoningLevels.length > 0;
  const hasModelPicker = Boolean(modelName && modelId && modelItems.length > 0 && onModelChange);
  if (!hasReasoningLevels && !contextUsage && !modelName && !isStreaming && !workspace) return null;

  return (
    <div ref={rootRef} className="relative flex w-full items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-4">
        <ContextWindowRing
          contextUsage={contextUsage}
          modelName={modelName}
          autoCompactionEnabled={autoCompactionEnabled}
          sessionTokens={sessionTokens}
          sessionCost={sessionCost}
          rateLimit={rateLimit}
        />

        {modelName && (
          <Button
            ref={modelButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || !hasModelPicker}
            data-pipper-id="runtime-model-picker"
            aria-expanded={modelOpen}
            aria-label={hasModelPicker ? `Change model, currently ${modelName}` : modelName}
            title={hasModelPicker ? "Change model" : modelName}
            onClick={() => setModelOpen((open) => !open)}
            className="text-[12px] text-muted-foreground"
          >
            <span className="truncate">{modelName}</span>
          </Button>
        )}
        {workspace}
      </div>

      <AnimatePresence>
        {modelOpen && hasModelPicker ? (
          <MentionPopover
            anchorRef={modelButtonRef}
            pipperId="runtime-model-popover"
            kind="model"
            items={modelItems}
            selectedIndex={Math.max(
              0,
              modelItems.findIndex((item) => item.id === modelId),
            )}
            onSelectedIndexChange={() => undefined}
            onPick={(item) => {
              setModelOpen(false);
              onModelChange?.(item.id);
            }}
            onClose={() => setModelOpen(false)}
            providers={modelProviders}
            selectedProviderId={selectedModelProviderId}
            onProviderChange={setSelectedModelProviderId}
          />
        ) : null}
      </AnimatePresence>

      <div className="flex shrink-0 items-center gap-1.5">
        {subthreads}
        {hasReasoningLevels && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            data-pipper-id="reasoning-slider-toggle"
            aria-expanded={reasoningOpen}
            onClick={() => setReasoningOpen((open) => !open)}
          >
            {reasoningLevels[currentReasoningIndex]?.name ?? currentReasoningLabel ?? "Reasoning"}
          </Button>
        )}

        {isStreaming && onStop ? (
          <Elevated offset={1} shadowLevel={1} className="rounded-full">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || isStopping}
              data-pipper-id="runtime-stop-button"
              aria-label={isStopping ? "Stopping response" : "Stop response"}
              title={isStopping ? "Stopping response" : "Stop response"}
              onClick={onStop}
              className="size-7 p-0 rounded-full border border-border/80 text-destructive hover:text-destructive hover:bg-hover"
            >
              <StopIcon size={13} weight="fill" />
            </Button>
          </Elevated>
        ) : null}

        <AnimatePresence>
          {reasoningOpen && hasReasoningLevels && (
            <motion.div
              data-pipper-id="reasoning-slider"
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.98 }}
              transition={springs.moderate}
              className="absolute right-0 bottom-full z-[240] mb-2 w-[min(22rem,calc(100vw-2rem))]"
            >
              <SliderComfortable
                value={currentReasoningIndex}
                onChange={(index) => {
                  const level = reasoningLevels[index];
                  if (level) onReasoningChange(level.value);
                }}
                min={0}
                max={reasoningLevels.length - 1}
                step={1}
                variant="pips"
                label="Reasoning"
                formatValue={(index) => reasoningLevels[index]?.name ?? String(index)}
                disabled={disabled}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
