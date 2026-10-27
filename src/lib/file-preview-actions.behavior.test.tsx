// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useShowPreviewWorkspace } from "./file-preview-actions";
import { previewWorkspaceKey, usePreviewStore } from "@/store/preview-store";

// The basic shell (App) stays mounted around the advanced shell, like here:
// React runs the child's effects first, so a parent that still reported its
// own workspace would overwrite the visible advanced shell's.
function AdvancedShell() {
  useShowPreviewWorkspace(true, "project", "/wt/feature");
  return null;
}

function BasicShell({ mode }: { mode: "basic" | "advanced" }) {
  useShowPreviewWorkspace(mode === "basic", "project", null);
  return mode === "advanced" ? <AdvancedShell /> : null;
}

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  usePreviewStore.setState({ workspaces: {}, shownWorkspaceKey: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("the preview follows the shell on screen, not the one wrapped around it", () => {
  act(() => root.render(<BasicShell mode="advanced" />));
  expect(usePreviewStore.getState().shownWorkspaceKey).toBe(
    previewWorkspaceKey("project", "/wt/feature"),
  );

  act(() => root.render(<BasicShell mode="basic" />));
  expect(usePreviewStore.getState().shownWorkspaceKey).toBe(previewWorkspaceKey("project", null));
});
