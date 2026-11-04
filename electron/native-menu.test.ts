import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from "electron";
import { parseNativeMenuRequest, type NativeMenuRequest } from "../contracts/native-menu.ts";

const shown = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  options: {} as PopupOptions,
}));
vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      shown.template = template;
      return {
        popup: (options: PopupOptions) => {
          shown.options = options;
        },
      };
    },
  },
}));
import { popupNativeMenu } from "./native-menu";

const window = {} as BrowserWindow;
const request: NativeMenuRequest = {
  anchor: { x: 10, y: 40, width: 200, height: 28 },
  items: [
    { type: "item", id: "main", label: "main" },
    { type: "separator" },
    { type: "item", id: "feat", label: "feat", sublabel: "Checked out in feat", checked: true },
  ],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("resolves with the picked row, even when the menu reports closing first", async () => {
  const picked = popupNativeMenu(window, request);
  shown.options.callback?.();
  shown.template[0]?.click?.({} as never, undefined, {} as never);
  await vi.runAllTimersAsync();
  await expect(picked).resolves.toBe("main");
});

test("resolves with null when the menu is dismissed", async () => {
  const picked = popupNativeMenu(window, request);
  shown.options.callback?.();
  await vi.runAllTimersAsync();
  await expect(picked).resolves.toBeNull();
});

test("on macOS the checked row opens over the anchor, as a pop-up button does", () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  void popupNativeMenu(window, request);
  expect(shown.options).toMatchObject({ x: 10, y: 40, positioningItem: 2 });
  expect(shown.template[2]).toMatchObject({ checked: true, sublabel: "Checked out in feat" });
});

test("elsewhere the menu opens under the anchor", () => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  void popupNativeMenu(window, request);
  expect(shown.options).toMatchObject({ x: 10, y: 72 });
  expect(shown.options.positioningItem).toBeUndefined();
});

test("a request from the renderer keeps well-formed rows and refuses unusable ones", () => {
  expect(
    parseNativeMenuRequest({
      anchor: request.anchor,
      items: [{ type: "item", id: "a", label: "A" }, { type: "item", label: "no id" }, null],
    }),
  ).toEqual({
    anchor: request.anchor,
    items: [{ type: "item", id: "a", label: "A", checked: false, enabled: true }],
  });
  expect(parseNativeMenuRequest({ anchor: request.anchor, items: [] })).toBeNull();
  expect(parseNativeMenuRequest({ anchor: { x: 1 }, items: request.items })).toBeNull();
  expect(parseNativeMenuRequest("menu")).toBeNull();
});
