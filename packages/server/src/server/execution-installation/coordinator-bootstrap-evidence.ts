import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import { writePrivateFileAtomicSync } from "../private-files.js";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";

export type RunnerPhase =
  | "runner"
  | "candidate-artifacts"
  | "boot-binding"
  | "boot-artifacts"
  | "approval"
  | "setup-files"
  | "renewal-validation"
  | "ownership-mounts"
  | "ownership-lock"
  | "watchdog-audit"
  | "watchdog-record"
  | "generation-retention"
  | "watchdog-readiness"
  | "native-operations"
  | "executor-dispatch"
  | "recovery"
  | "renewal-retained"
  | "renewal-generation"
  | "renewal-derive"
  | "renewal-plan"
  | "runtime-digest";
type RequestIdentity = Pick<
  CoordinatorBootstrapRequest,
  "id" | "revision" | "planSha256" | "execution"
>;
interface PhaseEntry {
  sequence: number;
  phase: RunnerPhase;
  at: string;
}
interface PhaseEvent extends PhaseEntry {
  event: "started" | "completed" | "failed";
}
/** Wall time spent per phase or executor operation. Diagnostic only; bounded by the
 * fixed set of names, so it never grows with the number of events. */
interface StepTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}
interface PhaseFailure extends PhaseEntry {
  category: "conflict" | "authentication" | "error" | "non-error";
}

/** Call only after the native runner verifies the private state directory and
 * approved request. This evidence never participates in lifecycle admission. */
export function createBootstrapRunnerEvidence(input: {
  directory: string;
  request: RequestIdentity;
  role: "executor" | "watchdog" | "boot-watchdog";
}) {
  const file = path.join(
    input.directory,
    `coordinator-runner-${input.request.id}-${randomUUID()}.json`,
  );
  let parent: Stats | null = null;
  const state = {
    version: 1,
    authority: "diagnostic-only",
    requestId: input.request.id,
    revision: input.request.revision,
    planSha256: input.request.planSha256,
    generation: input.request.execution?.generation ?? null,
    role: input.role,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sequence: 0,
    outcome: "running",
    active: [] as PhaseEntry[],
    recent: [] as PhaseEvent[],
    failure: null as PhaseFailure | null,
    timings: {} as Record<string, StepTiming>,
  };
  function addTiming(name: string, startedMs: number) {
    const elapsed = Date.now() - startedMs;
    const timing = (state.timings[name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    timing.count += 1;
    timing.totalMs += elapsed;
    timing.maxMs = Math.max(timing.maxMs, elapsed);
  }
  let available = true;
  function persist() {
    if (!available) return;
    try {
      const current = lstatSync(input.directory);
      if (
        !current.isDirectory() ||
        (parent && (current.dev !== parent.dev || current.ino !== parent.ino)) ||
        current.uid !== process.getuid?.() ||
        (current.mode & 0o077) !== 0 ||
        realpathSync(input.directory) !== input.directory
      )
        throw new Error("Runner evidence directory changed");
      parent = current;
      state.updatedAt = new Date().toISOString();
      writePrivateFileAtomicSync(file, JSON.stringify(state));
      for (const target of [file, input.directory]) {
        const descriptor = openSync(target, "r");
        try {
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
      }
    } catch {
      // Diagnostic storage cannot prevent already-approved restoration or hide
      // the original operation error. Existing intent journals remain authoritative.
      available = false;
      process.stderr.write("Coordinator runner diagnostics could not be retained.\n");
    }
  }
  function record(entry: PhaseEntry, event: PhaseEvent["event"]) {
    state.recent.push({ ...entry, event, at: new Date().toISOString() });
    state.recent = state.recent.slice(-32);
    persist();
  }
  persist();
  return {
    file,
    bind(request: RequestIdentity) {
      if (request.id !== state.requestId || request.planSha256 !== state.planSha256)
        throw new Error("Runner diagnostics cannot bind a different request");
      state.revision = request.revision;
      state.generation = request.execution?.generation ?? null;
      persist();
    },
    async run<T>(phase: RunnerPhase, operation: () => Promise<T>): Promise<T> {
      const entry = { sequence: ++state.sequence, phase, at: new Date().toISOString() };
      state.active.push(entry);
      state.outcome = "running";
      record(entry, "started");
      const startedMs = Date.now();
      let event: PhaseEvent["event"] = "completed";
      try {
        return await operation();
      } catch (error) {
        event = "failed";
        if (!state.failure) {
          let category: PhaseFailure["category"] = error instanceof Error ? "error" : "non-error";
          if (error instanceof BootstrapRequestConflict) category = "conflict";
          if (error instanceof BootstrapAuthenticationRequired) category = "authentication";
          state.failure = { ...entry, at: new Date().toISOString(), category };
        }
        throw error;
      } finally {
        state.active = state.active.filter((active) => active.sequence !== entry.sequence);
        if (state.active.length === 0) state.outcome = event;
        addTiming(phase, startedMs);
        record(entry, event);
      }
    },
    /** Times one executor operation. Memory only: it is written at the next phase
     * event, so it never adds writes or changes the watchdog's activity signal. */
    async timed<T>(name: string, operation: () => Promise<T>): Promise<T> {
      const startedMs = Date.now();
      try {
        return await operation();
      } finally {
        addTiming(`operation:${name}`, startedMs);
      }
    },
  };
}
