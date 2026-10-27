import * as acp from "@agentclientprotocol/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";

const configuredPromptTimeout = Number(process.env.PIPPER_ACP_PROMPT_TIMEOUT_MS);
export const ACP_PROMPT_TIMEOUT_MS =
  Number.isFinite(configuredPromptTimeout) && configuredPromptTimeout >= 60_000
    ? configuredPromptTimeout
    : 45 * 60_000;

export interface QueuedPrompt {
  blocks: ContentBlock[];
  streamingBehavior?: "followUp" | "steer";
  /** Who asked for this turn; agent-task notes and briefs are not the user. */
  origin?: "user" | "agent-task";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ACP prompt result shape varies by agent
  resolve: (result: any) => void;
  reject: (error: unknown) => void;
}

/**
 * Per-thread prompt flow: queued prompts waiting for the thread's current turn
 * to settle, plus local cancellation for the in-flight session/prompt request.
 * Local rejectors make abort/timeout settle prompt callers even when ACP
 * ignores cancel.
 */
export class PromptScheduler {
  private readonly queued = new Map<string, QueuedPrompt[]>();
  private readonly inFlightCancels = new Map<string, () => void>();

  /** Queue a prompt and hand back the promise the caller awaits. */
  enqueue(
    threadId: string,
    prompt: Pick<QueuedPrompt, "blocks" | "streamingBehavior" | "origin">,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const queue = this.queued.get(threadId) ?? [];
      queue.push({ ...prompt, resolve, reject });
      this.queued.set(threadId, queue);
    });
  }

  /** Take the next queued prompt for a thread, if any. */
  dequeue(threadId: string): QueuedPrompt | undefined {
    const queue = this.queued.get(threadId);
    const prompt = queue?.shift();
    if (!prompt) {
      this.queued.delete(threadId);
    }
    return prompt;
  }

  /** Reject every queued (not yet started) prompt for a thread. */
  rejectQueued(threadId: string, reason: string): void {
    const queued = this.queued.get(threadId);
    if (!queued) return;
    this.queued.delete(threadId);
    for (const prompt of queued) prompt.reject(new Error(reason));
  }

  /** Cancel the in-flight prompt request for a thread, if there is one. */
  cancelInFlight(threadId: string, reason: string): boolean {
    const cancel = this.inFlightCancels.get(threadId);
    if (!cancel) return false;
    cancel();
    this.inFlightCancels.delete(threadId);
    console.warn(`[agent] prompt for ${threadId} cancelled: ${reason}`);
    return true;
  }

  /** Settle every pending prompt — used when the app tears connections down. */
  abortAll(): void {
    for (const threadId of this.inFlightCancels.keys()) {
      this.cancelInFlight(threadId, "connection closed");
      this.rejectQueued(threadId, "agent connection closed");
    }
    for (const threadId of this.queued.keys()) {
      this.rejectQueued(threadId, "agent connection closed");
    }
  }

  /**
   * Send one session/prompt request with a local cancel handle and a generous
   * timeout. On timeout the agent's session is cancelled too: the request may
   * still be alive inside the agent even though this caller has settled.
   */
  send(
    agent: acp.ClientContext,
    session: { threadId: string; agentSessionId: string },
    blocks: ContentBlock[],
    streamingBehavior?: "followUp" | "steer",
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let cancel!: () => void;
      let timeout!: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        // Only remove our own handle; a newer prompt may already own the slot.
        if (this.inFlightCancels.get(session.threadId) === cancel) {
          this.inFlightCancels.delete(session.threadId);
        }
        clearTimeout(timeout);
        callback();
      };
      cancel = () => finish(() => reject(new Error("agent prompt cancelled")));
      timeout = setTimeout(() => {
        void agent
          .notify(acp.methods.agent.session.cancel, { sessionId: session.agentSessionId })
          .catch(() => {});
        finish(() =>
          reject(new Error(`session/prompt timed out after ${ACP_PROMPT_TIMEOUT_MS}ms`)),
        );
      }, ACP_PROMPT_TIMEOUT_MS);
      this.inFlightCancels.set(session.threadId, cancel);

      agent
        .request(acp.methods.agent.session.prompt, {
          sessionId: session.agentSessionId,
          prompt: blocks,
          ...(streamingBehavior ? { streamingBehavior } : {}),
        })
        .then(
          (result) => finish(() => resolve(result)),
          (error) => finish(() => reject(error)),
        );
    });
  }
}
