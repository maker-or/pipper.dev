/**
 * Global tab-bar shortcuts.
 *
 * Visible tabs are numbered left → right, starting at 1. ⌘1 / Ctrl+1 selects
 * the first tab, ⌘2 the second, through ⌘9. Tabs past the ninth have no
 * number key; a press for an empty slot is a no-op.
 *
 * ⌘T / Ctrl+T opens a new thread draft — the same action as "New thread" in
 * the tab-bar plus menu. A draft is tab-less until the first send.
 * ⌘⇧T / Ctrl+Shift+T opens a new terminal in the current workspace.
 *
 * Bindings live here so a future settings keymap can override the defaults
 * without changing the tab-bar itself.
 */

export const TAB_SHORTCUT_MAX_INDEX = 8;

export function tabValuesInBarOrder(
  threadIds: readonly string[],
  terminalIds: readonly string[],
  terminalPrefix: string,
): string[] {
  return [...threadIds, ...terminalIds.map((id) => `${terminalPrefix}${id}`)];
}

export function tabValueAtShortcutIndex(
  tabValues: readonly string[],
  index: number,
): string | null {
  if (!Number.isInteger(index) || index < 0 || index > TAB_SHORTCUT_MAX_INDEX) return null;
  return tabValues[index] ?? null;
}

/** Native page swipes move through visible tabs and stop at either edge. */
export function tabValueAfterSwipe(
  tabValues: readonly string[],
  selectedTabValue: string,
  direction: "left" | "right",
): string | null {
  const index = tabValues.indexOf(selectedTabValue);
  if (index < 0) return null;
  return tabValues[index + (direction === "left" ? 1 : -1)] ?? null;
}

/**
 * Returns the 0-based tab index for a number-row shortcut, or null if the
 * event is not a tab-switch binding.
 */
function isPlainModShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.shiftKey || event.repeat) return false;
  if (event.isComposing) return false;
  return event.metaKey || event.ctrlKey;
}

export function tabIndexFromShortcutEvent(event: KeyboardEvent): number | null {
  if (!isPlainModShortcut(event)) return null;

  const fromCode = event.code.match(/^Digit([1-9])$/);
  const fromKey = /^[1-9]$/.test(event.key) ? event.key : null;
  const digit = fromCode?.[1] ?? fromKey;
  if (!digit) return null;

  return Number(digit) - 1;
}

/** ⌘T / Ctrl+T — new thread draft. */
export function isNewTabShortcutEvent(event: KeyboardEvent): boolean {
  if (!isPlainModShortcut(event)) return false;
  return event.code === "KeyT" || event.key.toLowerCase() === "t";
}

/** ⌘⇧T / Ctrl+Shift+T — new terminal. */
export function isNewTerminalShortcutEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.repeat || event.isComposing) return false;
  if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return false;
  return event.code === "KeyT" || event.key.toLowerCase() === "t";
}

/** ⌘W / Ctrl+W — close active tab. */
export function isCloseTabShortcutEvent(event: KeyboardEvent): boolean {
  if (!isPlainModShortcut(event)) return false;
  return event.code === "KeyW" || event.key.toLowerCase() === "w";
}

export type ActiveTabKind = "preview" | "terminal" | "draft" | "thread";

/**
 * Which tab ⌘W closes: the one on screen. A draft can sit behind a terminal
 * or the file preview without being the tab the user is looking at, so the
 * view mode decides before the draft does.
 */
export function activeTabToClose(input: {
  mode: "agent" | "terminal" | "preview";
  terminalId: string | null;
  hasDraft: boolean;
  threadId: string | null;
}): ActiveTabKind | null {
  if (input.mode === "preview") return "preview";
  if (input.mode === "terminal" && input.terminalId) return "terminal";
  if (input.hasDraft) return "draft";
  return input.threadId ? "thread" : null;
}
