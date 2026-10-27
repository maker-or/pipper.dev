/**
 * Saves partial settings changes the way a settings page needs:
 *
 * - Debounced: sliders report every step while dragging; one save once they
 *   settle (or at once for toggles).
 * - In order: saves run one at a time, in the order the user made them. Each
 *   save writes the whole config on the other side, so an older one must
 *   never land last.
 * - Newest wins: a save's response is applied only if nothing changed since
 *   it was sent, so a late reply can't undo a newer value.
 * - Nothing lost: `dispose` (the page closing) still sends a pending change.
 */
export function createSettingsSaver<T extends object>(options: {
  save: (changes: Partial<T>) => Promise<T>;
  onSaved: (saved: T) => void;
  onError: (error: unknown) => void;
  debounceMs: number;
}) {
  let pending: Partial<T> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let version = 0;
  let disposed = false;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (Object.keys(pending).length === 0) return;
    const changes = pending;
    pending = {};
    const sentAt = version;
    chain = chain
      .catch(() => undefined)
      .then(() => options.save(changes))
      .then((saved) => {
        if (!disposed && sentAt === version) options.onSaved(saved);
      })
      .catch((error: unknown) => {
        if (!disposed) options.onError(error);
      });
  };

  return {
    update(partial: Partial<T>, immediate = false) {
      version += 1;
      pending = { ...pending, ...partial };
      if (timer) clearTimeout(timer);
      if (immediate) flush();
      else timer = setTimeout(flush, options.debounceMs);
    },
    /** Send any pending change now, then stop reporting results. */
    dispose() {
      flush();
      disposed = true;
    },
    /** Resolves once every save sent so far has finished. */
    idle(): Promise<void> {
      return chain.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}
