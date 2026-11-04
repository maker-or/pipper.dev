import type { NativeMenuItem } from "../../contracts/native-menu.ts";

/**
 * Opens an OS menu from an element. Resolves with the picked item's id, or
 * null when the menu is dismissed.
 */
export function popupNativeMenu(
  anchor: HTMLElement,
  items: NativeMenuItem[],
): Promise<string | null> {
  const rect = anchor.getBoundingClientRect();
  return window.omni.menu.popup({
    items,
    anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  });
}
