import { useState } from "react";
import { Button } from "@/components/ui/button";
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

/**
 * The card an agent's `wrap_up` call fills: a recap of where the turn left
 * things and, when the user has a decision to make, one question with buttons
 * that answer it. A button sends its message as the user's reply.
 */
export function NextStepCard({ step, threadId, answerable }: NextStepCardProps) {
  const [answered, setAnswered] = useState<string | null>(null);
  const ask = useAgentStore((state) => visibleAsk(step, state.uiRequestQueue, threadId));
  const showActions = Boolean(ask) && step.actions.length > 0;

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
    <section
      data-pipper-id="next-step-card"
      className="mt-3 rounded-2xl border border-border/70 bg-surface-2/70 px-4 py-3 text-[13px]"
      aria-label="Next step"
    >
      <p className="leading-6 text-muted-foreground">{step.recap}</p>
      {ask && (
        <p className="mt-2 font-medium leading-6 text-foreground" data-pipper-id="next-step-ask">
          {ask}
        </p>
      )}
      {showActions && (
        <div className="mt-3 flex flex-wrap gap-2">
          {step.actions.map((action, index) => (
            <Button
              key={`${index}-${action.label}`}
              type="button"
              size="sm"
              variant={index === 0 ? "primary" : "tertiary"}
              disabled={!answerable || !threadId || answered !== null}
              title={action.message === action.label ? undefined : action.message}
              onClick={() => answer(action.label, action.message)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
