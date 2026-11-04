// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Project } from "../../contracts/projects.ts";
import { useAgentRegistryStore } from "@/store/agent-registry-store";
import { ProjectThreadsDropdown } from "./project-threads-dropdown";

let host: HTMLDivElement;
let root: Root;
const project: Project = { id: "project-1", name: "web", path: "/repo/web", icon: "circle" };

const thread = (id: string, agentId: string, title: string) => ({
  id,
  project_id: project.id,
  agent_id: agentId,
  agent_session_id: `${id}-session`,
  title,
  created_at: 1,
  last_used_at: 1,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "omni", {
    configurable: true,
    value: {
      threads: {
        listProject: vi.fn(async () => ({
          threads: [
            thread("t1", "codex", "Fix the build"),
            thread("t2", "claude-code", "Write the docs"),
            thread("t3", "retired-agent", "Old work"),
          ],
          hasMore: false,
          nextOffset: 3,
        })),
      },
    },
  });
  useAgentRegistryStore.setState({
    agents: [
      { id: "codex", displayName: "Codex", icon: "openai-codex" },
      { id: "claude-code", displayName: "Claude Code", icon: "claude" },
    ] as never,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

test("each thread in the history shows the agent it runs on", async () => {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectThreadsDropdown project={project} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button[aria-label='Project threads']")!.click();
  });

  // A menu item draws its icon twice for its hover state; count each row once.
  const logos = [
    ...new Set(
      [...host.querySelectorAll("svg[role=img]")].map((svg) => svg.getAttribute("aria-label")),
    ),
  ];
  // An agent that's no longer in the catalog still gets a mark, named by its id.
  expect(logos).toEqual(["Codex", "Claude Code", "retired-agent"]);
  expect(host.textContent).toContain("Fix the build");
});
