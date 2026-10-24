// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Worktree, WorktreeSetupProgress } from "../../contracts/worktrees";

vi.mock("@/components/agent-view", () => ({ AgentView: () => null }));
vi.mock("@/components/diff-ingestor", () => ({ DiffIngestor: () => null }));
vi.mock("@/components/global-tab-bar", () => ({ GlobalTabBar: () => null }));
vi.mock("@/components/thread-completion-dock", () => ({ ThreadCompletionDock: () => null }));
vi.mock("@/components/workspace-control-panel", () => ({ WorkspaceControlPanel: () => null }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("@/lib/running-agents", () => ({ useRunningAgentsByWorkspace: () => new Map() }));

import { AdvancedShell } from "./advanced-shell";
import { useProjectStore } from "@/store/project-store";
import { useThreadStore } from "@/store/thread-store";
import { useWorkspaceSetupStore } from "@/store/workspace-setup-store";
import { useWorktreeStore } from "@/store/worktree-store";

const project = { id: "omni", name: "omni", path: "/repo", icon: "code" };
const otherProject = { id: "other", name: "Other", path: "/other", icon: "code" };
const pathA = "/worktrees/feature-a";
const worktrees: Worktree[] = [
  { path: "/repo", branch: "main", head: "abc", isProjectRoot: true, workspaceName: "main" },
  { path: pathA, branch: "feature/a", head: "abc", workspaceName: "feature-a" },
];

let host: HTMLDivElement;
let root: Root;
let emitProgress: (progress: WorktreeSetupProgress) => void;
let emitDeleted: (workspace: { projectId: string; path: string }) => void;

const progress = (overrides: Partial<WorktreeSetupProgress>): WorktreeSetupProgress => ({
  projectId: project.id,
  worktreePath: pathA,
  workspaceName: "feature-a",
  activation: "foreground",
  status: "installing",
  ...overrides,
});
const emit = (value: Partial<WorktreeSetupProgress>) =>
  act(async () => emitProgress(progress(value)));
const card = () =>
  [...host.querySelectorAll<HTMLElement>("[data-workspace-state]")].find((el) =>
    el.textContent?.includes("feature-a"),
  )!;
const alerts = () => [...host.querySelectorAll<HTMLElement>('[role="alert"]')];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useWorkspaceSetupStore.setState({ entries: {} });
  useProjectStore.setState({ activeProject: project } as never);
  useThreadStore.setState({ loadProjectThreads: async () => {} } as never);
  useWorktreeStore.setState({ selectedWorktreePathByProject: { omni: pathA } });
  Object.assign(window, {
    omni: {
      projects: {
        list: async () => [project, otherProject],
        onListChanged: () => () => {},
        setActive: async () => {},
      },
      worktrees: {
        list: async (projectId: string) => (projectId === project.id ? worktrees : []),
        getSelections: async () => ({ omni: pathA }),
        onSetupProgress: (callback: typeof emitProgress) => {
          emitProgress = callback;
          return () => {};
        },
        onDeleted: (callback: typeof emitDeleted) => {
          emitDeleted = callback;
          return () => {};
        },
      },
      launch: { show: async () => {} },
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AdvancedShell />
      </QueryClientProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("shows a workspace as setting up while its setup script runs, then clears", async () => {
  expect(card().textContent).not.toContain("Setting up");
  await emit({ status: "installing", source: "script" });
  expect(card().textContent).toContain("Setting up…");
  await emit({ status: "installed", source: "script" });
  expect(card().textContent).not.toContain("Setting up");
  expect(alerts()).toHaveLength(0);
});

test("a failed automatic install stays visible with its output until dismissed", async () => {
  await emit({ status: "installing", manager: "bun" });
  await emit({ status: "failed", manager: "bun", message: "error: lockfile had changes" });
  expect(card().textContent).toContain("Setup failed");
  expect(card().textContent).not.toContain("Setting up");
  const [alert] = alerts();
  expect(alert.textContent).toContain("bun install failed");
  expect(alert.textContent).toContain("feature-a");
  expect(alert.textContent).toContain("automatic dependency install");
  expect(alert.textContent).toContain("error: lockfile had changes");

  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss setup error for feature-a"]')!
      .click(),
  );
  expect(alerts()).toHaveLength(0);
  expect(card().textContent).not.toContain("Setup failed");
});

test("a failed setup script is attributed to the script", async () => {
  await emit({ status: "failed", source: "script", message: "uv: command not found" });
  const [alert] = alerts();
  expect(alert.textContent).toContain("Setup script failed");
  expect(alert.textContent).toContain("setup script");
  expect(alert.textContent).not.toContain("automatic dependency install");
  expect(alert.textContent).toContain("uv: command not found");
});

test("background setups stay quiet unless they fail, in any project", async () => {
  await emit({ status: "installing", source: "script", activation: "background" });
  expect(card().textContent).not.toContain("Setting up");
  await emit({ status: "installed", source: "script", activation: "background" });
  expect(alerts()).toHaveLength(0);

  await emit({
    projectId: otherProject.id,
    worktreePath: "/other/worktrees/phone-task",
    workspaceName: "phone-task",
    activation: "background",
    status: "failed",
    source: "script",
    message: "make: *** [setup] Error 2",
  });
  const [alert] = alerts();
  expect(alert.textContent).toContain("phone-task");
  expect(alert.textContent).toContain("Other");
  expect(alert.textContent).toContain("make: *** [setup] Error 2");
});

test("deleting a workspace drops its setup state", async () => {
  await emit({ status: "failed", source: "script", message: "boom" });
  expect(alerts()).toHaveLength(1);
  await act(async () => emitDeleted({ projectId: project.id, path: pathA }));
  expect(alerts()).toHaveLength(0);
});
