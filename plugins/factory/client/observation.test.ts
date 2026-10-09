import { describe, expect, it } from "vitest";
import { fixtureSnapshot, fixtureSetup } from "./fixtures.js";
import { resolveFactoryObservation, resolveFactorySetupObservation } from "./observation.js";
import { createFactoryInstallation, getFactoryInstallation } from "./installation.js";
import type { FactorySetup, FactoryInstallInput } from "../shared/operations.js";

const observationInput = {
  hostId: fixtureSnapshot.serverId,
  projectId: fixtureSnapshot.projectId,
  snapshot: fixtureSnapshot,
  pending: false,
  failed: false,
  paused: false,
};

describe("Factory observation boundary", () => {
  it("waits for project identity without displaying a cached snapshot", () => {
    expect(resolveFactoryObservation({ ...observationInput, projectId: null })).toEqual({
      kind: "identity_unavailable",
    });
  });

  it.each([{ hostId: "another-host" }, { projectId: "another-project" }])(
    "rejects a cached snapshot outside the selected scope %j",
    (scope) => {
      expect(resolveFactoryObservation({ ...observationInput, ...scope, failed: true })).toEqual({
        kind: "identity_mismatch",
      });
    },
  );

  it("distinguishes loading from failed observation without a snapshot", () => {
    expect(
      resolveFactoryObservation({ ...observationInput, snapshot: undefined, pending: true }),
    ).toEqual({
      kind: "loading",
    });
    expect(
      resolveFactoryObservation({
        ...observationInput,
        snapshot: undefined,
        pending: true,
        failed: true,
      }),
    ).toEqual({ kind: "unavailable" });
    expect(
      resolveFactoryObservation({ ...observationInput, snapshot: undefined, paused: true }),
    ).toEqual({
      kind: "unavailable",
    });
  });

  it.each([{ failed: true }, { paused: true }])(
    "retains a matching snapshot with explicit unavailable observation %j",
    (status) => {
      expect(resolveFactoryObservation({ ...observationInput, ...status })).toEqual({
        kind: "observed",
        source: { kind: "retained", snapshot: fixtureSnapshot },
      });
    },
  );

  it("returns to live observations after a successful refresh without changing server freshness", () => {
    expect(resolveFactoryObservation(observationInput)).toEqual({
      kind: "observed",
      source: { kind: "live", snapshot: fixtureSnapshot },
    });
    expect(fixtureSnapshot.freshness.state).toBe("unknown");
    expect(fixtureSnapshot.account.usagePoints).toBeNull();
  });
});

