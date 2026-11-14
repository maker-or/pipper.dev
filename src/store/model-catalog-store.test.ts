import { beforeEach, describe, expect, test, vi } from "vitest";

describe("model-catalog-store", () => {
  beforeEach(() => {
    vi.resetModules();
    // Fresh storage per test so persistence does not leak across cases.
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    });
  });

  test("remember stores models per agent and does not wipe on empty", async () => {
    const { useModelCatalogStore } = await import("./model-catalog-store");
    useModelCatalogStore.setState({ byAgentId: {} });

    useModelCatalogStore.getState().remember("claude-agent-acp", [
      { modelId: "sonnet", name: "Sonnet" },
      { modelId: "opus", name: "Opus" },
    ]);
    useModelCatalogStore.getState().remember("opencode-acp", [{ modelId: "gpt-4", name: "GPT-4" }]);
    // Empty lists must not clobber a known catalog (transient session config).
    useModelCatalogStore.getState().remember("claude-agent-acp", []);

    expect(useModelCatalogStore.getState().modelsForAgents(["claude-agent-acp"])).toEqual([
      { agentId: "claude-agent-acp", modelId: "sonnet", name: "Sonnet" },
      { agentId: "claude-agent-acp", modelId: "opus", name: "Opus" },
    ]);
    expect(
      useModelCatalogStore.getState().modelsForAgents(["opencode-acp", "claude-agent-acp"]),
    ).toEqual([
      { agentId: "opencode-acp", modelId: "gpt-4", name: "GPT-4" },
      { agentId: "claude-agent-acp", modelId: "sonnet", name: "Sonnet" },
      { agentId: "claude-agent-acp", modelId: "opus", name: "Opus" },
    ]);
  });

  test("an account with no known models gets its catalog fetched once, on demand", async () => {
    const getModelCatalogs = vi.fn(async () => ({
      "codex-acp:pujitha": [{ modelId: "gpt-5", name: "GPT-5" }],
    }));
    vi.stubGlobal("window", { omni: { agent: { getModelCatalogs } } });
    const { useModelCatalogStore } = await import("./model-catalog-store");
    useModelCatalogStore.setState({
      byAgentId: { "codex-acp": [{ agentId: "codex-acp", modelId: "o3", name: "o3" }] },
    });

    // Opening the picker twice while the first fetch runs starts one fetch.
    const first = useModelCatalogStore.getState().ensure("codex-acp:pujitha");
    expect(useModelCatalogStore.getState().loading["codex-acp:pujitha"]).toBe(true);
    await Promise.all([first, useModelCatalogStore.getState().ensure("codex-acp:pujitha")]);
    // An account that already has models starts nothing.
    await useModelCatalogStore.getState().ensure("codex-acp");

    expect(getModelCatalogs).toHaveBeenCalledTimes(1);
    expect(getModelCatalogs).toHaveBeenCalledWith({ refresh: ["codex-acp:pujitha"] });
    expect(useModelCatalogStore.getState().modelsForAgents(["codex-acp:pujitha"])).toEqual([
      { agentId: "codex-acp:pujitha", modelId: "gpt-5", name: "GPT-5" },
    ]);
    expect(useModelCatalogStore.getState().loading["codex-acp:pujitha"]).toBeUndefined();
    vi.unstubAllGlobals();
  });

  test("a failed fetch clears loading so picking the provider again retries", async () => {
    const getModelCatalogs = vi
      .fn()
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce({ "codex-acp:ui": [{ modelId: "gpt-5", name: "GPT-5" }] });
    vi.stubGlobal("window", { omni: { agent: { getModelCatalogs } } });
    const { useModelCatalogStore } = await import("./model-catalog-store");
    useModelCatalogStore.setState({ byAgentId: {} });

    await useModelCatalogStore.getState().ensure("codex-acp:ui");
    expect(useModelCatalogStore.getState().loading["codex-acp:ui"]).toBeUndefined();
    await useModelCatalogStore.getState().ensure("codex-acp:ui");

    expect(useModelCatalogStore.getState().modelsForAgents(["codex-acp:ui"])).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  test("persists across store reloads", async () => {
    const { useModelCatalogStore } = await import("./model-catalog-store");
    useModelCatalogStore.setState({ byAgentId: {} });
    useModelCatalogStore.getState().remember("cursor-acp", [{ modelId: "auto", name: "Auto" }]);

    vi.resetModules();
    const reloaded = await import("./model-catalog-store");
    expect(reloaded.useModelCatalogStore.getState().modelsForAgents(["cursor-acp"])).toEqual([
      { agentId: "cursor-acp", modelId: "auto", name: "Auto" },
    ]);
  });
});
