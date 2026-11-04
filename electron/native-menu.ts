import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { NativeMenuRequest } from "../contracts/native-menu.ts";

/**
 * How long a close waits for a pick before it reports none. On macOS the
 * menu can close before the picked row's click is dispatched; the wait is
 * invisible, since a dismissed menu changes nothing.
 */
const CLOSE_SETTLE_MS = 100;

/**
 * Pops up an OS menu at the anchor and resolves with the picked row's id, or
 * null when it is dismissed. On macOS the checked row opens over the anchor,
 * as a native pop-up button does; elsewhere the menu opens under it.
 */
export function popupNativeMenu(
  window: BrowserWindow,
  request: NativeMenuRequest,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (id: string | null) => {
      if (settled) return;
      settled = true;
      resolve(id);
    };

    const template: MenuItemConstructorOptions[] = request.items.map((item) =>
      item.type === "separator"
        ? { type: "separator" }
        : {
            type: "checkbox",
            label: item.label,
            sublabel: item.sublabel,
            checked: item.checked === true,
            enabled: item.enabled !== false,
            click: () => settle(item.id),
          },
    );
    const checkedIndex = request.items.findIndex(
      (item) => item.type === "item" && item.checked === true,
    );
    const { anchor } = request;
    const overAnchor = process.platform === "darwin" && checkedIndex !== -1;

    Menu.buildFromTemplate(template).popup({
      window,
      x: Math.round(anchor.x),
      y: Math.round(overAnchor ? anchor.y : anchor.y + anchor.height + 4),
      ...(overAnchor ? { positioningItem: checkedIndex } : {}),
      callback: () => setTimeout(() => settle(null), CLOSE_SETTLE_MS),
    });
  });
}
