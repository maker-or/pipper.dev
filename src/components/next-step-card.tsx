import { useState } from "react";
import { Elevated } from "@/lib/elevated";
import { surfaceClasses } from "@/lib/surface-classes";
import { useSurface } from "@/lib/surface-context";
import { cn } from "@/lib/utils";
import { useAgentStore, type UiRequest } from "@/store/agent-store";
import type { NextStep } from "../../contracts/next-step.ts";

interface NextStepCardProps {
  step: NextStep;
  threadId: string | null;
  /** Only the thread's latest turn can still be answered. */
  answerable: boolean;
}

/**
 * The question to show, if any. While a confirm card waits in this thread,
 * it is the question: Pipper rejects a wrap_up that asks then, but a harness
 * may still report the rejected call as completed, so the card drops the ask
 * (and its buttons) here as well.
 */
export function visibleAsk(
  step: NextStep,
  queue: UiRequest[],
  threadId: string | null,
): string | null {
  const confirmPending = queue.some((request) => request.confirm && request.threadId === threadId);
  return confirmPending ? null : step.ask;
}

/** Letters that key the answers, as on a multiple-choice question. */
const ANSWER_KEYS = "ABCDEFGH";

/**
 * The card an agent's `wrap_up` call fills. With a decision to make, the
 * question leads, the recap sits under it, and each answer is a lettered row
 * that sends its message as the user's reply. Without one, the card is just
 * the recap.
 */
export function NextStepCard({ step, threadId, answerable }: NextStepCardProps) {
  const [answered, setAnswered] = useState<string | null>(null);
  const ask = useAgentStore((state) => visibleAsk(step, state.uiRequestQueue, threadId));
  const showActions = Boolean(ask) && step.actions.length > 0;
  const locked = !answerable || !threadId || answered !== null;
  // One step above the card, which is itself one above the transcript.
  const badgeSurface = surfaceClasses(useSurface() + 2, 1);

  const answer = (label: string, message: string) => {
    if (!threadId || answered) return;
    setAnswered(label);
    const store = useAgentStore.getState();
    void store
      .sendPrompt({
        threadId,
        message,
        ...(store.state?.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
      })
      .catch(() => setAnswered(null));
  };

  return (
    <Elevated
      offset={1}
      role="group"
      data-pipper-id="next-step-card"
      aria-label="Next step"
      className="mt-3 rounded-3xl border border-border/60 px-5 py-4"
    >
      {ask && (
        <p
          className="text-[15px] font-semibold leading-6 text-foreground"
          data-pipper-id="next-step-ask"
        >
          {ask}
        </p>
      )}
      <p className={cn("text-[13px] leading-6 text-muted-foreground", ask && "mt-1")}>
        {step.recap}
      </p>
      {showActions && (
        <div className="-mx-2 mt-3 flex flex-col gap-0.5">
          {step.actions.map((action, index) => {
            const chosen = answered === action.label;
            return (
              <button
                key={`${index}-${action.label}`}
                type="button"
                disabled={locked}
                data-chosen={chosen ? "true" : undefined}
                title={action.message === action.label ? undefined : action.message}
                onClick={() => answer(action.label, action.message)}
                className={cn(
                  "group/answer flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left outline-none",
                  "transition-[background-color,opacity] duration-80",
                  "hover:bg-hover focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:pointer-events-none",
                  chosen && "bg-hover",
                  locked && !chosen && "opacity-50",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-lg border border-border/60 text-[12px] font-medium text-muted-foreground",
                    badgeSurface,
                  )}
                >
                  {ANSWER_KEYS[index]}
                </span>
                <span className="min-w-0 flex-1 text-[14px] leading-5 text-foreground">
                  {action.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Elevated>
  );
}
