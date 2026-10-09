import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { hashSync } from "bcryptjs";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { CoordinatorBootstrapRequests, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  loadedCoordinatorPid,
  verifyBootstrapServiceIdentity,
  verifyLoadedBootstrapService,
  verifyBootstrapLaunchers,
} from "./coordinator-bootstrap-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ownerPassword = "fixture-installation-owner";
const ownerHash = hashSync(ownerPassword, 4);

test("bootstrap launchers preserve environment and lifetime settings with exact approved arguments", () => {
  const { plan } = fixture();
  const configurationFile = "/protected/active-config.json";
  const current = {
    Label: plan.service.split("/").slice(2).join("/"),
    ProgramArguments: [plan.previous.node.path, plan.previous.entrypoint.path, configurationFile],
    EnvironmentVariables: { PATH: "/usr/bin:/bin", PRESERVED: "fixture-value" },
    KeepAlive: true,
    RunAtLoad: true,
  };
  const candidate = {
    ...current,
    ProgramArguments: [
      plan.candidate.node.path,
      plan.candidate.entrypoint.path,
      plan.candidate.configuration.path,
    ],
  };
  const input = { plan, configurationFile, current, previous: structuredClone(current), candidate };
  expect(() => verifyBootstrapLaunchers(input)).not.toThrow();
  for (const change of [
    { EnvironmentVariables: { PATH: "/unapproved" } },
    { KeepAlive: false },
    { Program: "/unapproved/executable" },
    { Label: "another-service" },
    { ProgramArguments: [...candidate.ProgramArguments, "--unapproved"] },
  ])
    expect(() =>
      verifyBootstrapLaunchers({ ...input, candidate: { ...candidate, ...change } }),
    ).toThrow("unapproved service settings");
  expect(() =>
    verifyBootstrapLaunchers({ ...input, previous: { ...current, RunAtLoad: false } }),
  ).toThrow("no longer matches");
});

test("loaded coordinator PID parsing rejects nested, foreign and incomplete records", () => {
  const service = "gui/501/local.vorteo.fixture.installation";
  expect(loadedCoordinatorPid(service, `${service} = {\n\tpid = 123\n}`)).toBe(123);
  for (const output of [
    `other = {\n\tpid = 123\n}`,
    `${service} = {\n\t\tpid = 123\n}`,
    `${service} = {\n\tpid = 123\n\tpid = 124\n}`,
    `${service} = {\n\tpid = 123\n`,
  ])
    expect(() => loadedCoordinatorPid(service, output)).toThrow();
});

test("loaded coordinator identity binds kernel birth, owner, parent and exact launch arguments", async () => {
  const { plan } = fixture();
  const configurationFile = "/protected/config.json";
  const digest = createHash("sha256")
    .update(
      JSON.stringify([plan.previous.node.path, plan.previous.entrypoint.path, configurationFile]),
    )
    .digest("hex");
  plan.expectedProcess = {
    pid: 123,
    bootId: randomUUID(),
    startIdentity: "1234:5678",
    argumentsSha256: digest,
  };
  const observation = {
    ...plan.expectedProcess,
    uid: 501,
    parentPid: 1,
    executable: plan.previous.node.path,
  };
  const input = {
    plan,
    configurationFile,
    hostUid: 501,
    launchctlOutput: `${plan.service} = {\n\tpid = 123\n}`,
    process: observation,
  };
  expect(() => verifyBootstrapServiceIdentity(input)).not.toThrow();
  for (const change of [
    { pid: 124 },
    { bootId: randomUUID() },
    { startIdentity: "1234:5679" },
    { uid: 502 },
    { parentPid: 99 },
    { executable: "/other/node" },
    { argumentsSha256: "f".repeat(64) },
  ])
    expect(() =>
      verifyBootstrapServiceIdentity({ ...input, process: { ...observation, ...change } }),
    ).toThrow();
  expect(() =>
    verifyBootstrapServiceIdentity({ ...input, configurationFile: "/other/config.json" }),
  ).toThrow("prepared launcher");
  expect(() =>
    verifyBootstrapServiceIdentity({
      ...input,
      launchctlOutput: `${plan.service} = {\n\tpid = 124\n}`,
    }),
  ).toThrow("changed since preparation");
  for (const changedServiceRead of [0, 1, 2, 3]) {
    let reads = 0;
    let processReads = 0;
    const verification = verifyLoadedBootstrapService({
      ...input,
      reader: {
        async readService(service) {
          expect(service).toBe(plan.service);
          reads++;
          const pid = reads === changedServiceRead ? 124 : 123;
          return `${service} = {\n\tpid = ${pid}\n}`;
        },
        async inspectProcess(pid) {
          expect(pid).toBe(123);
          processReads++;
          return observation;
        },
      },
    });
    if (changedServiceRead === 0) {
      await expect(verification).resolves.toBeUndefined();
      expect(processReads).toBe(2);
      expect(reads).toBe(3);
    } else {
      await expect(verification).rejects.toThrow("PID changed");
      expect(processReads).toBe(changedServiceRead - 1);
    }
  }
  let inspections = 0;
  await expect(
    verifyLoadedBootstrapService({
      ...input,
      reader: {
        async readService() {
          return input.launchctlOutput;
        },
        async inspectProcess() {
          inspections++;
          if (inspections === 2) return { ...observation, startIdentity: "1234:5679" };
          return observation;
        },
      },
    }),
  ).rejects.toThrow("changed since preparation");
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "coordinator-bootstrap-")));
  roots.push(root);
  const identity = { path: "/protected/file", sha256: "a".repeat(64) };
  const release = {
    sourceCommit: "b".repeat(40),
    directory: "/protected/release",
    artifactSha256: "c".repeat(64),
    node: identity,
    entrypoint: identity,
    configuration: identity,
    launcher: identity,
  };
  const plan: CoordinatorBootstrapPlan = {
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: randomUUID(),
    service: "gui/501/local.vorteo.fixture.installation",
    expectedProcess: {
      pid: 123,
      bootId: "fixture-boot",
      startIdentity: "fixture-start",
      argumentsSha256: "d".repeat(64),
    },
    previous: release,
    candidate: { ...release, sourceCommit: "e".repeat(40) },
    state: {
      directory: "/protected/state",
      restartJournal: "/protected/state/restarts.json",
      ownerSessions: "/protected/state/owners.json",
    },
    hostRequestsAfter: null,
  };
  let binding = {
    environment: "host",
    installationId: plan.installationId,
    service: plan.service,
    ownerPasswordHash: ownerHash,
  };
  let verify = async (_plan: CoordinatorBootstrapPlan) => {};
  const journal = new FileBootstrapRequestJournal(root);
  const service = () =>
    new CoordinatorBootstrapRequests(
      journal,
      () => binding,
      (value) => verify(value),
    );
  return {
    root,
    plan,
    journal,
    service,
    binding,
    setBinding: (value: typeof binding) => {
      binding = value;
    },
    setVerify: (value: typeof verify) => {
      verify = value;
    },
    prepare: () =>
      service().prepare({ id: randomUUID(), reason: "Install reviewed coordinator", plan }),
  };
}

