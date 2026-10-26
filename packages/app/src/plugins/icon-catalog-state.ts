export interface CustomIconState {
  phase: "idle" | "loading" | "ready" | "failed" | "unavailable";
  attempts: number;
}

/** One optional module request at a time; only explicit retries after an actual rejection. */
export function createIconCatalog<T>(download: () => Promise<T>) {
  let value: T | null = null;
  let state: CustomIconState = { phase: "idle", attempts: 0 };
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  function publish(next: CustomIconState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function load(): Promise<void> {
    if (value) return Promise.resolve();
    if (pending) return pending;
    if (state.attempts >= 3)
      return Promise.reject(new Error("Optional icon retries exhausted; reload to try again."));
    pending = Promise.resolve()
      .then(download)
      .then(
        (module) => {
          value = module;
          publish({ phase: "ready", attempts: state.attempts });
          return undefined;
        },
        () => {
          publish({ phase: "failed", attempts: state.attempts });
          throw new Error("Optional icon download failed.");
        },
      )
      .finally(() => {
        pending = undefined;
      });
    publish({ phase: "loading", attempts: state.attempts + 1 });
    return pending;
  }
  return {
    load,
    state: () => state,
    value: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
