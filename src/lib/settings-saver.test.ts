import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSettingsSaver } from "./settings-saver";

type Config = { enabled: boolean; pages: number };

function harness() {
  const calls: Array<{ changes: Partial<Config>; resolve: (saved: Config) => void }> = [];
  const saved: Config[] = [];
  const saver = createSettingsSaver<Config>({
    save: (changes) => new Promise((resolve) => calls.push({ changes, resolve })),
    onSaved: (value) => saved.push(value),
    onError: () => undefined,
    debounceMs: 300,
  });
  return { saver, calls, saved };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings saver", () => {
  test("saves run in order, and a late reply doesn't undo a newer change", async () => {
    const { saver, calls, saved } = harness();
    saver.update({ enabled: false }, true);
    saver.update({ enabled: true }, true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // The second save waits for the first.
    expect(calls).toHaveLength(1);

    calls[0].resolve({ enabled: false, pages: 4 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].changes).toEqual({ enabled: true });
    // The first reply is older than the second change, so it isn't applied.
    expect(saved).toEqual([]);

    calls[1].resolve({ enabled: true, pages: 4 });
    await saver.idle();
    expect(saved).toEqual([{ enabled: true, pages: 4 }]);
  });

  test("slider steps are saved once they settle", async () => {
    const { saver, calls } = harness();
    saver.update({ pages: 2 });
    saver.update({ pages: 3 });
    vi.advanceTimersByTime(299);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].changes).toEqual({ pages: 3 });
  });

  test("leaving the page within the debounce window still saves the change", async () => {
    const { saver, calls, saved } = harness();
    saver.update({ pages: 6 });
    saver.dispose();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].changes).toEqual({ pages: 6 });
    calls[0].resolve({ enabled: true, pages: 6 });
    await saver.idle();
    // The page is gone; nothing is reported back to it.
    expect(saved).toEqual([]);
  });
});
