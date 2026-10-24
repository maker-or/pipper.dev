import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: () => process.env.PIPPER_LIBRARY_PATH ?? process.env.TMPDIR ?? "/tmp",
    connect: vi.fn(),
  },
}));
vi.mock("./agent-instances.ts", () => ({
  listAgentInstanceDescriptors: () => [{ id: "pipper-mock" }],
}));

import type { WorktreeSetupProgress } from "../contracts/worktrees.ts";
import type { AgentManager } from "./agent-connection-manager.ts";
import { prepareIsolatedAgentTask } from "./isolated-agent-task.ts";
import { createProject } from "./projects.ts";
import { createThread } from "./threads.ts";
import {
  getProjectSetupScript,
  MAX_SETUP_SCRIPT_LENGTH,
  setProjectSetupScript,
  suggestSetupScript,
} from "./project-setup-script.ts";
import {
  createWorkspace,
  setupScriptInvocation,
  setWorkspaceInstallRunnerForTests,
  setWorkspaceSetupProgressSink,
  type WorkspaceSetupJob,
} from "./workspace-lifecycle.ts";
import { setWorktreeAutoInstall } from "./worktree-preferences.ts";

// One library root for the file: db.ts caches its handle on first use.
const root = mkdtempSync(join(tmpdir(), "pipper-workspace-lifecycle-"));
process.env.PIPPER_LIBRARY_PATH = root;
process.env.PIPPER_WORKTREES_PATH = join(root, "worktrees");

