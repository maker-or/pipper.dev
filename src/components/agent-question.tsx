"use client";

import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  AskUserQuestions,
  type AskUserAnswer,
  type AskUserQuestion,
} from "@/components/ui/ask-user-questions";
import { HoldToConfirmButton } from "@/components/hold-to-confirm-button";
import { Button } from "@/components/ui/button";
import { useAgentStore, type UiRequest } from "@/store/agent-store";
import { useThreadStore } from "@/store/thread-store";
import { fontWeights } from "@/lib/font-weight";
import { useShape } from "@/lib/shape-context";
import { spring } from "@/lib/springs";
import { cn } from "@/lib/utils";

// Map a queued agent question onto the AskUserQuestions shape. Each ACP option
// becomes a single-select row whose id IS the option name — respondToUiRequest
// looks the name back up to its optionId, so round-tripping the name is enough.
// Not skippable: a permission is a real decision, so there's no skip/back
// footer, and with a single question the card is pure "pick one".
function toAskQuestion(request: UiRequest): AskUserQuestion {
  return {
    id: request.sessionId,
    title: request.message?.trim() || request.title,
    options: (request.options ?? []).map((name) => ({ id: name, title: name })),
    skippable: false,
  };
}

/** Renders one queued question as an AskUserQuestions card and answers it
 *  through the store. Used both inline (composer morph) and in the dock. */
export function AgentQuestionCard({
  request,
  className,
}: {
  request: UiRequest;
  className?: string;
}) {
  const respondToUiRequest = useAgentStore((s) => s.respondToUiRequest);

  if (request.confirm) {
    return (
      <DestructiveConfirmCard request={request} confirm={request.confirm} className={className} />
    );
  }
  return <ChoiceCard request={request} className={className} respond={respondToUiRequest} />;
}

function ChoiceCard({
  request,
  className,
  respond: respondToUiRequest,
}: {
  request: UiRequest;
  className?: string;
  respond: ReturnType<typeof useAgentStore.getState>["respondToUiRequest"];
}) {
  const handleComplete = useCallback(
    (answers: Record<string, AskUserAnswer>) => {
      const answer = answers[request.sessionId];
      const value = answer?.selectedIds[0];
      if (value === undefined) return;
      void respondToUiRequest({ requestId: request.id, value });
    },
    [request.id, request.sessionId, respondToUiRequest],
  );

  return (
    <AskUserQuestions
      // Key on the request so switching to the next queued question remounts
      // the card with a fresh selection state instead of morphing between two
      // unrelated permission prompts.
      key={request.sessionId}
      questions={[toAskQuestion(request)]}
      onComplete={handleComplete}
      // bg-surface-2 forces a solid fill: the component's default bg-card
      // renders transparent in this app's theme unless --card is aliased, and a
      // see-through question card over the conversation is unreadable.
      className={cn("w-full max-w-none bg-surface-2", className)}
    />
  );
}

/**
 * Pipper's own destructive call on something the agent doesn't own: what it
 * would do, a red button that confirms only when held, and a plain decline.
 */
function DestructiveConfirmCard({
  request,
  confirm,
  className,
}: {
  request: UiRequest;
  confirm: NonNullable<UiRequest["confirm"]>;
  className?: string;
}) {
  const respondToUiRequest = useAgentStore((s) => s.respondToUiRequest);
  const shape = useShape();
  const [answered, setAnswered] = useState(false);
  const { title, verb } = confirm;
  const [confirmName, declineName] = request.options ?? [];
  const answer = (value: string | undefined) => {
    if (answered || value === undefined) return;
    setAnswered(true);
    void respondToUiRequest({ requestId: request.id, value }).catch(() => setAnswered(false));
  };

  return (
    // Same frame and type scale as the question card it replaces; red is
    // kept for the action, not the frame.
    <section
      data-pipper-id="destructive-confirm-card"
      aria-label={title}
      className={cn("relative w-full bg-card border border-border", shape.container, className)}
    >
      <div className="px-4 pt-4 sm:px-5 sm:pt-5">
        <h3
          className="text-[16px] leading-snug text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {title}
        </h3>
      </div>
      <div className="flex items-start gap-2 px-4 pt-4 pb-4 sm:px-5 sm:pb-5">
        <HoldToConfirmButton
          label={`Hold to ${verb}`}
          accessibleLabel={`Hold to ${lowerFirst(title)}`}
          disabled={answered}
          onConfirm={() => answer(confirmName)}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={answered}
          onClick={() => answer(declineName)}
        >
          {declineName ?? "Don't allow"}
        </Button>
      </div>
    </section>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Bottom-right dock for questions raised by a session the user is NOT
 *  currently viewing. Shows one at a time (the head of the not-here queue);
 *  answering it reveals the next, so the user can clear a backlog from wherever
 *  they are. */
export function AgentQuestionDock({ activeSessionId }: { activeSessionId: string | null }) {
  const uiRequestQueue = useAgentStore((s) => s.uiRequestQueue);
  const threads = useThreadStore((s) => s.threads);

  // A question belongs in the dock when it comes from some other session.
  // Anything for the active session is morphed into the composer inline, so
  // it's excluded here (matching on sessionId, the agent's own identity).
  const request = uiRequestQueue.find(
    (r) => activeSessionId == null || r.sessionId !== activeSessionId,
  );
  if (typeof document === "undefined") return null;

  const sourceTitle =
    request?.threadId != null
      ? (threads.find((t) => t.id === request.threadId)?.title ?? "Another thread")
      : "Agent";

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[3500] flex justify-end">
      <AnimatePresence mode="wait">
        {request && (
          <motion.div
            key={request.sessionId}
            className="pointer-events-auto w-[380px] max-w-[calc(100vw-2rem)]"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={spring.fast}
          >
            <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Permission required · {sourceTitle}
            </div>
            <AgentQuestionCard request={request} className="shadow-surface-6" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
