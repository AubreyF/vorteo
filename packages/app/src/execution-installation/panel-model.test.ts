import { expect, test } from "vitest";
import { InstallationPanelModel } from "./panel-model";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";

test("saved connections skip setup on reload without unlocking owner controls", async () => {
  let queries = 0;
  const model = new InstallationPanelModel(
    {
      restoreSession: async () => false,
      lock: async () => {},
      passwordFile: null,
      sessionsSupported: false,
      profileSharingStatus: async () => null,
      resolveProfileConflict: async () => {},
      unlock: async () => {},
      listRestarts: async () => {
        queries++;
        return [];
      },
      decide: async () => {
        throw new Error("Unexpected approval");
      },
    },
    { connectionsRegistered: true },
  );
  expect(model.getState()).toMatchObject({ visible: false, unlocked: false, password: "" });
  await model.refresh();
  expect(queries).toBe(0);
  model.open();
  expect(model.getState()).toMatchObject({ visible: true, unlocked: false });
});

test("opening or observing a request never approves it", async () => {
  let approvals = 0;
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Update",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    detail: "Approval required",
  };
  const model = new InstallationPanelModel({
    restoreSession: async () => false,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: false,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {},
    listRestarts: async () => [job],
    decide: async () => {
      approvals++;
    },
  });
  model.setPassword("owner-password");
  await model.unlock();
  expect(model.getState().password).toBe("");
  expect(model.getState().visible).toBe(true);
  model.close();
  await model.refresh();
  expect(model.getState().visible).toBe(false);
  model.open();
  expect(approvals).toBe(0);
  await model.decide(job, "approve");
  expect(approvals).toBe(1);
});

test("failed unlock remains visible and can be retried without granting authority", async () => {
  let attempts = 0;
  const model = new InstallationPanelModel({
    restoreSession: async () => false,
    lock: async () => {},
    passwordFile: null,
    sessionsSupported: false,
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    unlock: async () => {
      if (++attempts === 1) throw new Error("Incorrect installation password");
    },
    listRestarts: async () => [],
    decide: async () => {
      throw new Error("Unexpected approval");
    },
  });
  model.setPassword("incorrect");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: false,
    busy: false,
    visible: true,
    error: "Incorrect installation password",
  });
  model.setPassword("correct");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: true,
    busy: false,
    visible: false,
    error: null,
    password: "",
  });
});

test("restoring a browser session retains owner access and locking never approves requests", async () => {
  let approvals = 0;
  let locks = 0;
  const model = new InstallationPanelModel({
    restoreSession: async () => true,
    passwordFile: "/installation/owner-password",
    sessionsSupported: true,
    lock: async () => {
      locks++;
    },
    unlock: async () => {},
    profileSharingStatus: async () => null,
    resolveProfileConflict: async () => {},
    listRestarts: async () => [],
    decide: async () => {
      approvals++;
    },
  });
  await model.initialize();
  expect(model.getState()).toMatchObject({
    unlocked: true,
    visible: false,
    password: "",
    passwordFile: "/installation/owner-password",
    sessionsSupported: true,
  });
  await model.lock();
  expect(model.getState()).toMatchObject({ unlocked: false, password: "", jobs: [] });
  expect(locks).toBe(1);
  expect(approvals).toBe(0);
});
