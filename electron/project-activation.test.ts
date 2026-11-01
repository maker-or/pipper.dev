import { describe, expect, test } from "vitest";
import { ActivationSupersededError } from "./activation.ts";
import { activateProjectSelection } from "./project-activation.ts";

function harness(initial: string | null) {
  let active = initial;
  return {
    get active() {
      return active;
    },
    getActiveProjectId: () => active,
    setActiveProjectId: (id: string) => {
      active = id;
    },
  };
}

describe("activateProjectSelection", () => {
  test("a click superseded by a newer one leaves the newer project active", async () => {
    const state = harness("omni");
    let releaseFirst!: () => void;
    // Click "zen": its activation is still loading when "new" is clicked.
    const first = activateProjectSelection({
      ...state,
      projectId: "zen",
      activate: () =>
        new Promise<void>((_resolve, reject) => {
          releaseFirst = () => reject(new ActivationSupersededError());
        }),
    });
    await activateProjectSelection({ ...state, projectId: "new", activate: async () => {} });
    releaseFirst();
    await expect(first).resolves.toEqual({ superseded: true });
    expect(state.active).toBe("new");
  });

  test("a failed activation goes back to the project that was active", async () => {
    const state = harness("omni");
    await expect(
      activateProjectSelection({
        ...state,
        projectId: "zen",
        activate: async () => {
          throw new Error("agent failed to start");
        },
      }),
    ).rejects.toThrow("agent failed to start");
    expect(state.active).toBe("omni");
  });

  test("a successful activation keeps the chosen project", async () => {
    const state = harness(null);
    await expect(
      activateProjectSelection({ ...state, projectId: "zen", activate: async () => {} }),
    ).resolves.toEqual({ superseded: false });
    expect(state.active).toBe("zen");
  });
});