test("bootstrap preparation stays pending and exact owner approval survives reopening without storing credentials", async () => {
  const f = fixture();
  const pending = await f.prepare();
  expect(f.service().list()).toEqual([pending]);
  expect(pending.status).toBe("pending");
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  expect(approved.status).toBe("approved");
  expect(approved.revision).not.toBe(pending.revision);
  expect(f.service().list()).toEqual([approved]);
  const stored = readFileSync(path.join(f.root, "coordinator-bootstrap.json"), "utf8");
  expect(stored).not.toContain(ownerPassword);
  expect(stored).not.toContain(ownerHash);
  expect(statSync(path.join(f.root, "coordinator-bootstrap.json")).mode & 0o777).toBe(0o600);
});

test("Dev bindings and owner role labels cannot substitute for installation-owner authentication", async () => {
  const f = fixture();
  f.setBinding({ ...f.binding, environment: "container" });
  expect(() => f.service()).toThrow();
  f.setBinding(f.binding);
  const pending = await f.prepare();
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve",
  };
  for (const credential of ["", "host-agent-token", "container-agent-token", "owner"])
    await expect(f.service().decide(input, credential)).rejects.toThrow(
      "owner authentication required",
    );
  await expect(
    f.service().decide({ ...input, principalId: "owner" }, ownerPassword),
  ).rejects.toThrow();
  expect(f.service().list()[0]?.status).toBe("pending");
  f.setBinding({ ...f.binding, ownerPasswordHash: "" });
  expect(() => f.service()).toThrow();
});

test("preparation is idempotent and rejects another open request or changed request identity", async () => {
  const f = fixture();
  const input = { id: randomUUID(), reason: "Prepared", plan: f.plan };
  const first = await f.service().prepare(input);
  expect(await f.service().prepare(input)).toEqual(first);
  await expect(f.service().prepare({ ...input, reason: "Different" })).rejects.toThrow(
    "different prepared work",
  );
  await expect(f.prepare()).rejects.toThrow("already open");
  expect(f.service().list()).toEqual([first]);
});

test("approval rechecks artifacts and rejects stale revision or installation selection", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const input = {
    id: pending.id,
    revision: pending.revision,
    planSha256: pending.planSha256,
    decision: "approve",
  };
  await expect(
    f.service().decide({ ...input, revision: randomUUID() }, ownerPassword),
  ).rejects.toThrow("changed");
  f.setVerify(async () => {
    throw new Error("Prepared bytes changed");
  });
  await expect(f.service().decide(input, ownerPassword)).rejects.toThrow("Prepared bytes changed");
  f.setBinding({ ...f.binding, installationId: randomUUID() });
  await expect(f.service().decide(input, ownerPassword)).rejects.toThrow("does not match");
  expect(f.journal.read()[0]?.status).toBe("pending");
});

