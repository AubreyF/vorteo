import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  InitialHostMigrationClaimSchema,
  InitialHostMigrationIntentSchema,
  InitialHostSupervisorMigrationPlanSchema,
  initialHostPublicationRecords,
} from "./host-supervisor-migration.js";
import { enrollmentNativeIdentityDigest } from "./native-identity.js";
import { InitialHostSupervisorPreconditionSchema } from "./native-daemon-inspection.js";
import {
  classifyInitialHostPublication,
  type HostRecoveryFileImage,
  type InitialHostRecoveryImage,
} from "./host-supervisor-recovery.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const present = (file: string, bytes: string): HostRecoveryFileImage => ({
  path: file,
  state: "present",
  bytes: Buffer.from(bytes),
});
const absent = (file: string): HostRecoveryFileImage => ({ path: file, state: "absent" });

/** Declarations and byte images only. This fixture creates no files or processes. */
function fixture() {
  const directory = "/isolated/host-recovery";
  const file = (name: string) => ({ path: path.join(directory, name), sha256: "a".repeat(64) });
  const identity = {
    version: 1,
    environment: "host",
    target: "host",
    installationId: randomUUID(),
    custodyOwnerUid: 501,
    installationRoot: directory,
    stateDirectory: directory + "/home",
    serviceDomain: "gui/501",
    serviceLabel: "local.vorteo.test.host",
    launcherPath: file("host.plist").path,
    selectionPath: directory + "/current",
  };
  const originalLauncher = "original launcher";
  const candidateLauncher = "candidate launcher";
  const legacy = directory + "/legacy";
  const environment = { PASEO_HOME: identity.stateDirectory };
  const supervisor = {
    pid: 101,
    parentPid: 1,
    uid: 501,
    bootId: randomUUID(),
    startIdentity: "100:1",
    executable: file("node").path,
    argumentsSha256: "b".repeat(64),
  };
  const precondition = InitialHostSupervisorPreconditionSchema.parse({
    version: 1,
    purpose: "initial-host-supervisor-migration",
    provenance: "service-custody-and-observed-files",
    identity,
    configuration: file("installation.json"),
    launcher: { ...file("host.plist"), sha256: bytesDigest(originalLauncher) },
    clientConfiguration: file("client.json"),
    node: file("node"),
    supervisorEntrypoint: file("legacy/packages/server/dist/scripts/supervisor-entrypoint.js"),
    workerEntrypoint: file("legacy/packages/server/dist/server/server/daemon-worker.js"),
    sourceReceipt: file("legacy/.installation-source.json"),
    selectedRelease: legacy,
    sourceCommit: "b".repeat(40),
    serverId: "host-fixture",
    workerInstanceId: null,
    workerInstanceSupport: "unsupported",
    hostEndpoint: "127.0.0.1:1234",
    registration: {
      program: null,
      arguments: [
        file("node").path,
        file("current/packages/server/dist/scripts/supervisor-entrypoint.js").path,
      ],
      environment,
      loadedEnvironment: environment,
    },
    supervisor,
    worker: { ...supervisor, pid: 102, parentPid: 101, startIdentity: "101:1" },
  });
  const release = (name: string, source: string, artifact: string, launcherSha: string) => ({
    directory: directory + "/" + name,
    sourceCommit: source.repeat(40),
    artifactSha256: artifact.repeat(64),
    node: precondition.node,
    configuration: precondition.configuration,
    launcher: { ...file(name + "/host.plist"), sha256: launcherSha },
    entrypoint: file(name + "/packages/server/dist/scripts/supervisor-entrypoint.js"),
  });
  const plan = InitialHostSupervisorMigrationPlanSchema.parse({
    version: 3,
    operation: "initial-host-supervisor-migration",
    managedReleaseRoot: directory,
    installationId: identity.installationId,
    identitySha256: enrollmentNativeIdentityDigest(precondition.identity),
    preconditionSha256: digest(precondition),
    precondition,
    candidate: release("candidate", "c", "d", bytesDigest(candidateLauncher)),
    fallback: release("sealed-legacy", "b", "f", bytesDigest(originalLauncher)),
    fallbackProvenance: file("fallback-copy.json"),
    interruption: { finishTurnsSeconds: 60, terminateGraceSeconds: 10 },
  });
  const intent = InitialHostMigrationIntentSchema.parse({
    version: 1,
    id: randomUUID(),
    operation: "initial-host-supervisor-migration",
    grantId: randomUUID(),
    grantRevision: randomUUID(),
    manifestSha256: "a".repeat(64),
    stepId: randomUUID(),
    generation: randomUUID(),
    planSha256: digest(plan),
    identitySha256: plan.identitySha256,
    preconditionSha256: plan.preconditionSha256,
    observedAt: "2026-10-17T00:00:00.000Z",
    createdAt: "2026-10-17T00:00:01.000Z",
  });
  const claim = InitialHostMigrationClaimSchema.parse({
    version: 1,
    operation: "initial-host-supervisor-migration",
    intentId: intent.id,
    intentSha256: digest(intent),
    stepId: intent.stepId,
    generation: intent.generation,
    planSha256: digest(plan),
    executor: { ...supervisor, pid: 103, parentPid: 101, startIdentity: "102:1" },
    consumedAt: "2026-10-17T00:00:02.000Z",
  });
  const records = initialHostPublicationRecords({
    plan,
    intent,
    claim,
    enrollmentStateDirectory: directory,
  });
  const recordImage = (record: { file: string; record: unknown }) =>
    present(record.file, JSON.stringify(record.record));
  const input: InitialHostRecoveryImage = {
    enrollmentStateDirectory: directory,
    plan: present(
      file(`initial-host-migrations/plans/${digest(plan)}.json`).path,
      JSON.stringify(plan),
    ),
    intent: present(
      file(`initial-host-${intent.stepId}-${intent.generation}.json`).path,
      JSON.stringify(intent),
    ),
    claim: present(
      file(`initial-host-claim-${claim.stepId}-${claim.generation}.json`).path,
      JSON.stringify(claim),
    ),
    launcher: present(records.launcher.path, originalLauncher),
    phase: absent(records.phase.file),
    launcherAttempt: absent(records.launcherAttempt.file),
    selectorAttempt: absent(records.selectorAttempt.file),
    selector: {
      path: records.selector.path,
      state: "present",
      text: "legacy",
      resolvedTarget: legacy,
    },
  };
  const image = (
    launcher: boolean,
    attempt: boolean,
    phase: boolean,
    selectorAttempt: boolean,
    selector: boolean,
  ) => ({
    ...input,
    launcher: present(records.launcher.path, launcher ? candidateLauncher : originalLauncher),
    launcherAttempt: attempt
      ? recordImage(records.launcherAttempt)
      : absent(records.launcherAttempt.file),
    phase: phase ? recordImage(records.phase) : absent(records.phase.file),
    selectorAttempt: selectorAttempt
      ? recordImage(records.selectorAttempt)
      : absent(records.selectorAttempt.file),
    selector: {
      ...input.selector,
      state: "present" as const,
      text: selector ? records.selector.candidate : "legacy",
      resolvedTarget: selector ? records.selector.candidate : legacy,
    },
  });
  return { input, plan, intent, claim, records, image, recordImage };
}