describe("Factory initial installation consumer", () => {
  const scope = { hostId: "test-server", projectId: "test-project" };
  const ready: FactorySetup = {
    schemaVersion: 1,
    serverId: scope.hostId,
    projectId: scope.projectId,
    installationId: null,
    revision: "native-revision",
    observedAt: "2026-10-08T20:00:00Z",
    state: "ready",
    reason: null,
    operations: { install: true, pause: false, resume: false, stop: false, disable: false },
  };
  function fixture() {
    const installation = createFactoryInstallation(scope);
    const dispatched: FactoryInstallInput[] = [];
    let reads = 0;
    const ports = {
      async readSetup(): Promise<unknown> {
        reads++;
        return ready;
      },
      async install(input: FactoryInstallInput): Promise<unknown> {
        dispatched.push(input);
        return {
          schemaVersion: 1,
          serverId: scope.hostId,
          projectId: scope.projectId,
          operationId: input.operationId,
          outcome: "applied",
          installationId: "native-installation",
          observedAt: ready.observedAt,
          setup: {
            ...ready,
            state: "installed",
            installationId: "native-installation",
            operations: { ...ready.operations, install: false },
          },
        };
      },
      isCurrent: () => true,
    };
    return { installation, dispatched, ports, reads: () => reads };
  }
  it("refreshes setup and dispatches one correlated initial installation", async () => {
    const f = fixture();
    await f.installation.run(ready, "attempt-one", f.ports);
    expect(f.reads()).toBe(1);
    expect(f.dispatched).toEqual([
      {
        projectId: scope.projectId,
        expectedServerId: scope.hostId,
        expectedInstallationId: null,
        expectedRevision: ready.revision,
        operationId: "attempt-one",
      },
    ]);
    expect(f.installation.getSnapshot().kind).toBe("applied");
    await f.installation.run(ready, "attempt-two", f.ports);
    expect(f.dispatched).toHaveLength(1);
  });
  it.each([
    { serverId: "another-host" },
    { projectId: "another-project" },
    { revision: "changed" },
    { operations: { ...ready.operations, install: false } },
  ])("refuses fresh setup drift before dispatch %j", async (change) => {
    const f = fixture();
    f.ports.readSetup = async () => ({ ...ready, ...change });
    await f.installation.run(ready, "attempt", f.ports);
    expect(f.dispatched).toHaveLength(0);
    expect(f.installation.getSnapshot().kind).toBe("refused");
  });
  it("does not transmit for an unavailable displayed setup", async () => {
    const f = fixture();
    await f.installation.run(fixtureSetup, "attempt", f.ports);
    expect(f.reads()).toBe(0);
    expect(f.dispatched).toHaveLength(0);
  });
  it("rejects an unshown revision after caller mutation during a deferred setup read", async () => {
    const f = fixture();
    const shown = { ...ready, revision: "visible-A" };
    const fresh = { ...shown, revision: "unshown-B" };
    let release: ((value: unknown) => void) | undefined;
    f.ports.readSetup = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = f.installation.run(shown, "original-operation", f.ports);
    shown.revision = "unshown-B";
    release?.(fresh);
    await pending;
    expect(f.dispatched).toHaveLength(0);
    expect(f.installation.getSnapshot()).toMatchObject({
      kind: "refused",
      operationId: "original-operation",
    });
  });
  it("retains invocation callbacks, scope and correlation during a deferred setup read", async () => {
    const f = fixture();
    let release: ((value: unknown) => void) | undefined;
    f.ports.readSetup = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = f.installation.run(ready, "original-operation", f.ports);
    let replacements = 0;
    f.ports.install = async () => {
      replacements++;
      throw new Error("Replaced invocation");
    };
    f.ports.isCurrent = () => false;
    release?.(ready);
    await pending;
    expect(replacements).toBe(0);
    expect(f.dispatched).toEqual([
      {
        projectId: scope.projectId,
        expectedServerId: scope.hostId,
        expectedInstallationId: null,
        expectedRevision: ready.revision,
        operationId: "original-operation",
      },
    ]);
    expect(f.installation.getSnapshot()).toMatchObject({
      kind: "applied",
      operationId: "original-operation",
    });
  });
  it("does not dispatch after navigation or unmount during fresh setup", async () => {
    const f = fixture();
    let current = true;
    f.ports.isCurrent = () => current;
    f.ports.readSetup = async () => {
      current = false;
      return ready;
    };
    await f.installation.run(ready, "attempt", f.ports);
    expect(f.dispatched).toHaveLength(0);
    expect(f.installation.getSnapshot().kind).toBe("refused");
  });
  it("holds lost mutation responses without sending another operation", async () => {
    const f = fixture();
    f.ports.install = async (input) => {
      f.dispatched.push(input);
      throw new Error("Lost reply");
    };
    await f.installation.run(ready, "original-operation", f.ports);
    expect(f.installation.getSnapshot()).toMatchObject({
      kind: "uncertain",
      operationId: "original-operation",
    });
    await f.installation.run(ready, "new-operation", f.ports);
    expect(f.dispatched).toHaveLength(1);
    expect(f.reads()).toBe(1);
  });
  it.each(["identity", "correlation", "invalid"])(
    "holds %s failure after dispatch",
    async (change) => {
      const f = fixture();
      const install = f.ports.install;
      f.ports.install = async (input) => {
        const result = (await install(input)) as Record<string, unknown>;
        return change === "invalid"
          ? null
          : { ...result, [change === "identity" ? "serverId" : "operationId"]: "wrong" };
      };
      await f.installation.run(ready, "attempt", f.ports);
      expect(f.installation.getSnapshot().kind).toBe("uncertain");
      expect(f.dispatched).toHaveLength(1);
    },
  );
  it("blocks a second click while setup is being read", async () => {
    const f = fixture();
    let release: ((value: unknown) => void) | undefined;
    f.ports.readSetup = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const first = f.installation.run(ready, "original", f.ports);
    await f.installation.run(ready, "duplicate", f.ports);
    release?.(ready);
    await first;
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]?.operationId).toBe("original");
  });
  it("retains the same scoped session across panel remounts", () => {
    expect(getFactoryInstallation("retained-host", "retained-project")).toBe(
      getFactoryInstallation("retained-host", "retained-project"),
    );
    expect(getFactoryInstallation("other-host", "retained-project")).not.toBe(
      getFactoryInstallation("retained-host", "retained-project"),
    );
  });
});

describe("Factory setup observation boundary", () => {
  const setupInput = {
    hostId: fixtureSetup.serverId,
    projectId: fixtureSetup.projectId,
    setup: fixtureSetup,
    pending: false,
    failed: false,
    paused: false,
  };

  it("waits for native project identity before displaying a previous setup", () => {
    expect(resolveFactorySetupObservation({ ...setupInput, projectId: null })).toEqual({
      kind: "identity_unavailable",
    });
  });

  it.each([{ hostId: "another-host" }, { projectId: "another-project" }])(
    "rejects setup from a different selected scope %j",
    (scope) => {
      expect(resolveFactorySetupObservation({ ...setupInput, ...scope, failed: true })).toEqual({
        kind: "identity_mismatch",
      });
    },
  );

  it("reports unavailable setup without substituting example data", () => {
    expect(
      resolveFactorySetupObservation({ ...setupInput, setup: undefined, pending: true }),
    ).toEqual({ kind: "loading" });
    expect(
      resolveFactorySetupObservation({ ...setupInput, setup: undefined, failed: true }),
    ).toEqual({ kind: "unavailable" });
    expect(
      resolveFactorySetupObservation({ ...setupInput, setup: undefined, paused: true }),
    ).toEqual({ kind: "unavailable" });
  });

  it.each([{ failed: true }, { paused: true }])(
    "labels matching cached setup as retained while observation is unavailable %j",
    (status) => {
      expect(resolveFactorySetupObservation({ ...setupInput, ...status })).toEqual({
        kind: "observed",
        setup: fixtureSetup,
        retained: true,
      });
    },
  );

  it("preserves server refusal and unavailable preconditions after a fresh read", () => {
    expect(resolveFactorySetupObservation(setupInput)).toEqual({
      kind: "observed",
      setup: fixtureSetup,
      retained: false,
    });
    expect(fixtureSetup.revision).toBeNull();
    expect(Object.values(fixtureSetup.operations)).toEqual(Array(5).fill(false));
  });
});
