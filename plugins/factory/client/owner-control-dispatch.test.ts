import { test, expect } from "vitest";
import { dispatchFactoryControl } from "./owner-control-dispatch.js";
import type { FactoryControlInput, FactoryControlState } from "../shared/operations.js";
function fixture() {
  const observed: FactoryControlState = {
    schemaVersion: 1,
    serverId: "server",
    projectId: "project",
    installationId: "installation",
    revision: "before",
    state: "paused",
    desiredState: "paused",
    reason: null,
    operations: { pause: true, resume: true, stop: true },
    operationId: null,
  };
  const calls: FactoryControlInput[] = [];
  const input: Parameters<typeof dispatchFactoryControl>[0] = {
    hostId: "server",
    projectId: "project",
    observed,
    operationId: "operation",
    action: "resume",
    assertCurrent() {},
    read: async () => structuredClone(observed),
    execute: async (request) => {
      calls.push(request);
      return {
        schemaVersion: 1,
        serverId: "server",
        projectId: "project",
        installationId: "installation",
        operationId: request.operationId,
        outcome: "applied",
        revision: "after",
      };
    },
  };
  return { observed, calls, input };
}
test("changed resume precondition refuses dispatch", async () => {
  const f = fixture();
  f.input.read = async () => ({ ...f.observed, revision: "changed" });
  await expect(dispatchFactoryControl(f.input)).rejects.toThrow("changed");
  expect(f.calls).toEqual([]);
});
test.each(["pause", "stop"] as const)(
  "%s uses fresh revision to interrupt current work",
  async (action) => {
    const f = fixture();
    f.input.action = action;
    f.input.read = async () => ({
      ...f.observed,
      revision: "pending-resume",
      state: "held",
      reason: "resuming",
      operations: { pause: true, stop: true, resume: false },
    });
    await dispatchFactoryControl(f.input);
    expect(f.calls).toMatchObject([{ expectedRevision: "pending-resume", action }]);
  },
);
test.each(["serverId", "projectId", "installationId"] as const)(
  "changed %s refuses even stop",
  async (key) => {
    const f = fixture();
    f.input.action = "stop";
    f.input.read = async () => ({ ...f.observed, [key]: "foreign" });
    await expect(dispatchFactoryControl(f.input)).rejects.toThrow("changed");
    expect(f.calls).toEqual([]);
  },
);
test("a view removed during the fresh read cannot dispatch", async () => {
  const f = fixture();
  f.input.read = async () => {
    f.input.assertCurrent = () => {
      throw new Error("view removed");
    };
    return f.observed;
  };
  await expect(dispatchFactoryControl(f.input)).rejects.toThrow("view removed");
  expect(f.calls).toEqual([]);
});
test("lost dispatch response is never retried", async () => {
  const f = fixture();
  let calls = 0;
  f.input.execute = async () => {
    calls++;
    throw new Error("response lost");
  };
  await expect(dispatchFactoryControl(f.input)).rejects.toThrow("response lost");
  expect(calls).toBe(1);
});
