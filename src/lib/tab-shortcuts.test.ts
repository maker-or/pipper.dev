import { describe, expect, test } from "vitest";
import {
  activeTabToClose,
  isCloseTabShortcutEvent,
  isNewTabShortcutEvent,
  isNewTerminalShortcutEvent,
  tabIndexFromShortcutEvent,
  tabValueAfterSwipe,
  tabValueAtShortcutIndex,
  tabValuesInBarOrder,
} from "./tab-shortcuts";

function keyEvent(partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    code: "",
    ...partial,
  } as KeyboardEvent;
}

describe("global tab number shortcuts", () => {
  test("numbers tabs left to right: threads, then terminals", () => {
    expect(tabValuesInBarOrder(["thread-a", "thread-b"], ["term-1"], "terminal:")).toEqual([
      "thread-a",
      "thread-b",
      "terminal:term-1",
    ]);
  });

  test("⌘1–⌘4 map to the first four visible tabs", () => {
    const tabs = tabValuesInBarOrder(["t1", "t2", "t3"], ["term"], "terminal:");
    expect(tabValueAtShortcutIndex(tabs, 0)).toBe("t1");
    expect(tabValueAtShortcutIndex(tabs, 1)).toBe("t2");
    expect(tabValueAtShortcutIndex(tabs, 2)).toBe("t3");
    expect(tabValueAtShortcutIndex(tabs, 3)).toBe("terminal:term");
  });

  test("a number past the open tab count is a no-op", () => {
    expect(tabValueAtShortcutIndex(["only"], 1)).toBeNull();
    expect(tabValueAtShortcutIndex(["only"], 8)).toBeNull();
  });

  test("⌘1 through ⌘9 are recognized; other chords are not", () => {
    expect(tabIndexFromShortcutEvent(keyEvent({ key: "1", metaKey: true, code: "Digit1" }))).toBe(
      0,
    );
    expect(tabIndexFromShortcutEvent(keyEvent({ key: "4", ctrlKey: true, code: "Digit4" }))).toBe(
      3,
    );
    expect(tabIndexFromShortcutEvent(keyEvent({ key: "9", metaKey: true, code: "Digit9" }))).toBe(
      8,
    );
    expect(tabIndexFromShortcutEvent(keyEvent({ key: "1" }))).toBeNull();
    expect(
      tabIndexFromShortcutEvent(keyEvent({ key: "1", metaKey: true, shiftKey: true })),
    ).toBeNull();
    expect(
      tabIndexFromShortcutEvent(keyEvent({ key: "0", metaKey: true, code: "Digit0" })),
    ).toBeNull();
  });

  test("⌘T / Ctrl+T is the new-tab shortcut", () => {
    expect(isNewTabShortcutEvent(keyEvent({ key: "t", metaKey: true, code: "KeyT" }))).toBe(true);
    expect(isNewTabShortcutEvent(keyEvent({ key: "T", ctrlKey: true, code: "KeyT" }))).toBe(true);
    expect(isNewTabShortcutEvent(keyEvent({ key: "t" }))).toBe(false);
    expect(
      isNewTabShortcutEvent(keyEvent({ key: "t", metaKey: true, shiftKey: true, code: "KeyT" })),
    ).toBe(false);
  });

  test("⌘W / Ctrl+W is the close-tab shortcut", () => {
    expect(isCloseTabShortcutEvent(keyEvent({ key: "w", metaKey: true, code: "KeyW" }))).toBe(true);
    expect(isCloseTabShortcutEvent(keyEvent({ key: "W", ctrlKey: true, code: "KeyW" }))).toBe(true);
    expect(isCloseTabShortcutEvent(keyEvent({ key: "w" }))).toBe(false);
    expect(
      isCloseTabShortcutEvent(keyEvent({ key: "w", metaKey: true, shiftKey: true, code: "KeyW" })),
    ).toBe(false);
  });

  test.each([
    { key: "T", code: "KeyT", metaKey: true, shiftKey: true },
    { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true },
    { key: "t", metaKey: true, shiftKey: true },
  ])("recognizes the new-terminal chord: %j", (chord) => {
    const event = keyEvent(chord);
    expect(isNewTerminalShortcutEvent(event)).toBe(true);
    expect(isNewTabShortcutEvent(event)).toBe(false);
    expect(tabIndexFromShortcutEvent(event)).toBeNull();
  });

  test.each([
    { metaKey: false },
    { shiftKey: false },
    { altKey: true },
    { repeat: true },
    { isComposing: true },
    { defaultPrevented: true },
    { key: "W", code: "KeyW" },
  ])("ignores other chords or handled key events: %j", (override) => {
    expect(
      isNewTerminalShortcutEvent(
        keyEvent({ key: "T", code: "KeyT", metaKey: true, shiftKey: true, ...override }),
      ),
    ).toBe(false);
  });
});

describe("native tab swipes", () => {
  const tabs = tabValuesInBarOrder(["thread-a", "thread-b"], ["term-1"], "terminal:");

  test("moves between threads and terminals in visible order", () => {
    expect(tabValueAfterSwipe(tabs, "thread-a", "left")).toBe("thread-b");
    expect(tabValueAfterSwipe(tabs, "thread-b", "left")).toBe("terminal:term-1");
    expect(tabValueAfterSwipe(tabs, "terminal:term-1", "right")).toBe("thread-b");
    expect(tabValueAfterSwipe(tabs, "thread-b", "right")).toBe("thread-a");
  });

  test("stops at the edges and leaves drafts or hidden selections alone", () => {
    expect(tabValueAfterSwipe(tabs, "thread-a", "right")).toBeNull();
    expect(tabValueAfterSwipe(tabs, "terminal:term-1", "left")).toBeNull();
    expect(tabValueAfterSwipe(tabs, "__draft__", "left")).toBeNull();
    expect(tabValueAfterSwipe(tabs, "hidden-thread", "right")).toBeNull();
    expect(tabValueAfterSwipe([], "thread-a", "left")).toBeNull();
    expect(tabValueAfterSwipe(["only"], "only", "left")).toBeNull();
  });
});

describe("closing the active tab", () => {
  const base = { terminalId: "term-1", hasDraft: true, threadId: "thread-a" };

  test("closes the tab on screen, even when a draft sits behind it", () => {
    expect(activeTabToClose({ ...base, mode: "preview" })).toBe("preview");
    expect(activeTabToClose({ ...base, mode: "terminal" })).toBe("terminal");
    expect(activeTabToClose({ ...base, mode: "agent" })).toBe("draft");
  });

  test("closes the thread when no draft is open, and nothing when there is none", () => {
    expect(activeTabToClose({ ...base, hasDraft: false, mode: "agent" })).toBe("thread");
    expect(
      activeTabToClose({ terminalId: null, hasDraft: false, threadId: null, mode: "agent" }),
    ).toBeNull();
  });
});