test("cancellation wins while asynchronous approval validation is outstanding", async () => {
  const f = fixture();
  const pending = await f.prepare();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setVerify(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const input = { id: pending.id, revision: pending.revision, planSha256: pending.planSha256 };
  const approval = f.service().decide({ ...input, decision: "approve" }, ownerPassword);
  await started;
  const canceled = await f.service().decide({ ...input, decision: "cancel" }, ownerPassword);
  release();
  await expect(approval).rejects.toThrow("changed");
  expect(f.service().list()).toEqual([canceled]);
  expect(canceled.status).toBe("canceled");
});

test("plan digest ignores object key order but binds replacement and policy changes", () => {
  const f = fixture();
  expect(coordinatorPlanDigest(Object.fromEntries(Object.entries(f.plan).toReversed()))).toBe(
    coordinatorPlanDigest(f.plan),
  );
  expect(
    coordinatorPlanDigest({ ...f.plan, hostRequestsAfter: new Date(0).toISOString() }),
  ).not.toBe(coordinatorPlanDigest(f.plan));
  expect(
    coordinatorPlanDigest({
      ...f.plan,
      candidate: { ...f.plan.candidate, artifactSha256: "f".repeat(64) },
    }),
  ).not.toBe(coordinatorPlanDigest(f.plan));
  expect(() => coordinatorPlanDigest({ ...f.plan, command: "arbitrary shell" })).toThrow();
});

test("journal refuses symlink substitution and preserves an existing writer lock", async () => {
  const f = fixture();
  await f.prepare();
  const link = path.join(f.root, "alias");
  symlinkSync(f.root, link);
  expect(() => new FileBootstrapRequestJournal(link)).toThrow("canonical directory");
  writeFileSync(path.join(f.root, "coordinator-bootstrap.lock"), "other owner", { mode: 0o600 });
  const pending = f.service().list()[0]!;
  await expect(
    f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "cancel",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("storage is busy");
  expect(readFileSync(path.join(f.root, "coordinator-bootstrap.lock"), "utf8")).toBe("other owner");
  expect(f.service().list()[0]?.status).toBe("pending");
});

test("owner credential rotation during artifact verification invalidates approval", async () => {
  const f = fixture();
  const pending = await f.prepare();
  f.setVerify(async () => {
    f.setBinding({ ...f.binding, ownerPasswordHash: hashSync("replacement-owner", 4) });
  });
  await expect(
    f.service().decide(
      {
        id: pending.id,
        revision: pending.revision,
        planSha256: pending.planSha256,
        decision: "approve",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("authentication changed");
  expect(f.journal.read()[0]?.status).toBe("pending");
});

test("approved bootstrap can be canceled without accepting damaged replacement bytes", async () => {
  const f = fixture();
  const pending = await f.prepare();
  const approved = await f.service().decide(
    {
      id: pending.id,
      revision: pending.revision,
      planSha256: pending.planSha256,
      decision: "approve",
    },
    ownerPassword,
  );
  f.setVerify(async () => {
    throw new Error("Candidate no longer available");
  });
  const canceled = await f.service().decide(
    {
      id: approved.id,
      revision: approved.revision,
      planSha256: approved.planSha256,
      decision: "cancel",
    },
    ownerPassword,
  );
  expect(canceled.status).toBe("canceled");
  await expect(
    f.service().decide(
      {
        id: canceled.id,
        revision: canceled.revision,
        planSha256: canceled.planSha256,
        decision: "approve",
      },
      ownerPassword,
    ),
  ).rejects.toThrow("already been decided");
});

test("two asynchronous preparations cannot publish competing bootstrap requests", async () => {
  const f = fixture();
  const waiting: Array<() => void> = [];
  f.setVerify(
    () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      }),
  );
  const first = f.prepare();
  const second = f.prepare();
  expect(waiting).toHaveLength(2);
  waiting[0]!();
  const saved = await first;
  waiting[1]!();
  await expect(second).rejects.toThrow("changed");
  expect(f.service().list()).toEqual([saved]);
});

test("stored plan alteration and journal file symlinks are refused", async () => {
  const f = fixture();
  await f.prepare();
  const file = path.join(f.root, "coordinator-bootstrap.json");
  const value = JSON.parse(readFileSync(file, "utf8"));
  value.requests[0].plan.candidate.sourceCommit = "f".repeat(40);
  writeFileSync(file, JSON.stringify(value));
  expect(() => f.service().list()).toThrow("digest check");
  const target = path.join(f.root, "other.json");
  writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
  rmSync(file);
  symlinkSync(target, file);
  expect(() => f.journal.read()).toThrow();
  expect(readFileSync(target, "utf8")).toBe(JSON.stringify(value));
});
