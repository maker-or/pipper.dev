import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AcpAgentDescriptor } from "../../contracts/acp.ts";
import type { AgentTaskSnapshot } from "../../contracts/agent-tasks.ts";
import { SubthreadComposer } from "@/components/subthread-composer";
import { AgentTaskOrigin } from "@/components/agent-task-activity";

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

describe("SubthreadComposer", () => {
  test("offers only installed agents as orchestrators and blocks submit until a goal exists", () => {
    const html = renderToStaticMarkup(
      <SubthreadComposer
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
    expect(html).toContain("The orchestrator splits the goal across this many subthreads.");
    expect(html).toMatch(/What should the orchestrator achieve/);
    expect(submitButtonTag(html)).toContain('disabled=""');
  });

  test("a seeded goal (from “/subagent <text>”) makes the draft immediately submittable", () => {
    const html = renderToStaticMarkup(
      <SubthreadComposer
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

describe("AgentTaskOrigin", () => {
  const titles = (id: string) => (id === "parent" ? "Build auth" : null);

  test("in a subthread: a breadcrumb from the parent's title to the task, with its status", () => {
    const tasks = [task("t1", "idle", { outcome: "needs_input" })];
    const inChild = renderToStaticMarkup(
      <AgentTaskOrigin
        tasks={tasks}
        threadId="child-t1"
        threadTitle={titles}
        onOpenThread={noop}
      />,
    );
    expect(inChild).toContain('title="Back to Build auth"');
    expect(inChild).toContain("task for t1");
    expect(inChild).toContain("Has a question");
    expect(
      renderToStaticMarkup(
        <AgentTaskOrigin
          tasks={tasks}
          threadId="parent"
          threadTitle={titles}
          onOpenThread={noop}
        />,
      ),
    ).toBe("");
  });

  test("a parent Pipper hasn't loaded reads as the parent thread", () => {
    const html = renderToStaticMarkup(
      <AgentTaskOrigin
        tasks={[task("t1", "running")]}
        threadId="child-t1"
        threadTitle={() => null}
        onOpenThread={noop}
      />,
    );
    expect(html).toContain("Back to Parent thread");
  });
});
