import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import type { AcpBridgeEvent } from "../contracts/acp.ts";
import { PermissionCoordinator } from "./permission-coordinator.ts";

/**
 * Pending-permission lifecycle: requests surface as bridge events, settle via
 * user response, timeout cancellation, displace duplicates, and cancel when
 * their session goes away.
 */

function requestParams(
  overrides: Partial<acp.RequestPermissionRequest> = {},
): acp.RequestPermissionRequest {
  return {
    sessionId: "s1",
    toolCall: { toolCallId: "tc1", title: "Run command", kind: "execute" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    ...overrides,
  } as acp.RequestPermissionRequest;
}

function makeCoordinator(autoResponse: acp.RequestPermissionResponse | null = null) {
  const events: AcpBridgeEvent[] = [];
  const notifications: { kind: string; threadTitle: string | null }[] = [];
  const coordinator = new PermissionCoordinator({
    autoResponse: () => autoResponse,
    findThreadBySessionId: (sessionId) => (sessionId === "s1" ? "t1" : null),
    emit: (event) => events.push(event),
    notifyIfHidden: (notification) =>
      notifications.push({ kind: notification.kind, threadTitle: notification.threadTitle }),
    threadDisplayTitle: () => "Fix the bug",
  });
  return { coordinator, events, notifications };
}

describe("PermissionCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits a request event and resolves with the chosen option", async () => {
    const { coordinator, events, notifications } = makeCoordinator();
    const promise = coordinator.handle(requestParams(), "r1");
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual(["permission-request"]);
    const emitted = events[0] as Extract<AcpBridgeEvent, { type: "permission-request" }>;
    expect(emitted.request.requestId).toBe("r1");
    expect(emitted.request.threadId).toBe("t1");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.kind).toBe("permission-required");

    void coordinator.respond({ sessionId: "s1", requestId: "r1", optionId: "deny" });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "permission-request",
      "permission-resolved",
    ]);
  });

  test("respond without requestId resolves the session's only pending request", async () => {
    const { coordinator } = makeCoordinator();
    const promise = coordinator.handle(requestParams(), 7);
    await Promise.resolve();

    void coordinator.respond({ sessionId: "s1", optionId: "allow" });
    await expect(promise).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  test("cancels an unanswered request instead of granting permission", async () => {
    const { coordinator, events } = makeCoordinator();
    const promise = coordinator.handle(requestParams(), "r1");
    await vi.advanceTimersByTimeAsync(121_000);

    await expect(promise).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(events.at(-1)?.type).toBe("permission-resolved");
  });

  test("a duplicate request displaces the earlier one with a cancellation", async () => {
    const { coordinator, events } = makeCoordinator();
    const first = coordinator.handle(requestParams(), "r1");
    const second = coordinator.handle(requestParams(), "r1");
    await Promise.resolve();

    await expect(first).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    void coordinator.respond({ sessionId: "s1", requestId: "r1", optionId: "allow" });
    await expect(second).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    expect(events.filter((event) => event.type === "permission-resolved")).toHaveLength(2);
  });

  test("cancelForSession cancels every pending request of that session only", async () => {
    const { coordinator } = makeCoordinator();
    const s1 = coordinator.handle(requestParams(), "r1");
    const other = coordinator.handle(
      requestParams({
        sessionId: "s2",
        options: [{ optionId: "a", name: "A", kind: "allow_once" }],
      }),
      "r2",
    );
    await Promise.resolve();

    coordinator.cancelForSession("s1");
    await expect(s1).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    // The other session's request is untouched.
    void coordinator.respond({ sessionId: "s2", requestId: "r2", optionId: "a" });
    await expect(other).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "a" },
    });
  });

  test("a policy answer bypasses the pending queue entirely", async () => {
    const auto = { outcome: { outcome: "cancelled" } } as acp.RequestPermissionResponse;
    const { coordinator, events } = makeCoordinator(auto);

    await expect(coordinator.handle(requestParams(), "r1")).resolves.toBe(auto);
    expect(events).toEqual([]);
  });
  test("remote decisions validate thread ownership, options and stale request generations", async () => {
    const { coordinator } = makeCoordinator();
    const first = coordinator.handle(requestParams(), "r1");
    const decision = coordinator.listForThread("t1")[0]!;
    expect(coordinator.listForThread("another-thread")).toEqual([]);
    expect(await coordinator.respondForThread("another-thread", decision.id, "allow")).toBe(false);
    expect(await coordinator.respondForThread("t1", decision.id, "invented")).toBe(false);
    const replacement = coordinator.handle(requestParams(), "r1");
    await expect(first).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(await coordinator.respondForThread("t1", decision.id, "allow")).toBe(false);
    const current = coordinator.listForThread("t1")[0]!;
    expect(await coordinator.respondForThread("t1", current.id, "deny")).toBe(true);
    await expect(replacement).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
    expect(await coordinator.respondForThread("t1", current.id, "deny")).toBe(false);
  });
});
