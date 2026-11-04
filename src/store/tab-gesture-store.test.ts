// @vitest-environment happy-dom
import { beforeAll, expect, test } from "vitest";

const storageKey = "pipper.tabs.trackpadSwipeEnabled";
let store: typeof import("./tab-gesture-store").useTabGestureStore;

beforeAll(async () => {
  // Node 22+ defines its own global localStorage, which is unusable without
  // --localstorage-file and hides happy-dom's. Give the window a real one.
  const HappyStorage = (window as unknown as { Storage: new () => Storage }).Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new HappyStorage(),
  });
  window.localStorage.setItem(storageKey, "false");
  store = (await import("./tab-gesture-store")).useTabGestureStore;
});

function changeFromSettingsWindow(value: string | null) {
  if (value === null) window.localStorage.removeItem(storageKey);
  else window.localStorage.setItem(storageKey, value);
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: storageKey,
      newValue: value,
      storageArea: window.localStorage,
    }),
  );
}

test("restores the saved disabled preference on startup", () => {
  expect(store.getState().swipeEnabled).toBe(false);
});

test("persists changes made in Settings", () => {
  store.getState().setSwipeEnabled(true);
  expect(window.localStorage.getItem(storageKey)).toBe("true");
  expect(store.getState().swipeEnabled).toBe(true);
  store.getState().setSwipeEnabled(false);
  expect(window.localStorage.getItem(storageKey)).toBe("false");
  expect(store.getState().swipeEnabled).toBe(false);
});

test("applies changes from another app window immediately", () => {
  changeFromSettingsWindow("true");
  expect(store.getState().swipeEnabled).toBe(true);
  changeFromSettingsWindow("false");
  expect(store.getState().swipeEnabled).toBe(false);
});

test("restores the enabled default when the preference is removed", () => {
  changeFromSettingsWindow(null);
  expect(store.getState().swipeEnabled).toBe(true);
});
