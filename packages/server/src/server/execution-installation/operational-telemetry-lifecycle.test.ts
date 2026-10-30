import { describe, expect, it } from "vitest";
import { InstallationRestarts, type RestartJournal } from "./restarts.js";
import type { LifecycleJob } from "./lifecycle-journal.js";
import type { OperationalEvent } from "./operational-telemetry-record.js";

function fixture() {
  let jobs: LifecycleJob[] = [];
  let failWrite = false;
  const journal: RestartJournal = {
    read: () => structuredClone(jobs),
    write(next) {
      if (failWrite) throw new Error("synthetic storage failure");
      jobs = structuredClone(next);
    },
  };
  const queue = new InstallationRestarts(
    journal,
    {
      async restart() {
        throw new Error("native lifecycle must never execute in this fixture");
      },
    },
    () => Date.UTC(2026, 9, 25),
  );
  return {
    queue,
    jobs: () => jobs,
    failWrite: () => {
      failWrite = true;
    },
  };
}

describe("operational activity persistence order", () => {
  it("emits only sanitized activity after the in-memory journal has persisted", () => {
    const f = fixture();
    const events: OperationalEvent[] = [];
    f.queue.setOperationalActivitySink({
      record(event) {
        expect(f.jobs()).toHaveLength(1);
        expect(f.jobs()[0].status).toBe("pending");
        events.push(event);
      },
      recordDropped() {},
    });
    f.queue.request({ target: "host", reason: "private reason sentinel" }, "owner");
    expect(events).toEqual([{ atMs: Date.UTC(2026, 9, 25), component: "host", phase: "pending" }]);
    expect(JSON.stringify(events)).not.toContain("sentinel");
  });

  it("does not announce an operation whose persistence failed", () => {
    const f = fixture();
    const events: OperationalEvent[] = [];
    f.queue.setOperationalActivitySink({
      record: (event) => {
        events.push(event);
      },
      recordDropped() {},
    });
    f.failWrite();
    expect(() => f.queue.request({ target: "host", reason: "synthetic" }, "owner")).toThrow(
      "synthetic storage failure",
    );
    expect(events).toEqual([]);
    expect(f.jobs()).toEqual([]);
  });

  it("retains the persisted operation if an optional telemetry sink fails", () => {
    const f = fixture();
    f.queue.setOperationalActivitySink({
      record() {
        throw new Error("optional sink");
      },
      recordDropped() {},
    });
    expect(() =>
      f.queue.request({ target: "container-daemon", reason: "synthetic" }, "owner"),
    ).not.toThrow();
    expect(f.jobs()).toHaveLength(1);
  });
});
