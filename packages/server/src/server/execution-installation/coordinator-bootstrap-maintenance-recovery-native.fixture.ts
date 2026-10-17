import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  MaintenanceServiceJobSchema,
  MaintenanceServiceEvidenceRecordSchema,
  type MaintenanceServiceJob,
} from "@getpaseo/protocol/maintenance-service";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { claimMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-claim.js";
import { inspectMaintenanceRecoveryPlan } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import {
  executeAbsentMaintenanceRecovery,
  observeMaintenanceRecovery,
} from "./coordinator-bootstrap-maintenance-recovery-native.js";
import { FileEnrollmentJournal, changeStandingGrant } from "./maintenance/authorization.js";
import { inspectMaintenanceServiceReadiness } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { inspectAbsentMaintenanceRecovery } from "./coordinator-bootstrap-maintenance-recovery-inspection.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  maintenanceUserLauncher,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Disposable filesystem and native-port fixture. No installed service command. */
export async function exerciseAbsentRecovery(input: {
  f: {
    plan: MaintenanceLauncherPlan;
    enrollmentStateDirectory: string;
    account: { uid: number; home: string };
  };
  mode: string;
  failed: MaintenanceServiceJob;
  job: MaintenanceServiceJob;
  plan: unknown;
  claimInput: Parameters<typeof claimMaintenanceServiceEffect>[0];
}) {
  const { f } = input;
  const original = inspectMaintenanceRecoveryPlan(input.plan, f.account);
  const plan = {
    ...original.plan,
    operation: ["recover-rollback", "recover-observe-rollback"].includes(input.mode)
      ? "maintenance-service-rollback"
      : "maintenance-service-recovery",
  };
  const context = inspectMaintenanceRecoveryPlan(plan, f.account);
  const previous = context.slot === "previous" ? f.plan.candidate : f.plan.previous!;
  const proposal = {
    ...input.job.proposal,
    operation: context.slot === "previous" ? "rollback" : "recovery",
    planSha256: context.planSha256,
    sourceCommit: context.selected.sourceCommit,
    artifactSha256: context.selected.artifactSha256,
    previous: { sourceCommit: previous.sourceCommit, artifactSha256: previous.artifactSha256 },
  };
  const proposalSha256 = hash(JSON.stringify(proposal));
  const job = MaintenanceServiceJobSchema.parse({
    ...input.job,
    operation: proposal.operation,
    proposal,
    approval: { ...input.job.approval, proposalSha256 },
    reservation: {
      ...input.job.reservation,
      operation: proposal.operation,
      planSha256: context.planSha256,
      sourceCommit: proposal.sourceCommit,
      artifactSha256: proposal.artifactSha256,
      previous: proposal.previous,
      proposalSha256,
    },
  });
  const identity = context.identity;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new Error("Fixture requires Host identity");
  retainEnrollmentNativeIdentity(f.enrollmentStateDirectory, identity);
  const plans = path.join(path.dirname(identity.selectionPath), "plans");
  mkdirSync(plans, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(plans, `${context.plan.originalPlanSha256}.json`),
    JSON.stringify(f.plan),
    { mode: 0o600 },
  );
  writeFileSync(path.join(plans, `${context.planSha256}.json`), JSON.stringify(plan), {
    mode: 0o600,
  });
  const journal = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  journal.writeLifecycle([input.failed, job]);
  const executor = BootstrapProcessIdentitySchema.parse({
    ...(input.claimInput.executor as object),
    bootId: randomUUID(),
  });
  const targetProcess = {
    ...executor,
    pid: process.pid + 100000,
    parentPid: 1,
    executable: context.selected.node.path,
    argumentsSha256: hash(
      JSON.stringify(maintenanceUserLauncher(f.plan, context.slot).ProgramArguments),
    ),
  };
  let started = false;
  const service = `${identity.serviceDomain}/${identity.serviceLabel}`;
  const assertAbsent = () => {
    if (started) throw new Error("Target is already running");
  };
  const assertRuntimeAbsent = () => {
    if (started) throw new Error("Target runtime is live");
  };
  const reader = {
    readService: async () => `${service} = {\n\tpid = ${targetProcess.pid}\n}`,
    inspectProcess: async () => targetProcess,
    inspectAuditedProcess: async () => {
      throw new Error("Unexpected audited inspection in recovery fixture");
    },
    inspectRunningProcess: async () => {
      throw new Error("Unexpected running inspection in recovery fixture");
    },
    inspectStoppedProcess: async () => {
      throw new Error("Unexpected stopped inspection in recovery fixture");
    },
    verifyProcessExited: async () => undefined,
    verifyServiceAbsent: async () => assertAbsent(),
  };
  const currentBoot = {
    target: "maintenance-controller" as const,
    installationId: identity.installationId,
    process: executor,
    assertCurrent: () => undefined,
  };
  const childCustody = { process: executor, assertCurrent: () => undefined };
  const absenceInput = {
    request: job,
    plan,
    account: f.account,
    stateDirectory: f.enrollmentStateDirectory,
    writableMountRoots: [],
    reader,
    currentBoot,
    childCustody,
    assertAbsent,
    assertRuntimeAbsent,
    signal: new AbortController().signal,
  };
  const evidence = await inspectAbsentMaintenanceRecovery(absenceInput);
  const commands: string[][] = [];
  const executeInput = {
    ...input.claimInput,
    ...absenceInput,
    requestId: job.id,
    expectedRevision: job.revision,
    reservation: job.reservation!,
    executor,
    evidence,
    admission: () => undefined,
    requireExecutor: async () => executor,
    readCandidateObservation: async () => {
      const retained = MaintenanceServiceJobSchema.parse(
        journal.readLifecycle().find((item) => item.id === job.id),
      );
      expect(retained.effectIntent).toBeTruthy();
      const observedAt = new Date().toISOString();
      const record = MaintenanceServiceEvidenceRecordSchema.parse({
        requestId: job.id,
        requestRevision: job.reservation!.requestRevision,
        planSha256: context.planSha256,
        identitySha256: context.identitySha256,
        sourceCommit: context.selected.sourceCommit,
        artifactSha256: context.selected.artifactSha256,
        observedAt,
        native: {
          bootId: executor.bootId,
          process: targetProcess,
          service: {
            domain: identity.serviceDomain,
            label: identity.serviceLabel,
            registered: true,
            launcherPath: identity.launcherPath,
            launcherSha256: hash(readFileSync(identity.launcherPath)),
            registrationSha256: hash(JSON.stringify(maintenanceUserLauncher(f.plan, context.slot))),
          },
          selection: {
            path: identity.selectionPath,
            receiptSha256: hash(readFileSync(identity.selectionPath!)),
            sourceCommit: context.selected.sourceCommit,
            artifactSha256: context.selected.artifactSha256,
          },
        },
      });
      return {
        requestId: job.id,
        requestRevision: job.reservation!.requestRevision,
        generation:
          input.mode === "recover-wrong-observation" ? randomUUID() : job.reservation!.generation,
        planSha256: context.planSha256,
        identitySha256: context.identitySha256,
        outcome: "candidate" as const,
        ready: input.mode !== "recover-unready-execution",
        sourceCommit: context.selected.sourceCommit,
        artifactSha256: context.selected.artifactSha256,
        evidenceSha256: hash(JSON.stringify(record)),
        observedAt,
        record,
        assertCurrent: () => undefined,
      };
    },
  };
  const lostStartReply = [
    "recover-lost-start",
    "recover-observe-lost-start",
    "recover-observe-runtime",
    "recover-observe-rollback",
    "recover-observe-unready",
  ].includes(input.mode);
  const command = {
    run: async (args: readonly string[]) => {
      journal.withRecoveryTransaction(() => undefined);
      commands.push([...args]);
      expect(args).toEqual(["bootstrap", identity.serviceDomain, identity.launcherPath]);
      started = true;
      if (lostStartReply) throw new Error("Lost native start reply");
    },
  };
  if (lostStartReply)
    await expect(executeAbsentMaintenanceRecovery(executeInput, command)).rejects.toThrow(
      "Lost native start reply",
    );
  else if (input.mode === "recover-wrong-observation")
    await expect(executeAbsentMaintenanceRecovery(executeInput, command)).rejects.toThrow(
      "post-intent observation",
    );
  else if (input.mode === "recover-unready-execution")
    await expect(executeAbsentMaintenanceRecovery(executeInput, command)).rejects.toThrow(
      "candidate is not ready",
    );
  else {
    const result = await executeAbsentMaintenanceRecovery(executeInput, command);
    expect(result).toMatchObject({
      ready: true,
      outcome: "candidate",
      sourceCommit: context.selected.sourceCommit,
    });
    result.assertCurrent();
    const selectedBytes = readFileSync(identity.selectionPath);
    writeFileSync(identity.selectionPath, "changed after observation");
    expect(result.assertCurrent).toThrow();
    writeFileSync(identity.selectionPath, selectedBytes);
  }
  expect(commands).toHaveLength(1);
  expect(journal.readLifecycle()[0]).toEqual(input.failed);
  const retained = MaintenanceServiceJobSchema.parse(journal.readLifecycle()[1]);
  expect(retained.effectIntent).toBeTruthy();
  await expect(
    executeAbsentMaintenanceRecovery(
      { ...executeInput, expectedRevision: retained.revision },
      command,
    ),
  ).rejects.toThrow("fresh unconsumed");
  expect(commands).toHaveLength(1);
  if (
    [
      "recover-observe-lost-start",
      "recover-observe-runtime",
      "recover-observe-rollback",
      "recover-observe-unready",
    ].includes(input.mode)
  ) {
    const enrollment = new FileEnrollmentJournal(f.enrollmentStateDirectory);
    const state = enrollment.read();
    if (state.status !== "enrolled") throw new Error("Missing fixture enrollment");
    changeStandingGrant(enrollment, {
      expectedRevision: state.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
    const before = JSON.stringify(
      new FileBootstrapRequestJournal(f.enrollmentStateDirectory).readLifecycle(),
    );
    const revoked = JSON.stringify(enrollment.read());
    const server = createServer((request, response) => {
      const nonce = new URL(request.url!, "http://127.0.0.1").searchParams.get("nonce");
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          version: 1,
          nonce,
          installationId: identity.installationId,
          target: identity.target,
          identitySha256: context.identitySha256,
          sourceCommit: context.selected.sourceCommit,
          artifactSha256: context.selected.artifactSha256,
          process: targetProcess,
          ready: input.mode !== "recover-observe-unready",
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      writeFileSync(
        path.join(identity.installationRoot, `maintenance-control-${targetProcess.pid}.json`),
        JSON.stringify({
          version: 1,
          admissionSha256: "a".repeat(64),
          requestId: randomUUID(),
          process: targetProcess,
          address: "127.0.0.1",
          port: address.port,
        }),
        { mode: 0o600 },
      );
      const readObservation = [
        "recover-observe-runtime",
        "recover-observe-rollback",
        "recover-observe-unready",
      ].includes(input.mode)
        ? (signal: AbortSignal) =>
            inspectMaintenanceServiceReadiness({
              ...executeInput,
              signal,
              ports: { reader, assertCurrent: () => undefined },
            })
        : executeInput.readCandidateObservation;
      const result = await observeMaintenanceRecovery({ ...executeInput, readObservation });
      expect(result).toMatchObject({
        ready: input.mode !== "recover-observe-unready",
        outcome: "candidate",
        generation: job.reservation!.generation,
        sourceCommit: context.selected.sourceCommit,
      });
      expect(result.record.native.service.registrationSha256).toBe(
        hash(JSON.stringify(maintenanceUserLauncher(f.plan, context.slot))),
      );
      result.assertCurrent();
      expect(JSON.stringify(journal.readLifecycle())).toBe(before);
      expect(JSON.stringify(enrollment.read())).toBe(revoked);
      expect(commands).toHaveLength(1);
      const changed = journal.readLifecycle();
      const current = changed.find((entry) => entry.id === job.id);
      if (!current) throw new Error("Missing fixture recovery");
      current.revision = randomUUID();
      journal.writeLifecycle(changed);
      expect(result.assertCurrent).toThrow("changed");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  }
  if (input.mode === "recover-observe-timeout") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    let notify: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const pending = observeMaintenanceRecovery({
      ...executeInput,
      readObservation: (current) => {
        signal = current;
        notify();
        return new Promise(() => undefined);
      },
    });
    const rejected = expect(pending).rejects.toThrow("timed out");
    await reading;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(commands).toHaveLength(1);
    vi.useRealTimers();
  }
  if (input.mode === "recover-observe-late") {
    const before = JSON.stringify(journal.readLifecycle());
    const startedAt = performance.now();
    const clock = vi.spyOn(performance, "now").mockReturnValue(startedAt);
    let observedSignal: AbortSignal | undefined;
    try {
      await expect(
        observeMaintenanceRecovery({
          ...executeInput,
          readObservation: async (signal) => {
            observedSignal = signal;
            const result = await executeInput.readCandidateObservation();
            // Model native validation exhausting its budget before timer delivery.
            clock.mockReturnValue(startedAt + 30_001);
            return result;
          },
        }),
      ).rejects.toThrow("timed out");
    } finally {
      clock.mockRestore();
    }
    expect(observedSignal?.aborted).toBe(true);
    expect(JSON.stringify(journal.readLifecycle())).toBe(before);
    expect(commands).toHaveLength(1);
  }
}