describe("pure initial Host publication recovery", () => {
  test("classifies all and only reachable publication prefixes", () => {
    const f = fixture();
    const reachable = new Map([
      ["00000", "unchanged-original"],
      ["01000", "unchanged-original"],
      ["11000", "launcher-first-partial"],
      ["11100", "launcher-first-partial"],
      ["11110", "launcher-first-partial"],
      ["11111", "completed-candidate"],
    ]);
    for (let mask = 0; mask < 32; mask++) {
      const bits = mask.toString(2).padStart(5, "0");
      const flags = [...bits].map((bit) => bit === "1") as [
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
      ];
      const classify = () => classifyInitialHostPublication(f.image(...flags));
      const expected = reachable.get(bits);
      if (expected) expect(classify().classification, bits).toBe(expected);
      else expect(classify, bits).toThrow();
    }
  });

  test.each([
    "plan",
    "intent",
    "claim",
    "launcher",
    "phase",
    "launcherAttempt",
    "selectorAttempt",
    "selector",
  ] as const)("refuses inconclusive %s instead of treating it as absence", (key) => {
    const f = fixture();
    const input = { ...f.input, [key]: { path: f.input[key].path, state: "inconclusive" } };
    expect(() => classifyInitialHostPublication(input)).toThrow();
  });

  test.each(["plan", "intent", "claim", "launcher", "selector"] as const)(
    "refuses absent required %s",
    (key) => {
      const f = fixture();
      expect(() =>
        classifyInitialHostPublication({ ...f.input, [key]: absent(f.input[key].path) }),
      ).toThrow();
    },
  );

  test.each([
    "plan",
    "intent",
    "claim",
    "launcher",
    "phase",
    "launcherAttempt",
    "selectorAttempt",
    "selector",
  ] as const)("refuses substituted %s path", (key) => {
    const f = fixture();
    const input = f.image(true, true, true, true, true);
    input[key].path += ".substitute";
    expect(() => classifyInitialHostPublication(input)).toThrow();
  });

  test.each(["intent", "claim", "phase", "launcherAttempt", "selectorAttempt"] as const)(
    "refuses noncanonical or duplicate-key %s bytes",
    (key) => {
      const f = fixture();
      const input = f.image(true, true, true, true, true);
      const file = input[key];
      if (file.state !== "present") throw new Error("Expected record");
      const text = Buffer.from(file.bytes).toString();
      for (const replacement of [text + "\n", text.replace("{", '{"version":1,')]) {
        expect(() =>
          classifyInitialHostPublication({ ...input, [key]: present(file.path, replacement) }),
        ).toThrow();
      }
    },
  );

  test("accepts pretty and reordered plan JSON while preserving the exact captured bytes", () => {
    const f = fixture();
    const compact = classifyInitialHostPublication(f.input);
    const prettyBytes =
      JSON.stringify(Object.fromEntries(Object.entries(f.plan).toReversed()), null, 2) + "\n";
    const pretty = classifyInitialHostPublication({
      ...f.input,
      plan: present(f.input.plan.path, prettyBytes),
    });
    expect(pretty.classification).toBe(compact.classification);
    expect(pretty.snapshot.binding).toEqual(compact.snapshot.binding);
    expect(pretty.snapshot.plan).toMatchObject({
      state: "present",
      bytesBase64: Buffer.from(prettyBytes).toString("base64"),
      sha256: bytesDigest(prettyBytes),
    });
    expect(pretty.snapshotSha256).not.toBe(compact.snapshotSha256);
  });

  test("refuses duplicate and escaped duplicate keys in parsed plan JSON", () => {
    const f = fixture();
    const compact = JSON.stringify(f.plan);
    for (const changed of [
      compact.replace("{", '{"version":1,'),
      compact.replace('"version":3', '"vers\\u0069on":3,"version":3'),
      compact.replace('"finishTurnsSeconds":60', '"finishTurnsSeconds":60,"finishTurnsSeconds":60'),
    ]) {
      expect(() =>
        classifyInitialHostPublication({ ...f.input, plan: present(f.input.plan.path, changed) }),
      ).toThrow("duplicate JSON key");
    }
  });

  test("rejects relative or substituted candidate selector text despite reported resolution", () => {
    const f = fixture();
    const input = f.image(true, true, true, true, true);
    for (const text of ["candidate", "/unrelated", f.records.selector.original]) {
      expect(() =>
        classifyInitialHostPublication({ ...input, selector: { ...input.selector, text } }),
      ).toThrow();
    }
  });

  test("rejects overlapping artifact paths and contradictory absence payloads", () => {
    const f = fixture();
    const absentPhase = {
      path: f.records.phase.file,
      state: "absent" as const,
      bytes: Buffer.from("uncertain"),
    };
    expect(() => classifyInitialHostPublication({ ...f.input, phase: absentPhase })).toThrow(
      "ambiguous observation",
    );
    expect(() =>
      classifyInitialHostPublication({
        ...f.input,
        plan: { ...f.input.plan, path: f.input.launcher.path },
      }),
    ).toThrow();
  });

  test.each(["generation", "intentId", "intentSha256", "planSha256", "stepId"] as const)(
    "refuses another claim's %s",
    (key) => {
      const f = fixture();
      const changed = { ...f.claim, [key]: key.endsWith("Sha256") ? "0".repeat(64) : randomUUID() };
      expect(() =>
        classifyInitialHostPublication({
          ...f.input,
          claim: present(f.input.claim.path, JSON.stringify(changed)),
        }),
      ).toThrow();
    },
  );

  test("refuses addressed attempts from a different executor lifetime", () => {
    const f = fixture();
    const other = initialHostPublicationRecords({
      plan: f.plan,
      intent: f.intent,
      claim: { ...f.claim, executor: { ...f.claim.executor, startIdentity: "999:1" } },
      enrollmentStateDirectory: f.input.enrollmentStateDirectory,
    });
    const input = f.image(true, true, true, true, true);
    expect(() =>
      classifyInitialHostPublication({
        ...input,
        launcherAttempt: f.recordImage(other.launcherAttempt),
      }),
    ).toThrow();
  });

  test("refuses unknown launcher bytes and unknown or fallback selector images", () => {
    const f = fixture();
    expect(() =>
      classifyInitialHostPublication({
        ...f.input,
        launcher: present(f.records.launcher.path, "unreviewed"),
      }),
    ).toThrow();
    for (const target of ["/unrelated", f.records.selector.fallback]) {
      expect(() =>
        classifyInitialHostPublication({
          ...f.input,
          selector: {
            path: f.records.selector.path,
            state: "present",
            text: target,
            resolvedTarget: target,
          },
        }),
      ).toThrow();
    }
  });

  test("refuses indistinguishable candidate launcher bytes", () => {
    const f = fixture();
    f.plan.candidate.launcher.sha256 = f.plan.precondition.launcher.sha256;
    f.intent.planSha256 = digest(f.plan);
    f.claim.planSha256 = f.intent.planSha256;
    f.claim.intentSha256 = digest(f.intent);
    expect(() =>
      classifyInitialHostPublication({
        ...f.input,
        plan: present(
          path.join(
            f.plan.precondition.identity.installationRoot,
            "initial-host-migrations",
            "plans",
            `${digest(f.plan)}.json`,
          ),
          JSON.stringify(f.plan),
        ),
        intent: present(f.input.intent.path, JSON.stringify(f.intent)),
        claim: present(f.input.claim.path, JSON.stringify(f.claim)),
      }),
    ).toThrow("ambiguous");
  });

  test("retains an immutable exact snapshot and digest without mutating inputs", () => {
    const f = fixture();
    const input = f.image(true, true, true, true, false);
    const before = JSON.stringify(input);
    const result = classifyInitialHostPublication(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.snapshotSha256).toBe(digest(result.snapshot));
    expect(result.snapshot.binding).toEqual({
      intentId: f.intent.id,
      stepId: f.claim.stepId,
      generation: f.claim.generation,
      planSha256: digest(f.plan),
      intentSha256: digest(f.intent),
      claimSha256: digest(f.claim),
    });
    expect(result.snapshot.selector.text).toBe("legacy");
    expect(result.snapshot.phase.state).toBe("present");
    if (input.launcher.state !== "present") throw new Error("Expected launcher");
    input.launcher.bytes.fill(0);
    input.selector.resolvedTarget = "/changed";
    expect(result.snapshotSha256).toBe(digest(result.snapshot));
    expect(() => {
      result.snapshot.selector.text = "changed";
    }).toThrow();
    expect(Object.isFrozen(result.snapshot.binding)).toBe(true);
  });

  test("binds absence and exact original link text into the snapshot digest", () => {
    const f = fixture();
    const first = classifyInitialHostPublication(f.input);
    const attempted = classifyInitialHostPublication(f.image(false, true, false, false, false));
    const otherText = classifyInitialHostPublication({
      ...f.input,
      selector: {
        path: f.records.selector.path,
        state: "present",
        text: f.records.selector.original,
        resolvedTarget: f.records.selector.original,
      },
    });
    expect(new Set([first, attempted, otherText].map((result) => result.snapshotSha256)).size).toBe(
      3,
    );
    expect(first.snapshot.phase).toEqual({ path: f.records.phase.file, state: "absent" });
    expect(classifyInitialHostPublication(f.input)).toEqual(first);
  });
});
