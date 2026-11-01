import { create } from "zustand";

export type UiMode = "basic" | "advanced" | "hybrid";

const STORAGE_KEY = "pipper.ui.mode";

function isUiMode(value: string | null): value is UiMode {
  return value === "basic" || value === "advanced" || value === "hybrid";
}

function readMode(): UiMode | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isUiMode(value) ? value : null;
  } catch {
    return null;
  }
}

interface UiModeState {
  mode: UiMode;
  setMode: (mode: UiMode) => void;
}

export const useUiModeStore = create<UiModeState>((set) => ({
  mode: readMode() ?? "basic",
  setMode: (mode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
    set({ mode });
  },
}));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const mode = event.newValue;
    if (isUiMode(mode)) {
      useUiModeStore.setState({ mode });
    }
  });
}

export function hasSavedUiMode(): boolean {
  return readMode() !== null;
}

/**
 * Whether the shell picks the project for the composer (the sidebar in
 * advanced and hybrid), so drafts carry no @project chip.
 */
export function shellOwnsProject(mode: UiMode): boolean {
  return mode !== "basic";
}

/**
 * Whether the active thread's changes open as their own tab (hybrid), like a
 * file preview, rather than as a split beside the thread (basic).
 */
export function diffOpensAsTab(mode: UiMode): boolean {
  return mode === "hybrid";
}

/**
 * Whether the workspace follows the displayed thread (basic and hybrid) rather
 * than a workspace the user selected in the sidebar (advanced).
 */
export function workspaceFollowsThread(mode: UiMode): boolean {
  return mode !== "advanced";
}
