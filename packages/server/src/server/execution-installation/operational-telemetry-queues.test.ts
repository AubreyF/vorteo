import { describe, expect, it } from "vitest";
import { RestartJobSchema, type RestartJob } from "@getpaseo/protocol/execution-installation";
import { summarizeOperationalQueues } from "./operational-telemetry-queues.js";

function job(target: RestartJob["target"], status: RestartJob["status"]): RestartJob {
  return RestartJobSchema.parse({
    target,
    status,
    reason: "fixture",
    id: "00000000-0000-4000-8000-000000000001",
    revision: "00000000-0000-4000-8000-000000000002",
    requestedBy: "owner",
    createdAt: "2026-10-25T00:00:00Z",
    expiresAt: "2026-10-26T00:00:00Z",
    detail: "fixture",
  });
}

describe("cached lifecycle activity counts", () => {
  it("counts pending and active work separately without reading private job data", () => {
    const host = job("host", "pending");
    Object.defineProperty(host, "reason", {
      get() {
        throw new Error("private reason sentinel");
      },
    });
    const result = summarizeOperationalQueues([
      host,
      job("host", "approved"),
      job("host", "running"),
      job("container-daemon", "running"),
      job("container-daemon", "succeeded"),
      job("host", "failed"),
    ]);
    expect(result).toEqual({
      hostPending: 2,
      hostRunning: 1,
      devPending: 0,
      devRunning: 1,
      sourceUpdatesRunning: 0,
      maintenancePending: 0,
      maintenanceRunning: 0,
    });
  });

  it("does not report a terminal source preparation as ongoing work", () => {
    const completed = {
      ...job("host", "failed"),
      sourceBatch: {
        status: "preparing" as const,
        contributions: [],
      },
    };
    expect(summarizeOperationalQueues([completed]).sourceUpdatesRunning).toBe(0);
  });

  it("counts preparation and active installation without exposing revisions or contributions", () => {
    const preparation = {
      ...job("host", "pending"),
      sourceBatch: {
        status: "preparing" as const,
        contributions: [],
      },
    };
    const install = {
      ...job("container-daemon", "running"),
      update: {
        sourceCommit: "1".repeat(40),
        baseCommit: "2".repeat(40),
        sha256: "3".repeat(64),
        bytes: 1,
      },
    };
    const result = summarizeOperationalQueues([preparation, install]);
    expect(result.sourceUpdatesRunning).toBe(2);
    expect(Object.keys(result)).toHaveLength(7);
  });
});
