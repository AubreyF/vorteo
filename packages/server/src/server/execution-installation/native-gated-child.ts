import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Writable } from "node:stream";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";

export interface NativeGatedChildSpawn {
  (file: string, argv: string[], options: SpawnOptions): ChildProcess;
}
export interface NativeGatedChildInput {
  file: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd?: string;
}

function requireLocal(value: unknown, message: string): asserts value {
  if (!value) throw new BootstrapRequestConflict(message);
}

/** Local process/stream mechanics only. The caller independently supplies native
 * custody and lifecycle admission before either synchronous attempt. No callback,
 * policy check, signal, retry or settlement proof is provided by this helper. */
export function createRetainedNativeChild(
  input: NativeGatedChildInput,
  spawnChild: NativeGatedChildSpawn = spawn,
) {
  const file = input.file,
    argv = [...input.argv],
    env = { ...input.env },
    cwd = input.cwd;
  let launchAttempted = false,
    releaseAttempted = false,
    spawnObserved = false,
    childExited = false,
    childClosed = false,
    queueCallback = false,
    gateClosed = false,
    gateFinished = false;
  let child: ChildProcess | null = null,
    writer: Writable | null = null,
    spawned: Promise<void> | null = null;
  const errors = new Set<string>();
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const truncated = { stdout: false, stderr: false };
  function retainOutput(kind: "stdout" | "stderr", bytes: Buffer | string) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const available = 8192 - output[kind].length;
    if (data.length > available) truncated[kind] = true;
    if (available > 0) output[kind] = Buffer.concat([output[kind], data.subarray(0, available)]);
    // Keep draining after the retained diagnostic prefix is full.
  }
  function assertLocalCurrent() {
    requireLocal(
      child !== null &&
        child.pid !== undefined &&
        spawnObserved &&
        !childExited &&
        !childClosed &&
        !gateClosed &&
        !gateFinished &&
        errors.size === 0 &&
        writer !== null &&
        !writer.destroyed &&
        !writer.writableEnded,
      "Retained native gated child is unavailable",
    );
  }
  return {
    /** Called synchronously at the owner's already admitted construction boundary.
     * Spawn confirmation is deliberately a separate asynchronous operation. */
    attemptSpawn(): void {
      requireLocal(
        !launchAttempted,
        "Native gated child launch was already attempted; observe only",
      );
      launchAttempted = true;
      child = spawnChild(file, [...argv], {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: { ...env },
        ...(cwd === undefined ? {} : { cwd }),
      });
      const actualChild = child;
      spawned = new Promise<void>((resolve, reject) => {
        actualChild.once("spawn", () => {
          spawnObserved = true;
          resolve();
        });
        actualChild.on("error", () => {
          errors.add("child");
          reject(new BootstrapRequestConflict("Native gated child spawn is unconfirmed"));
        });
        actualChild.on("exit", () => {
          childExited = true;
          reject(new BootstrapRequestConflict("Native gated child exited before confirmation"));
        });
        actualChild.on("close", () => {
          childClosed = true;
          reject(new BootstrapRequestConflict("Native gated child closed before confirmation"));
        });
      });
      // The owner's admission may throw after spawn. Retain the same failure even
      // when no waiter is reached; never leave a rejected promise unhandled.
      void spawned.catch(() => undefined);
      for (const kind of ["stdout", "stderr"] as const) {
        actualChild[kind]?.on("data", (bytes: Buffer | string) => retainOutput(kind, bytes));
        actualChild[kind]?.on("error", () => {
          errors.add(kind);
        });
      }
      const gate = actualChild.stdio[3];
      if (gate instanceof Writable) {
        writer = gate;
        gate.on("close", () => {
          gateClosed = true;
        });
        gate.on("finish", () => {
          gateFinished = true;
        });
        gate.on("error", () => {
          errors.add("gate");
        });
      }
    },
    async waitForSpawn(): Promise<{ pid: number }> {
      requireLocal(spawned !== null, "Native gated child has no retained spawn attempt");
      await spawned;
      assertLocalCurrent();
      return { pid: child!.pid! };
    },
    assertLocalCurrent,
    /** Exactly one byte followed by EOF, matching the existing Dev gate. Return
     * and stream callbacks establish neither delivery nor process settlement. */
    queueRelease(): void {
      requireLocal(
        !releaseAttempted,
        "Native gated child release was already attempted; observe only",
      );
      releaseAttempted = true;
      assertLocalCurrent();
      const originalWriter = writer!;
      try {
        originalWriter.end(Buffer.from([1]), (error?: Error | null) => {
          queueCallback = true;
          if (error) errors.add("queue");
        });
      } catch (error) {
        errors.add("queue");
        throw error;
      }
    },
    snapshot() {
      return {
        launchAttempted,
        releaseAttempted,
        spawnObserved,
        childExited,
        childClosed,
        queueCallback,
        gateClosed,
        gateFinished,
        pid: child?.pid ?? null,
        errors: [...errors],
        stdout: output.stdout.toString("utf8"),
        stderr: output.stderr.toString("utf8"),
        truncated: { ...truncated },
        delivery: "unknown" as const,
      };
    },
  };
}

export type RetainedNativeChild = ReturnType<typeof createRetainedNativeChild>;
export type RetainedNativeChildSnapshot = ReturnType<RetainedNativeChild["snapshot"]>;
