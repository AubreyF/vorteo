interface WorkerShutdownPorts {
  stop(): Promise<void>;
  forceExit(): void;
  now(): number;
}

/** One budget includes every asynchronous shutdown stage. Supervisor cleanup
 * remains independent of this timer if the worker's event loop stalls. */
export function createWorkerShutdown(ports: WorkerShutdownPorts) {
  let result: Promise<void> | null = null;
  let deadline = Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectDeadline: ((error: Error) => void) | null = null;
  let settled = false;

  function begin(terminateAt?: number): Promise<void> {
    const now = ports.now();
    const requested = terminateAt === undefined ? now + 10_000 : terminateAt;
    if (!Number.isSafeInteger(requested) || requested > now + 300_000)
      return Promise.reject(new Error("Invalid supervisor shutdown deadline"));
    if (settled) return result!;
    if (requested < deadline) {
      deadline = requested;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => {
          rejectDeadline!(new Error("Worker shutdown deadline expired; cleanup is incomplete"));
          ports.forceExit();
        },
        Math.max(0, deadline - now),
      );
    }
    if (!result) {
      const expired = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
      });
      // Install the shared promise before invoking stop, including synchronous
      // shutdown hooks that may request shutdown again.
      result = Promise.race([expired, Promise.resolve().then(() => ports.stop())]).finally(() => {
        settled = true;
        if (timer !== null) clearTimeout(timer);
      });
    }
    return result;
  }

  return { begin };
}
