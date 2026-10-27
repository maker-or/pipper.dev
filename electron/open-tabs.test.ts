import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => process.env.PIPPER_LIBRARY_PATH ?? process.env.TMPDIR ?? "/tmp" },
}));

let root: string | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pipper-open-tabs-"));
  process.env.PIPPER_LIBRARY_PATH = root;
});

afterEach(() => {
  delete process.env.PIPPER_LIBRARY_PATH;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("openThreadTab / setActiveThreadTab / recordThreadSwitch ordering", () => {
  test("opening a brand-new thread inserts it at the front", async () => {
    const { openThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    const state = await openThreadTab("c");
    expect(state.openThreadIds).toEqual(["c", "b", "a"]);
    expect(state.activeThreadId).toBe("c");
  });

  test("reopening an already-open thread keeps its existing position", async () => {
    const { openThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c");
    // "c", "b", "a" is the current order. Reopening "a" (already open) must
    // NOT move it to the front or back.
    const state = await openThreadTab("a");
    expect(state.openThreadIds).toEqual(["c", "b", "a"]);
    expect(state.activeThreadId).toBe("a");
  });

  test("setActiveThreadTab inserts a not-yet-open thread at the front", async () => {
    const { openThreadTab, setActiveThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    const state = await setActiveThreadTab("z");
    expect(state.openThreadIds).toEqual(["z", "b", "a"]);
    expect(state.activeThreadId).toBe("z");
  });

  test("setActiveThreadTab on an already-open thread preserves order", async () => {
    const { openThreadTab, setActiveThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c");
    const state = await setActiveThreadTab("a");
    expect(state.openThreadIds).toEqual(["c", "b", "a"]);
    expect(state.activeThreadId).toBe("a");
  });

  test("recordThreadSwitch inserts a not-yet-open thread at the front", async () => {
    const { openThreadTab, recordThreadSwitch } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    const state = await recordThreadSwitch("z");
    expect(state.openThreadIds).toEqual(["z", "b", "a"]);
    expect(state.activeThreadId).toBe("z");
    expect(state.threadSwitchHistory[0]).toBe("z");
  });

  test("recordThreadSwitch on an already-open thread preserves openThreadIds order", async () => {
    const { openThreadTab, recordThreadSwitch } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c");
    const state = await recordThreadSwitch("a");
    expect(state.openThreadIds).toEqual(["c", "b", "a"]);
  });
});

describe("closeThreadTab next-active selection", () => {
  test("closing a non-active tab does not change the active thread", async () => {
    const { openThreadTab, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c"); // active: c, order: c, b, a
    const state = await closeThreadTab("a");
    expect(state.openThreadIds).toEqual(["c", "b"]);
    expect(state.activeThreadId).toBe("c");
  });

  test("closing the active tab prefers the most-recently-used still-open thread", async () => {
    const { openThreadTab, recordThreadSwitch, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c");
    // Order is c, b, a. Visit "a" then "c" so history (MRU-first) is [c, a, b].
    await recordThreadSwitch("a");
    await recordThreadSwitch("c");
    const state = await closeThreadTab("c");
    expect(state.openThreadIds).toEqual(["b", "a"]);
    // MRU still-open thread (excluding the closed one) is "a".
    expect(state.activeThreadId).toBe("a");
  });

  test("falls back to the right neighbor when there's no usable history", async () => {
    const { openThreadTab, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c"); // order: c, b, a — active: c
    const state = await closeThreadTab("c");
    // No switch history to consult, so this falls back to the right neighbor
    // of "c" in the pre-close array order (["c", "b", "a"]), which is "b".
    expect(state.openThreadIds).toEqual(["b", "a"]);
    expect(state.activeThreadId).toBe("b");
  });

  test("falls back to the left neighbor when there's no right neighbor or history", async () => {
    const { openThreadTab, setActiveThreadTab, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c"); // order: c, b, a
    await setActiveThreadTab("a"); // make the rightmost tab active
    const state = await closeThreadTab("a");
    expect(state.openThreadIds).toEqual(["c", "b"]);
    expect(state.activeThreadId).toBe("b");
  });

  test("closing the last remaining tab lands in a sane empty state", async () => {
    const { openThreadTab, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    const state = await closeThreadTab("a");
    expect(state.openThreadIds).toEqual([]);
    expect(state.activeThreadId).toBeNull();
  });

  test("closing an already-closed thread is a no-op and does not throw", async () => {
    const { openThreadTab, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    const first = await closeThreadTab("a");
    expect(first.openThreadIds).toEqual(["b"]);
    // Simulates a rapid double-click on the close button firing twice.
    const second = await closeThreadTab("a");
    expect(second.openThreadIds).toEqual(["b"]);
    expect(second.activeThreadId).toBe(first.activeThreadId);
  });
});

describe("closeThreadTab workspace peers", () => {
  test("next-active stays inside the closed tab's workspace even when another workspace's tab is more recent", async () => {
    const { openThreadTab, recordThreadSwitch, closeThreadTab } = await import("./open-tabs.ts");
    // "peer" shares the closed tab's workspace; "other" does not.
    await openThreadTab("peer");
    await openThreadTab("other");
    await openThreadTab("closing");
    await recordThreadSwitch("peer");
    await recordThreadSwitch("other");
    await recordThreadSwitch("closing");
    const state = await closeThreadTab("closing", (id) => id === "peer" || id === "closing");
    expect(state.openThreadIds).toEqual(["other", "peer"]);
    expect(state.activeThreadId).toBe("peer");
  });

  test("falls back to any remaining tab when the closed tab was the workspace's last one", async () => {
    const { openThreadTab, recordThreadSwitch, closeThreadTab } = await import("./open-tabs.ts");
    await openThreadTab("other");
    await openThreadTab("closing");
    await recordThreadSwitch("other");
    await recordThreadSwitch("closing");
    const state = await closeThreadTab("closing", (id) => id === "closing");
    expect(state.openThreadIds).toEqual(["other"]);
    expect(state.activeThreadId).toBe("other");
  });
});

describe("removeThreadTabs", () => {
  test("drops every listed tab in one write and picks the next active by MRU", async () => {
    const { openThreadTab, recordThreadSwitch, removeThreadTabs, readOpenTabsState } =
      await import("./open-tabs.ts");
    await openThreadTab("keep-old");
    await openThreadTab("keep-mru");
    await openThreadTab("ws-a");
    await openThreadTab("ws-b");
    await recordThreadSwitch("keep-mru");
    await recordThreadSwitch("ws-a");
    await recordThreadSwitch("ws-b");

    const state = await removeThreadTabs(["ws-a", "ws-b", "never-open"]);
    expect(state.openThreadIds).toEqual(["keep-mru", "keep-old"]);
    expect(state.activeThreadId).toBe("keep-mru");
    expect(state.threadSwitchHistory).not.toContain("ws-a");
    expect(state.threadSwitchHistory).not.toContain("ws-b");
    // Persisted, not just returned.
    expect(await readOpenTabsState()).toEqual(state);
  });

  test("keeps the active tab when it is not among the removed ones", async () => {
    const { openThreadTab, removeThreadTabs } = await import("./open-tabs.ts");
    await openThreadTab("gone");
    await openThreadTab("active");
    const state = await removeThreadTabs(["gone"]);
    expect(state.openThreadIds).toEqual(["active"]);
    expect(state.activeThreadId).toBe("active");
  });
});

describe("concurrent tab mutations", () => {
  test("closing two different tabs at the same time removes both, not just the last writer's", async () => {
    const { openThreadTab, closeThreadTab, readOpenTabsState } = await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    await openThreadTab("c");
    // Fire two closes concurrently, the way the renderer can if the user
    // closes two tabs in quick succession. Neither call should read a stale
    // snapshot that undoes the other's removal.
    await Promise.all([closeThreadTab("a"), closeThreadTab("b")]);
    const state = await readOpenTabsState();
    expect(state.openThreadIds).toEqual(["c"]);
  });

  test("a switch racing a close does not resurrect the closed tab", async () => {
    const { openThreadTab, closeThreadTab, recordThreadSwitch, readOpenTabsState } =
      await import("./open-tabs.ts");
    await openThreadTab("a");
    await openThreadTab("b");
    // Closing "a" while switching to "b" races a read-modify-write on the
    // same file; "a" must stay closed rather than reappearing because
    // recordThreadSwitch read the state before the close was written.
    await Promise.all([closeThreadTab("a"), recordThreadSwitch("b")]);
    const state = await readOpenTabsState();
    expect(state.openThreadIds).toEqual(["b"]);
  });
});

describe("tabs for deleted threads", () => {
  const live = new Set<string>();

  beforeEach(async () => {
    live.clear();
    const { setLiveThreadIdsCheck } = await import("./open-tabs.ts");
    setLiveThreadIdsCheck((ids) => new Set(ids.filter((id) => live.has(id))));
  });

  afterEach(async () => {
    const { setLiveThreadIdsCheck } = await import("./open-tabs.ts");
    setLiveThreadIdsCheck(null);
  });

  test("a thread deleted without closing its tab is gone from the next read and write", async () => {
    const { openThreadTab, readOpenTabsState, setActiveThreadTab } = await import("./open-tabs.ts");
    live.add("a").add("ghost").add("b");
    await openThreadTab("a");
    await openThreadTab("ghost");
    await openThreadTab("b");
    live.delete("ghost");

    expect((await readOpenTabsState()).openThreadIds).toEqual(["b", "a"]);
    const written = await setActiveThreadTab("a");
    expect(written.openThreadIds).toEqual(["b", "a"]);
    expect(written.threadSwitchHistory).not.toContain("ghost");
  });

  test("closing the active tab never falls back to a deleted thread", async () => {
    const { openThreadTab, recordThreadSwitch, closeThreadTab } = await import("./open-tabs.ts");
    live.add("real").add("ghost").add("closing");
    await openThreadTab("real");
    await openThreadTab("ghost");
    await openThreadTab("closing");
    // The deleted thread is the most recent other tab, so it would win.
    await recordThreadSwitch("real");
    await recordThreadSwitch("ghost");
    await recordThreadSwitch("closing");
    live.delete("ghost");

    const state = await closeThreadTab("closing");
    expect(state.openThreadIds).toEqual(["real"]);
    expect(state.activeThreadId).toBe("real");
  });

  test("deleting the active thread still picks the next tab by recency, not the first tab", async () => {
    const { openThreadTab, recordThreadSwitch, closeThreadTab } = await import("./open-tabs.ts");
    live.add("first").add("recent").add("deleted");
    // New tabs open at the front: the strip reads deleted, first, recent.
    await openThreadTab("recent");
    await openThreadTab("first");
    await openThreadTab("deleted");
    await recordThreadSwitch("first");
    await recordThreadSwitch("recent");
    await recordThreadSwitch("deleted");
    // threads:delete removes the row before it closes the tab.
    live.delete("deleted");

    const state = await closeThreadTab("deleted");
    expect(state.openThreadIds).not.toContain("deleted");
    expect(state.activeThreadId).toBe("recent");
  });

  test("keeps every tab when the lookup fails", async () => {
    const { openThreadTab, readOpenTabsState, setLiveThreadIdsCheck } =
      await import("./open-tabs.ts");
    live.add("a");
    await openThreadTab("a");
    setLiveThreadIdsCheck(() => {
      throw new Error("database closed");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await readOpenTabsState()).openThreadIds).toEqual(["a"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("activateTabAfterClose", () => {
  function activator(switchThread: (id: string) => Promise<unknown>, generation = 1) {
    return {
      getState: () => ({ threadId: "closed" }),
      selectionGeneration: () => generation,
      switchThread: vi.fn(switchThread),
      clearActiveThread: vi.fn(async () => {}),
    };
  }
  const next = { openThreadIds: ["next"], activeThreadId: "next", threadSwitchHistory: [] };

  test("a failed switch to the next tab does not fail the close", async () => {
    const { activateTabAfterClose } = await import("./open-tabs.ts");
    const manager = activator(async () => {
      throw new Error("Thread not found: next");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(activateTabAfterClose(manager, next, 1)).resolves.toBeUndefined();
      expect(manager.switchThread).toHaveBeenCalledWith("next");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("clears the active thread when no tab is left", async () => {
    const { activateTabAfterClose } = await import("./open-tabs.ts");
    const manager = activator(async () => {});
    await activateTabAfterClose(
      manager,
      { openThreadIds: [], activeThreadId: null, threadSwitchHistory: [] },
      1,
    );
    expect(manager.clearActiveThread).toHaveBeenCalled();
    expect(manager.switchThread).not.toHaveBeenCalled();
  });

  test("a tab the user picked while the close ran is not overridden", async () => {
    const { activateTabAfterClose } = await import("./open-tabs.ts");
    // The close began at generation 1; the user's click moved it to 2.
    const manager = activator(async () => {}, 2);
    await activateTabAfterClose(manager, next, 1);
    expect(manager.switchThread).not.toHaveBeenCalled();
    expect(manager.clearActiveThread).not.toHaveBeenCalled();
  });
});
