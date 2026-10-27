import { beforeEach, describe, expect, test } from "vitest";
import {
  currentPreviewTarget,
  draftComments,
  previewWorkspaceKey,
  usePreviewStore,
} from "./preview-store";

const root = { projectId: "p1", worktreePath: null };
const key = previewWorkspaceKey("p1", null);

function shown() {
  return currentPreviewTarget(usePreviewStore.getState().workspaces[key])?.path ?? null;
}

beforeEach(() => {
  usePreviewStore.setState({ workspaces: {}, shownWorkspaceKey: null });
});

describe("one preview tab per workspace", () => {
  test("opening another file replaces the one shown, in the same tab", () => {
    const store = usePreviewStore.getState();
    store.openFile({ ...root, path: "a.ts" });
    store.openFile({ ...root, path: "b.ts" });
    store.openFile({ ...root, path: "c.ts" });
    expect(Object.keys(usePreviewStore.getState().workspaces)).toEqual([key]);
    expect(shown()).toBe("c.ts");
  });

  test("each workspace has its own tab", () => {
    const store = usePreviewStore.getState();
    store.openFile({ ...root, path: "a.ts" });
    store.openFile({ projectId: "p1", worktreePath: "/wt/feature", path: "b.ts" });
    expect(shown()).toBe("a.ts");
    const feature = usePreviewStore.getState().workspaces[previewWorkspaceKey("p1", "/wt/feature")];
    expect(currentPreviewTarget(feature)).toEqual({
      projectId: "p1",
      worktreePath: "/wt/feature",
      path: "b.ts",
    });
  });

  test("closing the tab keeps unsent comments, and the next file reopens it", () => {
    const store = usePreviewStore.getState();
    store.openFile({ ...root, path: "a.ts" });
    store.addComment(key, { path: "a.ts", startLine: 2, endLine: 2, quote: "x", body: "rename" });
    store.close(key);
    expect(shown()).toBeNull();
    expect(draftComments(usePreviewStore.getState().workspaces[key])).toHaveLength(1);

    store.openFile({ ...root, path: "a.ts" });
    expect(shown()).toBe("a.ts");
  });
});

describe("shown workspace", () => {
  test("the tab bar shows the preview of the workspace the shell reports, whatever else is open", () => {
    const store = usePreviewStore.getState();
    const feature = previewWorkspaceKey("p1", "/wt/feature");
    store.openFile({ projectId: "p1", worktreePath: "/wt/feature", path: "b.ts" });
    store.openFile({ ...root, path: "a.ts" });

    store.setShownWorkspace(feature);
    const state = usePreviewStore.getState();
    expect(currentPreviewTarget(state.workspaces[state.shownWorkspaceKey!])?.path).toBe("b.ts");

    store.setShownWorkspace(previewWorkspaceKey("p2", null));
    const other = usePreviewStore.getState();
    expect(currentPreviewTarget(other.workspaces[other.shownWorkspaceKey!])).toBeNull();
  });
});

describe("comments", () => {
  test("unsent comments are listed by file then line, and sent ones drop out", () => {
    const store = usePreviewStore.getState();
    store.openFile({ ...root, path: "b.ts" });
    const late = store.addComment(key, {
      path: "b.ts",
      startLine: 9,
      endLine: 9,
      quote: "",
      body: "second",
    });
    store.addComment(key, { path: "b.ts", startLine: 1, endLine: 3, quote: "", body: "first" });
    store.addComment(key, { path: "a.ts", startLine: 0, endLine: 0, quote: "", body: "file note" });
    expect(
      store.addComment(key, { path: "a.ts", startLine: 1, endLine: 1, quote: "", body: "  " }),
    ).toBeNull();

    const preview = () => usePreviewStore.getState().workspaces[key];
    expect(draftComments(preview()).map((comment) => comment.body)).toEqual([
      "file note",
      "first",
      "second",
    ]);

    store.setCommentStatus(key, [late!.id], "sent");
    expect(draftComments(preview()).map((comment) => comment.body)).toEqual(["file note", "first"]);
    expect(preview().comments["b.ts"].find((comment) => comment.id === late!.id)?.status).toBe(
      "sent",
    );
  });
});
