import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { SubagentComposer } from "@/components/subagent-composer";
import { AgentTaskActivity, AgentTaskOrigin } from "@/components/agent-task-activity";

function agent(id: string, displayName: string, available = true): AcpAgentDescriptor {
  return { id, name: id, displayName, command: id, args: [], available };
}

const AGENTS = [
  agent("claude-agent-acp", "Claude"),
  agent("codex-acp", "Codex"),
  agent("gemini-acp", "Gemini", false),
];

/** The opening tag of the button whose label is "Start orchestration". */
function submitButtonTag(html: string): string {
  const labelIndex = html.indexOf("Start orchestration");
  expect(labelIndex).toBeGreaterThan(-1);
  const buttonIndex = html.lastIndexOf("<button", labelIndex);
  return html.slice(buttonIndex, html.indexOf(">", buttonIndex) + 1);
}

function task(
  taskId: string,
  status: AgentTaskSnapshot["status"],
  extra: Partial<AgentTaskSnapshot> = {},
): AgentTaskSnapshot {
  return {
    taskId,
    parentThreadId: "parent",
    childThreadId: `child-${taskId}`,
    projectId: "project",
    agentId: "codex-acp",
    title: `task for ${taskId}`,
    status,
    outcome: status === "idle" ? "done" : null,
    waitingForPermission: false,
    workspaceMode: "shared",
    workspacePath: "/repo",
    branch: null,
    depth: 1,
    turns: 0,
    createdAt: 1,
    updatedAt: 1,
    reportPreview: null,
    nextStep: null,
    error: null,
    ...extra,
  };
}

const noop = () => {};

describe("SubagentComposer", () => {
  test("offers only installed agents as orchestrators and blocks submit until a goal exists", () => {
    const html = renderToStaticMarkup(
      <SubagentComposer
        agents={AGENTS}
        defaultOrchestratorId="codex-acp"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Names live on the icon-only tabs as accessible labels, not visible text.
    expect(html).toContain('aria-label="Claude"');
    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('aria-label="Orchestrator"');
    expect(html).toContain('role="tablist"');
    // Not installed → not offered.
    expect(html).not.toContain("Gemini");
    // Auto mode is the default, and an empty goal blocks submission.
    expect(html).toContain("The orchestrator splits the goal across this many subagents.");
    expect(html).toMatch(/What should the orchestrator achieve/);
    expect(submitButtonTag(html)).toContain('disabled=""');
  });

  test("a seeded goal (from “/subagent <text>”) makes the draft immediately submittable", () => {
    const html = renderToStaticMarkup(
      <SubagentComposer
        agents={AGENTS}
        defaultOrchestratorId={null}
        initialGoal="fix the login flow"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("fix the login flow");
    expect(html).not.toMatch(/Describe the goal/);
    expect(submitButtonTag(html)).not.toContain('disabled=""');
  });
});

describe("AgentTaskActivity", () => {
  const render = (tasks: AgentTaskSnapshot[], parentThreadId: string | null = "parent") =>
    renderToStaticMarkup(
      <AgentTaskActivity
        tasks={tasks}
        agents={AGENTS}
        parentThreadId={parentThreadId}
        onOpenThread={noop}
      />,
    );

  test("renders nothing when there are no tasks", () => {
    expect(render([])).toBe("");
  });

  test("shows running tasks and tasks waiting on someone, not settled ones", () => {
    const html = render([
      task("run", "running"),
      task("start", "starting"),
      task("perm", "running", { waitingForPermission: true }),
      task("ask", "idle", { outcome: "needs_input" }),
      task("done", "idle"),
      task("fail", "failed"),
      task("gone", "cancelled"),
    ]);
    expect(html).toContain("task for run");
    expect(html).toContain("task for start");
    expect(html).toContain("task for perm");
    expect(html).toContain("Needs permission");
    expect(html).toContain("task for ask");
    expect(html).toContain("Has a question");
    expect(html).not.toContain("task for done");
    expect(html).not.toContain("task for fail");
    expect(html).not.toContain("task for gone");
    expect(html).toContain("Codex");
  });

  test("scopes tasks to the viewed thread", () => {
    const html = render([
      task("mine", "running"),
      task("other", "running", { parentThreadId: "another-thread" }),
    ]);
    expect(html).toContain("task for mine");
    expect(html).not.toContain("task for other");
  });

  test("renders nothing when no thread is being viewed", () => {
    expect(render([task("a1", "running")], null)).toBe("");
  });
});

describe("AgentTaskOrigin", () => {
  test("shows only in a task's own thread, with its status and a way back", () => {
    const tasks = [task("t1", "idle", { outcome: "needs_input" })];
    const inChild = renderToStaticMarkup(
      <AgentTaskOrigin tasks={tasks} threadId="child-t1" onOpenThread={noop} />,
    );
    expect(inChild).toContain("Task started by another agent");
    expect(inChild).toContain("Has a question");
    expect(inChild).toContain("Open parent thread");
    expect(
      renderToStaticMarkup(<AgentTaskOrigin tasks={tasks} threadId="parent" onOpenThread={noop} />),
    ).toBe("");
  });
});
