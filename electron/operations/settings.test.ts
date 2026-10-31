import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AgentTaskConfig } from "../../contracts/agent-tasks.ts";
import type { BrowserConfig } from "../../contracts/acp.ts";
import { DEFAULT_AGENT_TASK_CONFIG } from "../agent-tasks/agent-task-config.ts";
import { callAsAgent, runAsUser, type AgentContext } from "./define.ts";
import {
  configureSettingsOperations,
  ensureSettingChangeSchema,
  getSettings,
  SettingChangeStore,
  undoSettingsChange,
  updateSettings,
} from "./settings.ts";

function fakeSettings() {
  const db = new DatabaseSync(":memory:");
  ensureSettingChangeSchema(db);
  const state = {
    agentTasks: { ...DEFAULT_AGENT_TASK_CONFIG } as AgentTaskConfig,
    browser: {
      enabled: true,
      pagesPerSession: 4,
      idleMinutes: 5,
      downloads: "ask",
    } as BrowserConfig,
    autoInstall: true,
  };
  configureSettingsOperations({
    getAgentTasks: () => state.agentTasks,
    setAgentTasks: async (partial) => (state.agentTasks = { ...state.agentTasks, ...partial }),
    getBrowser: () => state.browser,
    setBrowser: async (partial) => (state.browser = { ...state.browser, ...partial }),
    getAutoInstall: () => state.autoInstall,
    setAutoInstall: (enabled) => {
      state.autoInstall = enabled;
    },
    changes: new SettingChangeStore(() => db),
  });
  return state;
}

function agent(threadId = "caller"): AgentContext {
  return {
    caller: { kind: "agent", threadId },
    lineage: [threadId],
    owns: (id) => id === threadId,
  };
}

afterEach(() => configureSettingsOperations(null));

describe("settings", () => {
  test("get_settings groups every setting by area, in the tool's units", async () => {
    fakeSettings();
    const settings = await runAsUser(getSettings, {});
    expect(settings.browser).toEqual({
      enabled: true,
      pages_per_session: 4,
      idle_minutes: 5,
      downloads: "ask",
    });
    expect(settings.agent_tasks).toMatchObject({
      start_approval: "ask",
      turn_timeout_minutes: 30,
      allowed_agents: "all",
    });
    expect(settings.workspaces).toEqual({ install_dependencies: true });
  });

  test("a change that only tightens applies at once and is recorded for the thread", async () => {
    const state = fakeSettings();
    const outcome = await callAsAgent(
      updateSettings,
      {
        browser: { enabled: false, pages_per_session: 2 },
        workspaces: { install_dependencies: true },
      },
      agent(),
    );

    if (outcome.status !== "done") throw new Error("expected done");
    expect(state.browser).toMatchObject({ enabled: false, pagesPerSession: 2 });
    // install_dependencies was already on: not a change.
    expect(
      outcome.result.changes.map((change) => [change.path, change.toText, change.applies]),
    ).toEqual([
      ["browser.enabled", "off", "new_threads"],
      ["browser.pages_per_session", "2 pages", "now"],
    ]);
    expect(outcome.result.changeId).toEqual(expect.any(String));
  });

  test("a change that widens what agents can do needs a grant, listing only the widening lines", async () => {
    const state = fakeSettings();
    state.browser.enabled = false;
    const outcome = await callAsAgent(
      updateSettings,
      {
        browser: { enabled: true, idle_minutes: 2 },
        agent_tasks: { start_approval: "allow", turn_timeout_minutes: 60 },
      },
      agent(),
    );

    expect(outcome).toMatchObject({
      status: "needs_grant",
      grant: {
        title: "Change Pipper settings",
        changes: [
          "Starting subthreads: ask first → allowed",
          "Subthread turn limit: 30 minutes → 60 minutes",
          "Browser for agents: off → on",
        ],
      },
    });
    // Nothing applied before the user answers.
    expect(state.browser.enabled).toBe(false);
  });

  test("a list of allowed agents widens only when it adds an agent", async () => {
    const state = fakeSettings();
    state.agentTasks.allowedAgents = ["codex", "claude"];
    const narrower = await callAsAgent(
      updateSettings,
      { agent_tasks: { allowed_agents: ["codex"] } },
      agent(),
    );
    expect(narrower.status).toBe("done");
    const wider = await callAsAgent(
      updateSettings,
      { agent_tasks: { allowed_agents: ["codex", "gemini"] } },
      agent(),
    );
    expect(wider.status).toBe("needs_grant");
  });

  test("out-of-range values are refused, not clamped", async () => {
    fakeSettings();
    await expect(
      callAsAgent(updateSettings, { browser: { pages_per_session: 50 } }, agent()),
    ).rejects.toThrow(/pages_per_session/);
    await expect(
      callAsAgent(updateSettings, { browser: { colour: "red" } }, agent()),
    ).rejects.toThrow();
  });

  test("the user's undo puts every setting back, once", async () => {
    const state = fakeSettings();
    const outcome = await callAsAgent(
      updateSettings,
      { browser: { enabled: false }, agent_tasks: { max_depth: 1, notify_parent: false } },
      agent(),
    );
    if (outcome.status !== "done") throw new Error("expected done");

    const undone = await runAsUser(undoSettingsChange, { change: outcome.result.changeId });

    expect(undone.undone).toBe(true);
    expect(state.browser.enabled).toBe(true);
    expect(state.agentTasks.notifyParent).toBe(true);
    await expect(
      undoSettingsChange.run({ change: outcome.result.changeId! }, agent()),
    ).rejects.toThrow(/Only the user/);
  });
});
