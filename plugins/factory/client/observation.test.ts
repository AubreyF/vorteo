import { describe, expect, it } from "vitest";
import { fixtureSnapshot, fixtureSetup } from "./fixtures.js";
import { resolveFactoryObservation, resolveFactorySetupObservation } from "./observation.js";

const input = {
  hostId: fixtureSnapshot.serverId,
  projectId: fixtureSnapshot.projectId,
  snapshot: fixtureSnapshot,
  pending: false,
  failed: false,
  paused: false,
};

describe("Factory observation boundary", () => {
  it("waits for project identity without displaying a cached snapshot", () => {
    expect(resolveFactoryObservation({ ...input, projectId: null })).toEqual({
      kind: "identity_unavailable",
    });
  });

  it.each([{ hostId: "another-host" }, { projectId: "another-project" }])(
    "rejects a cached snapshot outside the selected scope %j",
    (scope) => {
      expect(resolveFactoryObservation({ ...input, ...scope, failed: true })).toEqual({
        kind: "identity_mismatch",
      });
    },
  );

  it("distinguishes loading from failed observation without a snapshot", () => {
    expect(resolveFactoryObservation({ ...input, snapshot: undefined, pending: true })).toEqual({
      kind: "loading",
    });
    expect(
      resolveFactoryObservation({ ...input, snapshot: undefined, pending: true, failed: true }),
    ).toEqual({ kind: "unavailable" });
    expect(resolveFactoryObservation({ ...input, snapshot: undefined, paused: true })).toEqual({
      kind: "unavailable",
    });
  });

  it.each([{ failed: true }, { paused: true }])(
    "retains a matching snapshot with explicit unavailable observation %j",
    (status) => {
      expect(resolveFactoryObservation({ ...input, ...status })).toEqual({
        kind: "observed",
        source: { kind: "retained", snapshot: fixtureSnapshot },
      });
    },
  );

  it("returns to live observations after a successful refresh without changing server freshness", () => {
    expect(resolveFactoryObservation(input)).toEqual({
      kind: "observed",
      source: { kind: "live", snapshot: fixtureSnapshot },
    });
    expect(fixtureSnapshot.freshness.state).toBe("unknown");
    expect(fixtureSnapshot.account.usagePoints).toBeNull();
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
