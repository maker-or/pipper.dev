import { create } from "zustand";

/**
 * Per-agent model catalogs learned from live ACP sessions.
 *
 * Draft composers need models *before* a session exists for the chosen agent.
 * Session config options only arrive after connect, so we cache the last-seen
 * model list for each agent and reuse it in the draft @model picker.
 *
 * Persisted so restarting the app still offers models for agents the user has
 * already connected to.
 */

export type CatalogModel = {
  agentId: string;
  modelId: string;
  name: string;
  provider?: string;
};

const STORAGE_KEY = "pipper.model-catalog.v1";

function loadPersisted(): Record<string, CatalogModel[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, CatalogModel[]> = {};
    for (const [agentId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const models: CatalogModel[] = [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const modelId = (item as { modelId?: unknown }).modelId;
        const name = (item as { name?: unknown }).name;
        const provider = (item as { provider?: unknown }).provider;
        if (typeof modelId !== "string" || !modelId) continue;
        models.push({
          agentId,
          modelId,
          name: typeof name === "string" && name ? name : modelId,
          provider: typeof provider === "string" ? provider : undefined,
        });
      }
      if (models.length > 0) out[agentId] = models;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(byAgentId: Record<string, CatalogModel[]>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(byAgentId));
  } catch {
    // Quota / private mode — catalog still works in-memory for the session.
  }
}

function listsEqual(a: CatalogModel[] | undefined, b: CatalogModel[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.modelId !== right.modelId ||
      left.name !== right.name ||
      left.provider !== right.provider
    )
      return false;
  }
  return true;
}

interface ModelCatalogState {
  byAgentId: Record<string, CatalogModel[]>;
  /**
   * Record models advertised by an agent session. Empty lists are ignored so a
   * transient session without a model option does not wipe a known catalog.
   */
  remember: (
    agentId: string,
    models: Array<{ modelId: string; name: string; provider?: string }>,
  ) => void;
  /** Flat list for one or more agents (order preserved by agentIds then catalog). */
  modelsForAgents: (agentIds: readonly string[]) => CatalogModel[];
  /** Agents whose catalog is being fetched by `ensure`. */
  loading: Record<string, boolean>;
  /**
   * Fetch an agent's catalog when none is known yet — e.g. an account that
   * was added in Settings but never used, picked in the model picker. This
   * starts that agent once (the user is about to use it); agents with a
   * catalog, or a fetch already running, start nothing.
   */
  ensure: (agentId: string) => Promise<void>;
}

export const useModelCatalogStore = create<ModelCatalogState>((set, get) => ({
  byAgentId: loadPersisted(),

  remember: (agentId, models) => {
    if (!agentId || models.length === 0) return;
    const next: CatalogModel[] = models.map((m) => ({
      agentId,
      modelId: m.modelId,
      name: m.name || m.modelId,
      provider: m.provider,
    }));
    const prev = get().byAgentId[agentId];
    if (listsEqual(prev, next)) return;
    set((state) => {
      const byAgentId = { ...state.byAgentId, [agentId]: next };
      persist(byAgentId);
      return { byAgentId };
    });
  },

  loading: {},

  ensure: async (agentId) => {
    const { byAgentId, loading } = get();
    if (!agentId || byAgentId[agentId]?.length || loading[agentId]) return;
    const getModelCatalogs =
      typeof window === "undefined" ? undefined : window.omni?.agent?.getModelCatalogs;
    if (!getModelCatalogs) return;
    set((state) => ({ loading: { ...state.loading, [agentId]: true } }));
    try {
      const catalogs = await getModelCatalogs({ refresh: [agentId] });
      for (const [id, models] of Object.entries(catalogs ?? {})) get().remember(id, models);
    } catch {
      // The picker shows "no models" again; choosing the provider retries.
    } finally {
      set((state) => {
        const next = { ...state.loading };
        delete next[agentId];
        return { loading: next };
      });
    }
  },

  modelsForAgents: (agentIds) => {
    const { byAgentId } = get();
    const out: CatalogModel[] = [];
    for (const agentId of agentIds) {
      const list = byAgentId[agentId];
      if (list) out.push(...list);
    }
    return out;
  },
}));