afterAll(async () => {
  const { closeDb } = await import("./db.ts");
  closeDb();
  delete process.env.PIPPER_LIBRARY_PATH;
  delete process.env.PIPPER_WORKTREES_PATH;
  rmSync(root, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let repoCount = 0;
function nodeProject() {
  const path = join(root, `repo-${++repoCount}`);
  mkdirSync(path, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: path, env: GIT_ENV });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(path, "package.json"), "{}\n");
  writeFileSync(join(path, "bun.lock"), "{}\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return createProject({ name: `repo-${repoCount}`, path, icon: "folder" });
}

function fakeAgentManager(options: { fail?: boolean } = {}): AgentManager {
  return {
    createThread: async (
      projectId: string,
      title: string | null,
      _after: string | null,
      agentId: string,
      worktreePath: string,
    ) => {
      if (options.fail) throw new Error("agent unavailable");
      return createThread(
        projectId,
        title,
        agentId,
        `session-${Date.now()}`,
        undefined,
        worktreePath,
      );
    },
    sendPrompt: async () => {},
  } as unknown as AgentManager;
}

let progress: WorktreeSetupProgress[];
let installs: WorkspaceSetupJob[];

beforeEach(() => {
  progress = [];
  installs = [];
  setWorkspaceSetupProgressSink((event) => progress.push(event));
  setWorkspaceInstallRunnerForTests(async (job) => {
    installs.push(job);
    return { status: "installed", manager: "bun" };
  });
});

afterEach(() => {
  setWorkspaceSetupProgressSink(null);
  setWorkspaceInstallRunnerForTests(null);
  setWorktreeAutoInstall(true);
});

function setupSummary(worktreePath: string) {
  return progress
    .filter((event) => event.worktreePath === worktreePath)
    .map(({ status, policy, manager }) => ({ status, policy, manager }));
}

async function createBoth() {
  const project = nodeProject();
  const desktop = await createWorkspace({
    projectId: project.id,
    name: "desktop-feature",
    activation: "foreground",
  });
  await desktop.setup;
  const agentId = "pipper-mock";
  const remote = await prepareIsolatedAgentTask(fakeAgentManager(), project.id, agentId, "hi");
  const remotePath = remote.result.thread.worktreePath!;
  // The remote setup runs in the background behind the create call.
  await vi.waitFor(() => expect(setupSummary(remotePath).at(-1)?.status).not.toBe("installing"));
  return { desktopPath: desktop.worktree.path, remotePath, desktopPolicy: desktop.policy };
}

describe("shared workspace lifecycle", () => {
  test("desktop and remote creation apply the same prepared setup", async () => {
    const { desktopPath, remotePath, desktopPolicy } = await createBoth();
    expect(desktopPolicy).toBe("prepared");
    expect(setupSummary(remotePath)).toEqual(setupSummary(desktopPath));
    expect(setupSummary(desktopPath)).toEqual([
      { status: "installing", policy: "prepared", manager: "bun" },
      { status: "installed", policy: "prepared", manager: "bun" },
    ]);
    expect(installs.map((job) => job.worktreePath)).toEqual([desktopPath, remotePath]);
    // Only the activation differs, so remote progress stays out of the way.
    expect(progress.find((event) => event.worktreePath === remotePath)?.activation).toBe(
      "background",
    );
    expect(progress.find((event) => event.worktreePath === desktopPath)?.activation).toBe(
      "foreground",
    );
  });

  test("with automatic install off both entry points stay source-only", async () => {
    setWorktreeAutoInstall(false);
    const { desktopPath, remotePath, desktopPolicy } = await createBoth();
    expect(desktopPolicy).toBe("source-only");
    expect(setupSummary(remotePath)).toEqual(setupSummary(desktopPath));
    expect(setupSummary(desktopPath)).toEqual([
      { status: "skipped", policy: "source-only", manager: "bun" },
    ]);
    expect(installs).toEqual([]);
  });

  test("a remote task that cannot bind a thread removes only its own workspace", async () => {
    const project = nodeProject();
    const kept = await createWorkspace({
      projectId: project.id,
      name: "kept",
      activation: "foreground",
    });
    const agentId = "pipper-mock";
    await expect(
      prepareIsolatedAgentTask(fakeAgentManager({ fail: true }), project.id, agentId, "hi"),
    ).rejects.toThrow("agent unavailable");
    const remoteJob = progress.find(
      (event) => event.activation === "background" && event.projectId === project.id,
    );
    expect(remoteJob).toBeDefined();
    expect(existsSync(remoteJob!.worktreePath)).toBe(false);
    expect(existsSync(kept.worktree.path)).toBe(true);
  });
});

describe("project setup script", () => {
  test("a project's script replaces the automatic install, even with it turned off", async () => {
    setWorktreeAutoInstall(false);
    const project = nodeProject();
    setProjectSetupScript(
      project.id,
      [
        "# comments and blank lines are fine",
        "",
        'echo "$WORKSPACE_NAME" > name.txt',
        "pwd -P > cwd.txt",
        'test "$ROOT_PATH" = "' + project.path + '" && echo ok > root.txt',
      ].join("\n"),
    );
    const created = await createWorkspace({
      projectId: project.id,
      name: "scripted",
      activation: "foreground",
    });
    const outcome = await created.setup;

    expect(outcome).toMatchObject({ status: "installed", source: "script" });
    expect(installs).toEqual([]);
    const path = created.worktree.path;
    expect(readFileSync(join(path, "name.txt"), "utf8").trim()).toBe("scripted");
    expect(readFileSync(join(path, "cwd.txt"), "utf8").trim()).toBe(path);
    expect(readFileSync(join(path, "root.txt"), "utf8").trim()).toBe("ok");
    expect(
      progress
        .filter((e) => e.worktreePath === path)
        .map(({ status, source }) => ({ status, source })),
    ).toEqual([
      { status: "installing", source: "script" },
      { status: "installed", source: "script" },
    ]);
  }, 30_000);

  test("the script stops at the first failing command and reports it", async () => {
    const project = nodeProject();
    setProjectSetupScript(project.id, "echo first > first.txt\nfalse\necho after > after.txt");
    const created = await createWorkspace({
      projectId: project.id,
      name: "failing-script",
      activation: "foreground",
    });
    const outcome = await created.setup;

    expect(outcome).toMatchObject({ status: "failed", source: "script" });
    expect(outcome.message).toMatch(/Setup script exited with code 1/);
    expect(existsSync(join(created.worktree.path, "first.txt"))).toBe(true);
    expect(existsSync(join(created.worktree.path, "after.txt"))).toBe(false);
    // A failed setup keeps the workspace; it only reports.
    expect(existsSync(created.worktree.path)).toBe(true);
  }, 30_000);

  test("saving normalizes, blank clears, and oversized scripts are rejected", () => {
    const project = nodeProject();
    expect(setProjectSetupScript(project.id, "  bun install\r\nbun run build \n")).toBe(
      "bun install\nbun run build",
    );
    expect(getProjectSetupScript(project.id)).toBe("bun install\nbun run build");
    expect(setProjectSetupScript(project.id, "   \n ")).toBeNull();
    expect(getProjectSetupScript(project.id)).toBeNull();
    expect(() =>
      setProjectSetupScript(project.id, "x".repeat(MAX_SETUP_SCRIPT_LENGTH + 1)),
    ).toThrow(/too long/);
  });

  test("suggestions cover more than JavaScript", () => {
    const dir = (files: string[]) => {
      const path = mkdtempSync(join(root, "suggest-"));
      for (const file of files) writeFileSync(join(path, file), "");
      return path;
    };
    expect(suggestSetupScript(dir(["package.json", "bun.lock"]))).toBe("bun install");
    expect(suggestSetupScript(dir(["Cargo.toml"]))).toBe("cargo fetch");
    expect(suggestSetupScript(dir(["pyproject.toml", "uv.lock"]))).toBe("uv sync");
    expect(suggestSetupScript(dir(["go.mod"]))).toBe("go mod download");
    expect(suggestSetupScript(dir(["README.md"]))).toBeNull();
  });

  test("scripts run in a login POSIX shell, or cmd on Windows", () => {
    expect(setupScriptInvocation("a\nb", "darwin", "/bin/zsh")).toEqual({
      command: "/bin/zsh",
      args: ["-l", "-c", "set -e\na\nb"],
    });
    // Shells with other syntax (fish, nu) fall back to sh.
    expect(setupScriptInvocation("a", "darwin", "/opt/homebrew/bin/fish").command).toBe("/bin/sh");
    expect(setupScriptInvocation("rem note\n# note\nnpm ci\n\nnpm run build", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm ci && npm run build"],
    });
  });
});
