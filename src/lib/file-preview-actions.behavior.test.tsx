// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useShowPreviewWorkspace } from "./file-preview-actions";
import { previewWorkspaceKey, usePreviewStore } from "@/store/preview-store";

function Shell({ worktreePath }: { worktreePath: string | null }) {
  useShowPreviewWorkspace("project", worktreePath);
  return null;
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

test("the preview follows the workspace on screen", () => {
  act(() => root.render(<Shell worktreePath="/wt/feature" />));
  expect(usePreviewStore.getState().shownWorkspaceKey).toBe(
    previewWorkspaceKey("project", "/wt/feature"),
  );

  act(() => root.render(<Shell worktreePath={null} />));
  expect(usePreviewStore.getState().shownWorkspaceKey).toBe(previewWorkspaceKey("project", null));
});
