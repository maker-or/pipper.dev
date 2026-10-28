// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Worktree } from "../contracts/worktrees";
import type { AgentPanelSnapshot } from "@/store/agent-store";

vi.mock("@/components/agent-view", () => ({ AgentView: () => null }));
vi.mock("@/components/global-tab-bar", () => ({ GlobalTabBar: () => null }));
vi.mock("@/components/diff-ingestor", () => ({ DiffIngestor: () => null }));
vi.mock("@/components/advanced-shell", () => ({ AdvancedShell: () => null }));
vi.mock("@/components/project-threads-dropdown", () => ({ ProjectThreadsDropdown: () => null }));
vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/sleepless-control", () => ({ SleeplessControl: () => null }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/components/launcher-update", () => ({
  LauncherUpdateBanner: () => null,
  LauncherUpdateDialog: () => null,
}));
vi.mock("@/lib/monitor-tab-sync", () => ({ useMonitorTabSync: () => {} }));
vi.mock("@/lib/startup-timing", () => ({ reportStartupMilestone: () => {} }));
vi.mock("@/store/launcher-update-store", () => {
  const initialize = async () => () => {};
  const state = { initialize, state: null, dismissed: true, diagnosticsOpen: false };
  return {
    useLauncherUpdateStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});
vi.mock("@/store/agent-store", async () => {
  const { create } = await import("zustand");
  return { useAgentStore: create(() => ({ snapshot: null, runningThreadIds: [] })) };
});
vi.mock("react-resizable-panels", async () => {
  const { useRef } = await import("react");
  return {
    Group: ({ children }: any) => children,
    Panel: ({ children }: any) => children,
    Separator: () => null,
    useGroupRef: () => useRef(null),
  };
});

import App from "./App";
import { useAgentStore } from "@/store/agent-store";
import { useProjectStore } from "@/store/project-store";
import { useWorktreeStore } from "@/store/worktree-store";
import { useWorkspaceViewStore } from "@/store/workspace-view-store";
import { useUiModeStore } from "@/store/ui-mode-store";

const project = { id: "omni", name: "omni", path: "/repo", icon: "code" };
const otherProject = { id: "other", name: "Other", path: "/other", icon: "code" };
const pathA = "/worktrees/feature-a";
const pathB = "/worktrees/feature-b";
let persistedPath: string;
let liveWorktrees: Worktree[];
let list: ReturnType<typeof vi.fn>;
let getSelections: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let root: Root;
const snapshot = (id: string, cwd: string, projectId = project.id) =>
  ({ threadId: id, projectId, cwd }) as AgentPanelSnapshot;
const labels = () => ({
  worktree: host.querySelector('[aria-label="Select worktree"]')?.textContent?.trim(),
  branch: host.querySelector('[aria-label="Select branch"]')?.textContent?.trim(),
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  persistedPath = pathA;
  getSelections = vi.fn(async () => ({ omni: persistedPath }));
  liveWorktrees = [
    { path: "/repo", branch: "main", head: "abc", isProjectRoot: true, workspaceName: "main" },
    { path: pathA, branch: "feature/a", head: "abc", workspaceName: "feature-a" },
    { path: pathB, branch: "feature/b", head: "abc", workspaceName: "feature-b" },
  ];
  list = vi.fn(async () => liveWorktrees);
  Object.assign(window, {
    omni: {
      projects: { getActive: async () => project, list: async () => [project, otherProject] },
      worktrees: { list, getSelections, onDeleted: () => () => {}, onChanged: () => () => {} },
    },
  });
  useProjectStore.setState({ activeProject: project, isLoading: false, error: null });
  useWorktreeStore.setState({
    worktrees: [],
    projectId: null,
    selectedWorktreePathByProject: {},
    hasHydratedSelections: false,
  });
  useUiModeStore.setState({ mode: "basic" });
  useWorkspaceViewStore.setState({ draft: null, mode: "agent", activeTerminalId: null });
  useAgentStore.setState({ snapshot: snapshot("a", pathA) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, "omni");
});

test("simple header follows A → B → A when saved selections lag behind snapshots", async () => {
  expect(labels()).toEqual({ worktree: "feature-a", branch: "feature/a" });

  // Main publishes B's actual cwd BEFORE the selection write completes.
  await act(async () => useAgentStore.setState({ snapshot: snapshot("b", pathB) }));
  persistedPath = pathB; // IPC activation settles; no new snapshot/cwd event.
  await act(async () => {});
  expect(useAgentStore.getState().snapshot?.cwd).toBe(pathB);
  expect(labels()).toEqual({ worktree: "feature-b", branch: "feature/b" });

  // Returning to A must follow its cwd while the saved selection is still B.
  await act(async () => useAgentStore.setState({ snapshot: snapshot("a", pathA) }));
  persistedPath = pathA;
  await act(async () => {});
  expect(useAgentStore.getState().snapshot?.cwd).toBe(pathA);
  expect(labels()).toEqual({ worktree: "feature-a", branch: "feature/a" });
  expect(getSelections).toHaveBeenCalledTimes(3);
  expect(list).toHaveBeenCalledTimes(3);
});

test("returning to a thread refreshes branch metadata changed while away", async () => {
  await act(async () => useAgentStore.setState({ snapshot: snapshot("b", pathB) }));
  liveWorktrees = liveWorktrees.map((worktree) =>
    worktree.path === pathA ? { ...worktree, branch: "feature/renamed" } : worktree,
  );
  await act(async () => useAgentStore.setState({ snapshot: snapshot("a", pathA) }));
  expect(labels()).toEqual({ worktree: "feature-a", branch: "feature/renamed" });
});

test("an uncached active worktree keeps its path label while metadata loads", async () => {
  let complete!: (worktrees: Worktree[]) => void;
  list.mockImplementationOnce(
    () =>
      new Promise<Worktree[]>((resolve) => {
        complete = resolve;
      }),
  );
  const path = "/worktrees/feature-new";
  await act(async () => useAgentStore.setState({ snapshot: snapshot("new", path) }));
  expect(labels()).toEqual({ worktree: "feature-new", branch: "Loading…" });
  await act(async () =>
    complete([
      ...liveWorktrees,
      { path, branch: "feature/new", head: "abc", workspaceName: "feature-new" },
    ]),
  );
  expect(labels()).toEqual({ worktree: "feature-new", branch: "feature/new" });
});

test("cross-project tab switches follow the snapshot before the project mirror catches up", async () => {
  liveWorktrees = [
    {
      path: otherProject.path,
      branch: "other/main",
      head: "abc",
      isProjectRoot: true,
      workspaceName: "main",
    },
  ];
  await act(async () =>
    useAgentStore.setState({ snapshot: snapshot("other", otherProject.path, otherProject.id) }),
  );
  expect(useProjectStore.getState().activeProject?.id).toBe(project.id);
  expect(host.querySelector("header")?.textContent).toContain("Other");
  expect(labels()).toEqual({ worktree: "main", branch: "other/main" });
});

test("draft chrome keeps the draft workspace instead of the previous live thread", async () => {
  await act(async () =>
    useWorkspaceViewStore.getState().beginDraft({ projectId: project.id, worktreePath: pathB }),
  );
  expect(labels()).toEqual({ worktree: "feature-b", branch: "feature/b" });
  await act(async () => useWorkspaceViewStore.getState().setDraftWorktree(null));
  expect(labels()).toEqual({ worktree: "main", branch: "main" });
  await act(async () => useWorkspaceViewStore.getState().setDraftProject(null));
  expect(host.querySelector('[aria-label="Select worktree"]')).toBeNull();
  expect(host.querySelector("header")?.textContent).toContain("New thread");
});
