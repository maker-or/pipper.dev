// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitHubProjectPicker } from "./github-project-picker";
import { AuthenticatedStage } from "./authenticated-stage";
import type { GitHubCliStatus } from "../../contracts/github.ts";

const mode = vi.hoisted(() => ({ value: "basic", setMode: vi.fn(), load: vi.fn() }));
vi.mock("@/store/ui-mode-store", () => ({
  useUiModeStore: (selector: (state: unknown) => unknown) =>
    selector({ mode: mode.value, setMode: mode.setMode }),
}));
vi.mock("@/store/agent-registry-store", () => ({
  useAgentRegistryStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedAgentIds: [], load: mode.load }),
}));
vi.mock("@/components/ambient-pixel-field", () => ({ AmbientPixelField: () => null }));
vi.mock("@/components/agent-selector", () => ({ AgentSelector: () => null }));
vi.mock("@/components/sleepless-onboarding", () => ({ SleeplessOnboarding: () => null }));
vi.mock("@/components/workspace-mode-picker", () => ({ WorkspaceModePicker: () => null }));
vi.mock("./onboarding-analytics", () => ({ trackOnboarding: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
const getStatus = vi.fn();
const listRepositories = vi.fn();
const cloneRepository = vi.fn();
const openExternal = vi.fn();
const onCreated = vi.fn();
const onBusyChange = vi.fn();
const ready: GitHubCliStatus = {
  state: "ready",
  username: "octocat",
  installCommand: "brew install gh",
};
const repo = { id: 1, fullName: "team/app", description: "Our app", isPrivate: true };
const project = {
  id: "managed-project",
  name: "team/app",
  path: "/managed/app",
  icon: "GithubLogo",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of [
    getStatus,
    listRepositories,
    cloneRepository,
    openExternal,
    onCreated,
    onBusyChange,
  ])
    mock.mockReset();
  mode.setMode.mockClear();
  getStatus.mockResolvedValue(ready);
  listRepositories.mockResolvedValue({ repositories: [repo], hasMore: false });
  cloneRepository.mockResolvedValue(project);
  Object.defineProperty(window, "omni", {
    configurable: true,
    value: { github: { getStatus, listRepositories, cloneRepository }, shell: { openExternal } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.history.replaceState({}, "", "/?stage=add");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((el) =>
    el.getAttribute("role") === "tab"
      ? el.textContent?.includes(label)
      : el.textContent?.trim() === label,
  )!;
const render = () =>
  act(async () =>
    root.render(<GitHubProjectPicker onCreated={onCreated} onBusyChange={onBusyChange} />),
  );

test("guides installation, then login, and rechecks without restarting", async () => {
  getStatus.mockResolvedValueOnce({ ...ready, state: "missing", username: null });
  await render();
  expect(host.textContent).toContain("Install GitHub CLI");
  expect(host.textContent).toContain("brew install gh");
  await act(async () => button("Installation instructions").click());
  expect(openExternal).toHaveBeenCalledWith("https://cli.github.com/");
  expect(listRepositories).not.toHaveBeenCalled();
  getStatus.mockResolvedValueOnce({ ...ready, state: "signed-out", username: null });
  await act(async () => button("I’ve installed it").click());
  expect(host.textContent).toContain(
    "gh auth login --hostname github.com --web --git-protocol https",
  );
  expect(listRepositories).not.toHaveBeenCalled();
  await act(async () => button("I’ve signed in").click());
  expect(host.textContent).toContain("Connected as octocat");
  expect(host.textContent).toContain("team/app");
});

test("loads beyond the first page and filters repositories by organization", async () => {
  listRepositories.mockResolvedValueOnce({ repositories: [repo], hasMore: true });
  listRepositories.mockResolvedValueOnce({
    repositories: [{ ...repo, id: 2, fullName: "another/service" }],
    hasMore: false,
  });
  await render();
  expect(listRepositories.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Search repositories"]')!.click(),
  );
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "another",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("another/service");
  expect(host.textContent).not.toContain("team/app");
});

test("keeps clone failures reviewable and allows retry", async () => {
  cloneRepository.mockRejectedValueOnce(new Error("Repository access was denied"));
  await render();
  await act(async () => button("team/app").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Repository access was denied",
  );
  expect(onCreated).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  await act(async () => button("team/app").click());
  expect(onCreated).toHaveBeenCalledWith(project);
});

test("sets an optional setup script on the project it creates", async () => {
  await render();
  const toggle = host.querySelector<HTMLButtonElement>(
    '[data-pipper-id="github-project-setup-script-toggle"]',
  )!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector('textarea[aria-label="Setup script"]')).toBeNull();

  await act(async () => button("team/app").click());
  expect(cloneRepository).toHaveBeenLastCalledWith("team/app", { setupScript: null });

  await act(async () => toggle.click());
  const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Setup script"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor,
      'uv sync\ncp "$ROOT_PATH/.env" .env',
    );
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("team/app").click());
  expect(cloneRepository).toHaveBeenLastCalledWith("team/app", {
    setupScript: 'uv sync\ncp "$ROOT_PATH/.env" .env',
  });
  expect(onCreated).toHaveBeenCalledWith(project);
});

test.each(["status", "repositories"])(
  "retries a failed %s request without a window focus change",
  async (request) => {
    const failed = request === "status" ? getStatus : listRepositories;
    failed.mockRejectedValueOnce(new Error("Connection interrupted"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
    let finish!: (value: GitHubCliStatus) => void;
    getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const statusCalls = getStatus.mock.calls.length;
    await act(async () => button("Retry").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button("Retry")).toBeUndefined();
    expect(host.textContent).toContain("Checking GitHub CLI");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(getStatus.mock.calls.length).toBe(statusCalls + 1);
    await act(async () => finish(ready));
    expect(host.textContent).toContain("team/app");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  },
);

test("restarts pagination when retrying a failed later repository page", async () => {
  listRepositories.mockResolvedValueOnce({ repositories: [repo], hasMore: true });
  listRepositories.mockRejectedValueOnce(new Error("Connection interrupted"));
  await render();
  expect(host.textContent).toContain("team/app");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => button("Retry").click());
  expect(listRepositories.mock.calls.map(([page]) => page)).toEqual([1, 2, 1]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelectorAll('button[aria-label="Search repositories"]')).toHaveLength(1);
});

test("rechecks when the user returns from terminal login and works in Strict Mode", async () => {
  getStatus.mockResolvedValue({ ...ready, state: "signed-out", username: null });
  await act(async () =>
    root.render(
      <StrictMode>
        <GitHubProjectPicker onCreated={onCreated} onBusyChange={onBusyChange} />
      </StrictMode>,
    ),
  );
  expect(host.textContent).toContain("Sign in to GitHub");
  getStatus.mockResolvedValue(ready);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(host.textContent).toContain("Connected as octocat");
});

test.each(["basic", "advanced"])(
  "shares onboarding with the %s shell and never chooses a folder for GitHub",
  async (value) => {
    mode.value = value;
    await act(async () =>
      root.render(
        <AuthenticatedStage
          authUser={{ name: "User", email: null }}
          projects={[]}
          selectedId={null}
          isOpening={false}
          isLoading={false}
          loadError={null}
          handleOpen={vi.fn()}
          handleProjectCreated={onCreated}
        />,
      ),
    );
    expect(button("Local").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('input[placeholder="No folder selected"]')).not.toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
    await act(async () => button("GitHub").click());
    expect(host.textContent).toContain("Select a repository");
    expect(host.textContent).not.toContain("No folder selected");
    await act(async () => button("team/app").click());
    expect(onCreated).toHaveBeenCalledWith(project);
    expect(mode.setMode).not.toHaveBeenCalled();
  },
);

test("keeps the active source stable and prevents duplicate selections while cloning", async () => {
  let finish!: (value: typeof project) => void;
  cloneRepository.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () =>
    root.render(
      <AuthenticatedStage
        authUser={{ name: "User", email: null }}
        projects={[]}
        selectedId={null}
        isOpening={false}
        isLoading={false}
        loadError={null}
        handleOpen={vi.fn()}
        handleProjectCreated={onCreated}
      />,
    ),
  );
  await act(async () => button("GitHub").click());
  await act(async () => button("team/app").click());
  expect(button("Local").getAttribute("aria-disabled")).toBe("true");
  expect(button("team/app").disabled).toBe(true);
  await act(async () => {
    button("Local").click();
    button("team/app").click();
  });
  expect(cloneRepository).toHaveBeenCalledOnce();
  expect(button("GitHub").getAttribute("aria-selected")).toBe("true");
  await act(async () => finish(project));
  expect(onCreated).toHaveBeenCalledWith(project);
  expect(button("Local").getAttribute("aria-disabled")).not.toBe("true");
});
