import { describe, expect, test } from "vitest";
import { resolveTerminalWorkspace } from "./terminal-workspace";

const project = { id: "project-a", path: "/project-a" };

describe("new terminal workspace", () => {
  test.each(["/project-a", "/project-a/worktrees/current"])(
    "follows the current thread cwd %s while selection still names another workspace",
    (cwd) => {
      expect(
        resolveTerminalWorkspace({
          preferThread: true,
          thread: { threadId: "thread-a", projectId: project.id, cwd },
          project,
          selectedPath: "/project-a/worktrees/old",
        }),
      ).toEqual({ projectId: project.id, cwd });
    },
  );

  test("follows the thread before the active project mirror catches up", () => {
    expect(
      resolveTerminalWorkspace({
        preferThread: true,
        thread: { threadId: "thread-b", projectId: "project-b", cwd: "/project-b" },
        project,
        selectedPath: "/project-a/worktrees/old",
      }),
    ).toEqual({ projectId: "project-b", cwd: "/project-b" });
  });

  test("a draft uses the selected workspace while an older thread remains loaded", () => {
    expect(
      resolveTerminalWorkspace({
        preferThread: false,
        thread: { threadId: "thread-a", projectId: project.id, cwd: project.path },
        project,
        selectedPath: "/project-a/worktrees/current",
      }),
    ).toEqual({ projectId: project.id, cwd: "/project-a/worktrees/current" });
  });

  test("drafts use the selected workspace instead of a previous live thread", () => {
    expect(
      resolveTerminalWorkspace({
        preferThread: false,
        thread: { threadId: "thread-b", projectId: "project-b", cwd: "/project-b" },
        project,
        selectedPath: project.path,
      }),
    ).toEqual({ projectId: project.id, cwd: project.path });
  });

  test("without a live thread or saved selection, uses the project directory", () => {
    expect(
      resolveTerminalWorkspace({ preferThread: true, thread: null, project, selectedPath: null }),
    ).toEqual({ projectId: project.id, cwd: project.path });
  });

  test("does not treat an idle snapshot as a thread workspace", () => {
    expect(
      resolveTerminalWorkspace({
        preferThread: true,
        thread: { threadId: null, projectId: "project-b", cwd: "/project-b" },
        project,
        selectedPath: project.path,
      }),
    ).toEqual({ projectId: project.id, cwd: project.path });
  });

  test("no thread or project leaves the terminal's default directory unchanged", () => {
    expect(
      resolveTerminalWorkspace({
        preferThread: true,
        thread: null,
        project: null,
        selectedPath: null,
      }),
    ).toBeNull();
  });
});
