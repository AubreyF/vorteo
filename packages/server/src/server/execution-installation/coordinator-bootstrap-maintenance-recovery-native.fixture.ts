import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import type { RecoveryRegistrationPorts } from "./coordinator-bootstrap-maintenance-recovery-registration.js";
import type { z } from "zod";
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
  type MaintenanceServiceEvidenceRecord,
} from "@getpaseo/protocol/maintenance-service";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { claimMaintenanceServiceEffect } from "./coordinator-bootstrap-maintenance-service-claim.js";
import { inspectMaintenanceRecoveryPlan } from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import {
  executeAbsentMaintenanceRecovery,
  observeMaintenanceRecovery,
} from "./coordinator-bootstrap-maintenance-recovery-native.js";
import { FileEnrollmentJournal, changeStandingGrant } from "./maintenance/authorization.js";
import { observeConsumedMaintenanceServiceAbsence } from "./coordinator-bootstrap-maintenance-recovery-inspection.js";
import { inspectMaintenanceServiceReadiness } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { retainEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import {
  maintenanceUserLauncher,
  inspectMaintenanceLauncherPlan,
  type MaintenanceLauncherPlan,
} from "./coordinator-bootstrap-maintenance-launcher.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Seed historical inspection receipts separately from a later effect claim. */
export function retainFixtureServiceAdmission(
  job: MaintenanceServiceJob,
  native: MaintenanceServiceEvidenceRecord["native"],
): void {
  const approval = job.approval!,
    reservation = job.reservation!;
  function proof(requestRevision: string, observedAt: string) {
    const record = MaintenanceServiceEvidenceRecordSchema.parse({
      requestId: job.id,
      requestRevision,
      observedAt,
      planSha256: job.proposal.planSha256,
      identitySha256: job.proposal.identitySha256,
      sourceCommit: job.proposal.sourceCommit,
      artifactSha256: job.proposal.artifactSha256,
      native: structuredClone(native),
    });
    return { sha256: hash(JSON.stringify(record)), record };
  }
  const reviewed = proof(approval.reviewedRevision, approval.approvedAt);
  const reserved = proof(randomUUID(), reservation.reservedAt);
  approval.nativeEvidenceSha256 = reviewed.sha256;
  reservation.nativeEvidenceSha256 = reserved.sha256;
  job.evidence = [reviewed, reserved];
}

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
  const desired =
    context.slot === "previous"
      ? { operation: "rollback", previous: f.plan.candidate }
      : { operation: "recovery", previous: f.plan.previous! };
  const previous = desired.previous;
  const proposal = {
    ...input.job.proposal,
    operation: desired.operation,
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
  retainFixtureServiceAdmission(job, input.job.evidence[0]!.record.native);
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
  const { inspectMaintenanceServiceInvocation } =
    await import("./coordinator-bootstrap-maintenance-service-runner.js");
  const invocationArgs = [
    job.id,
    job.reservation!.requestRevision,
    job.reservation!.generation,
    context.planSha256,
  ];
  const invocationInput = { retained: job, reservation: job.reservation, plan, account: f.account };
  expect(inspectMaintenanceServiceInvocation(invocationArgs, invocationInput).reservation).toEqual(
    job.reservation,
  );
  expect(job.revision).not.toBe(job.reservation!.requestRevision);
  expect(() =>
    inspectMaintenanceServiceInvocation(
      [job.id, job.revision, job.reservation!.generation, context.planSha256],
      invocationInput,
    ),
  ).toThrow("invocation differs");
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
  const counterTarget: "maintenance-controller" | "recovery-launcher" =
    identity.target === "maintenance-controller" ? "recovery-launcher" : "maintenance-controller";
  const currentBoot = {
    target: counterTarget,
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
  const { inspectMaintenanceTargetEvidence } =
    await import("./coordinator-bootstrap-maintenance-executor-evidence.js");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    inspectMaintenanceTargetEvidence({
      ...absenceInput,
      signal: aborted.signal,
      ports: { reader, assertCurrent: () => undefined },
    }),
  ).rejects.toThrow();
  const evidence = await inspectMaintenanceTargetEvidence({
    ...absenceInput,
    ports: { reader, assertCurrent: () => undefined },
  });
  if (input.mode === "recover-observe-unclaimed") {
    // This owning case simulates native/runtime contract ports. The separate
    // runner-contract cases exercise protected retained bytes independently.
    const contractModule = await import("./coordinator-bootstrap-maintenance-runner-contract.js");
    const contract = vi
      .spyOn(contractModule, "verifyUnclaimedMaintenanceExecutor")
      .mockImplementation(async ({ signal }) => ({
        assertCurrent() {
          signal.throwIfAborted();
        },
      }));
    const reserved = job.evidence.find(
      (item) => item.sha256 === job.reservation!.nativeEvidenceSha256,
    )!;
    const selected = f.plan.candidate;
    reserved.record.executor = {
      target: f.plan.identity.target as "maintenance-controller" | "recovery-launcher",
      identitySha256: context.identitySha256,
      planSha256: context.planSha256,
      sourceCommit: selected.sourceCommit,
      artifactSha256: selected.artifactSha256,
      runtimeDirectory: selected.directory,
      setup: selected.setup,
      node: selected.node,
      entrypoint: selected.entrypoint,
      native: {
        ...reserved.record.native,
        process: executor,
        service: {
          ...reserved.record.native.service,
          registered: true,
          launcherSha256: "1".repeat(64),
          registrationSha256: "2".repeat(64),
        },
        selection: {
          ...reserved.record.native.selection,
          receiptSha256: "3".repeat(64),
          sourceCommit: selected.sourceCommit,
          artifactSha256: selected.artifactSha256,
        },
      },
    };
    reserved.sha256 = hash(JSON.stringify(reserved.record));
    job.reservation!.nativeEvidenceSha256 = reserved.sha256;
    job.approval!.nativeEvidenceSha256 = job.evidence[0]!.sha256;
    journal.writeLifecycle([input.failed, job]);
    try {
      const before = readFileSync(path.join(f.enrollmentStateDirectory, "restart-jobs.json"));
      let readinessCalls = 0;
      const observed = await observeMaintenanceRecovery({
        ...absenceInput,
        requestId: job.id,
        reservation: job.reservation!,
        readObservation: async () => {
          readinessCalls++;
          throw new Error("No claimed readiness");
        },
        readUnclaimedEvidence: (signal: AbortSignal) =>
          inspectMaintenanceTargetEvidence({
            ...absenceInput,
            signal,
            ports: { reader, assertCurrent: () => undefined },
          }),
      });
      expect(observed).toMatchObject({
        unclaimedAbsent: true,
        outcome: "unknown",
        ready: false,
        sourceCommit: null,
        artifactSha256: null,
        requestRevision: job.reservation!.requestRevision,
      });
      expect(observed.record).toMatchObject({
        requestRevision: job.reservation!.requestRevision,
        sourceCommit: null,
        artifactSha256: null,
        native: { process: null, service: { registered: false } },
      });
      expect(observed.evidenceSha256).toBe(hash(JSON.stringify(observed.record)));
      observed.assertCurrent();
      expect(readinessCalls).toBe(0);
      expect(readFileSync(path.join(f.enrollmentStateDirectory, "restart-jobs.json"))).toEqual(
        before,
      );
      const { observeServiceJob } = await import("./maintenance/service-progress.js");
      const terminal = observeServiceJob(job, observed, Date.now()).job;
      journal.writeLifecycle([input.failed, terminal]);
      expect(observed.assertCurrent).toThrow();
      const nextPlan = {
        ...plan,
        recoveryOf: {
          requestId: terminal.id,
          generation: terminal.reservation!.generation,
          planSha256: terminal.proposal.planSha256,
          observationSha256: terminal.observation!.evidenceSha256,
        },
      };
      const { inspectNativeMaintenanceRecoveryHistory } =
        await import("./coordinator-bootstrap-maintenance-recovery-history.js");
      const exits: number[] = [];
      const historyInput = {
        stateDirectory: f.enrollmentStateDirectory,
        plan: nextPlan,
        account: f.account,
        signal: new AbortController().signal,
        reader: {
          ...reader,
          inspectProcess: async () => {
            throw new Error("Old process absent");
          },
          verifyProcessExited: async (pid: number) => {
            exits.push(pid);
          },
        },
      };
      const history = await inspectNativeMaintenanceRecoveryHistory(historyInput);
      expect(history.ancestors.map((ancestor) => ancestor.job.id)).toEqual([
        terminal.id,
        input.failed.id,
      ]);
      expect(history.ancestors[0]!.intent).toBeNull();
      const { verifyMaintenanceRecoveryPredecessor } =
        await import("./coordinator-bootstrap-maintenance-recovery-proof.js");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const standalone = await verifyMaintenanceRecoveryPredecessor({
        ...historyInput,
        retained: terminal,
        plan,
        recoveryOf: nextPlan.recoveryOf,
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(11_000);
      standalone.assertExit();
      vi.useRealTimers();

      expect(exits).toEqual([input.failed.effectIntent!.executor.pid]);
      history.assertCurrent();
      await expect(
        inspectNativeMaintenanceRecoveryHistory({
          ...historyInput,
          reader: {
            ...historyInput.reader,
            inspectProcess: async () => input.failed.effectIntent!.executor,
            verifyProcessExited: async () => {
              throw new Error("Consumed ancestor executor still live");
            },
          },
        }),
      ).rejects.toThrow("Retained process lifetime");
    } finally {
      vi.useRealTimers();
      contract.mockRestore();
    }
    return;
  }
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
  if (["recover-observe-original-absent", "recover-observe-consumed-absent"].includes(input.mode)) {
    await exerciseConsumedAbsence({
      kind: input.mode === "recover-observe-original-absent" ? "replacement" : "recovery",
      failed: input.failed,
      originalPlan: f.plan,
      recoveryPlan: plan,
      claim: executeInput,
      absence: absenceInput,
      setRegistered(value) {
        started = value;
      },
    });
    expect(commands).toEqual([]);
    return;
  }
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
  expect(() =>
    inspectMaintenanceServiceInvocation(invocationArgs, {
      ...invocationInput,
      retained,
    }),
  ).toThrow("fresh unconsumed");
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
      if (input.mode === "recover-observe-runtime") {
        const nodeBytes = readFileSync(context.selected.node.path);
        const readWhileLive = vi.fn(readObservation);
        writeFileSync(
          context.selected.node.path,
          "Runtime must not be read while executor is live",
        );
        try {
          await expect(
            observeMaintenanceRecovery({
              ...executeInput,
              reader: {
                ...reader,
                verifyProcessExited: async () => {
                  throw new Error("Recovery executor is live");
                },
                inspectProcess: async () => retained.effectIntent!.executor,
              },
              readObservation: readWhileLive,
            }),
          ).rejects.toThrow("Retained process lifetime exit is unproven");
          expect(readWhileLive).not.toHaveBeenCalled();
          expect(JSON.stringify(journal.readLifecycle())).toBe(before);
        } finally {
          writeFileSync(context.selected.node.path, nodeBytes);
        }
      }
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
  await exerciseRecoveryObservationDeadlines({ mode: input.mode, executeInput, journal, commands });
}

interface RecoveryObservationDeadlines {
  mode: string;
  executeInput: Parameters<typeof executeAbsentMaintenanceRecovery>[0];
  journal: FileBootstrapRequestJournal;
  commands: string[][];
}

async function exerciseRecoveryObservationDeadlines(input: RecoveryObservationDeadlines) {
  const { mode, executeInput, journal, commands } = input;
  if (mode === "recover-observe-timeout") {
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
  if (mode === "recover-observe-late") {
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
            const result = await executeInput.readCandidateObservation(signal);
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

interface ConsumedAbsenceFixture {
  kind: "replacement" | "recovery";
  failed: MaintenanceServiceJob;
  originalPlan: MaintenanceLauncherPlan;
  recoveryPlan: unknown;
  claim: Parameters<typeof claimMaintenanceServiceEffect>[0];
  absence: Parameters<typeof observeConsumedMaintenanceServiceAbsence>[0];
  setRegistered(value: boolean): void;
}

async function exerciseConsumedAbsence(input: ConsumedAbsenceFixture) {
  const journal = new FileBootstrapRequestJournal(input.absence.stateDirectory);
  const replacement = input.kind === "replacement";
  const job = replacement
    ? structuredClone(input.failed)
    : claimMaintenanceServiceEffect(input.claim);
  if (replacement) {
    job.status = "running";
    delete job.observation;
    journal.writeLifecycle([job]);
  }
  const identity = input.originalPlan.identity;
  if (identity.environment !== "host" || !identity.selectionPath)
    throw new Error("Fixture requires native selection");
  writeFileSync(identity.selectionPath, "{partial selection", { mode: 0o600 });
  const before = readFileSync(path.join(input.absence.stateDirectory, "restart-jobs.json"));
  const currentBoot = {
    ...input.absence.currentBoot,
    process: { ...input.absence.currentBoot.process, pid: process.pid + 200000 },
  };
  const plan = replacement ? input.originalPlan : input.recoveryPlan;
  if (replacement) {
    const node = input.originalPlan.candidate.node.path;
    const bytes = readFileSync(node);
    writeFileSync(node, "Unverified runtime bytes");
    try {
      await expect(
        observeConsumedMaintenanceServiceAbsence({
          ...input.absence,
          request: job,
          plan,
          currentBoot: {
            ...currentBoot,
            process: { ...currentBoot.process, bootId: job.effectIntent!.executor.bootId },
          },
          reader: {
            ...input.absence.reader,
            inspectProcess: async () => job.effectIntent!.executor,
            verifyProcessExited: async () => {
              throw new Error("Consumed executor live");
            },
          },
        }),
      ).rejects.toThrow("Retained process lifetime");
    } finally {
      writeFileSync(node, bytes);
    }
  }
  const observation = await observeConsumedMaintenanceServiceAbsence({
    ...input.absence,
    request: job,
    plan,
    currentBoot,
    assertRuntimeAbsent(value) {
      expect(value.allowedProcesses).toEqual([currentBoot]);
      input.absence.assertRuntimeAbsent!(value);
    },
  });
  expect(observation).toMatchObject({
    requestId: job.id,
    requestRevision: job.reservation!.requestRevision,
    generation: job.reservation!.generation,
    outcome: "unknown",
    ready: false,
    sourceCommit: null,
    artifactSha256: null,
  });
  expect(observation.record).toMatchObject({
    requestRevision: job.reservation!.requestRevision,
    sourceCommit: null,
    artifactSha256: null,
    native: {
      process: null,
      service: { registered: false },
      selection: {
        receiptSha256: hash("{partial selection"),
        sourceCommit: null,
        artifactSha256: null,
      },
    },
  });
  expect(observation.evidenceSha256).toBe(hash(JSON.stringify(observation.record)));
  observation.assertCurrent();
  expect(readFileSync(path.join(input.absence.stateDirectory, "restart-jobs.json"))).toEqual(
    before,
  );
  input.setRegistered(true);
  expect(observation.assertCurrent).toThrow();
  input.setRegistered(false);
  const { observeServiceJob } = await import("./maintenance/service-progress.js");
  const uncertain = observeServiceJob(job, observation, Date.now()).job;
  expect(uncertain.status).toBe("running");
  expect(uncertain.effectIntent).toEqual(job.effectIntent);
  journal.writeLifecycle(replacement ? [uncertain] : [input.failed, uncertain]);
  expect(observation.assertCurrent).toThrow();
  const recovery = inspectMaintenanceRecoveryPlan(input.recoveryPlan, input.absence.account);
  const nextPlan = {
    ...recovery.plan,
    recoveryOf: {
      requestId: uncertain.id,
      generation: uncertain.reservation!.generation,
      planSha256: uncertain.proposal.planSha256,
      observationSha256: uncertain.observation!.evidenceSha256,
    },
  };
  const { inspectNativeMaintenanceRecoveryHistory } =
    await import("./coordinator-bootstrap-maintenance-recovery-history.js");
  const history = await inspectNativeMaintenanceRecoveryHistory({
    ...input.absence,
    plan: nextPlan,
  });
  expect(history.ancestors.map((ancestor) => ancestor.job.id)).toEqual(
    replacement ? [uncertain.id] : [uncertain.id, input.failed.id],
  );
  history.assertCurrent();
  journal.writeLifecycle(replacement ? [] : [uncertain]);
  expect(history.assertCurrent).toThrow();
}

interface RecoveryFixtureServe {
  TCP: Record<string, { HTTPS: boolean }>;
  Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
  ExtraFutureSetting: { retained: boolean };
}
interface RecoveryPortFixture {
  plan: MaintenanceLauncherPlan;
  account: { uid: number; home: string };
  enrollmentStateDirectory: string;
  routing: {
    access: NonNullable<
      NonNullable<z.infer<typeof MaintenanceLauncherSetupSchema>["control"]>["recoveryAccess"]
    >;
    backend: unknown;
    previousServe: RecoveryFixtureServe;
  };
}

/** Existing inert registration ports shared by seeded and unseeded source tests. */
export function prepareRecoveryRegistrationFixturePorts(
  f: RecoveryPortFixture,
  mode: string,
  revoke: () => unknown,
) {
  const bootstrap = new FileBootstrapRequestJournal(f.enrollmentStateDirectory);
  const commands: string[][] = [];
  let registered = false;
  let revoked = false;
  let serve = structuredClone(f.routing.previousServe);
  const native = {
    pid: 43123,
    parentPid: 1,
    uid: f.account.uid,
    bootId: randomUUID(),
    startIdentity: "1000:42",
    executable: f.plan.candidate.node.path,
    argumentsSha256: createHash("sha256")
      .update(JSON.stringify(maintenanceUserLauncher(f.plan, "candidate").ProgramArguments))
      .digest("hex"),
  };
  const ports: RecoveryRegistrationPorts = {
    reader: {
      async readService(service) {
        if (!registered) throw new Error("Fixture service absent");
        return `${service} = {\n\tpid = ${native.pid}\n}`;
      },
      async inspectProcess(pid) {
        if (!registered || pid !== native.pid) throw new Error("Fixture process absent");
        return { ...native };
      },
    },
    async readRouting() {
      const observed = {
        backend: structuredClone(f.routing.backend),
        serve: structuredClone(serve),
      };
      return {
        ...observed,
        assertCurrent() {
          if (mode === "route-custody-after-start" && registered)
            throw new Error("Fixture routing custody changed");
          expect({ backend: f.routing.backend, serve }).toEqual(observed);
        },
      };
    },
    assertAbsent() {
      expect(() => bootstrap.withRecoveryTransaction(() => undefined)).toThrow("storage is busy");
      if (registered) throw new Error("Fixture service is already present");
    },
    async inspectListener({ process: observedProcess }) {
      bootstrap.withRecoveryTransaction(() => undefined);
      expect(observedProcess).toEqual(native);
      if (mode === "revoke-after-start" && !revoked) {
        revoke();
        revoked = true;
      }
      if (mode === "route-drift-after-start") serve.ExtraFutureSetting.retained = false;
      return {
        assertCurrent() {
          if (!registered) throw new Error("Fixture listener custody changed");
          expect(observedProcess).toEqual(native);
        },
      };
    },
    async run(executable, args) {
      bootstrap.withRecoveryTransaction(() => undefined);
      commands.push([executable, ...args]);
      if (executable === "/bin/launchctl") {
        const identity = f.plan.identity;
        if (identity.environment !== "host")
          throw new Error("Recovery fixture requires Host identity");
        expect(args).toEqual(["bootstrap", identity.serviceDomain, identity.launcherPath]);
        expect(registered).toBe(false);
        registered = true;
        if (mode === "lost-start") throw new Error("Lost start reply");
      } else {
        expect(executable).toBe(f.plan.recoveryRoute!.tailscale.path);
        expect(args).toEqual(["serve", "--bg", "--https=9443", "http://127.0.0.1:4446"]);
        serve.TCP["9443"] = { HTTPS: true };
        serve.Web["machine.tail123.ts.net:9443"] = {
          Handlers: { "/": { Proxy: "http://127.0.0.1:4446" } },
        };
        if (mode === "lost-route") throw new Error("Lost route reply");
      }
    },
  };

  return { ports, commands };
}

/** Files and inert native/routing ports only. Creates no grant or provisioning. */
export async function prepareUnseededRecoveryRegistrationFixture(input: {
  root: string;
  stateDirectory: string;
  installationId: string;
  ownerConfigurationFile: string;
  mode: string;
}) {
  const home = path.join(input.root, "fixture-home");
  const base = path.join(input.root, "maintenance-services/recovery-launcher");
  mkdirSync(path.join(home, "Library/LaunchAgents"), { recursive: true, mode: 0o700 });
  mkdirSync(base, { recursive: true, mode: 0o700 });
  function pin(file: string, bytes: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: hash(bytes) };
  }
  const directory = path.join(input.root, "maintenance-runtimes", "c".repeat(40));
  const entrypoint = pin(
    path.join(
      directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-access.js",
    ),
    "inert recovery entrypoint",
  );
  const node = pin(path.join(directory, "node"), "inert recovery node");
  const access = {
    installationId: input.installationId,
    origin: "https://machine.tail123.ts.net:9443",
    listenPort: 4446,
    ownerConfigurationFile: input.ownerConfigurationFile,
  };
  const plan: MaintenanceLauncherPlan = {
    version: 1,
    operation: "maintenance-launcher-replacement",
    retryLimit: 3,
    recovery: "after-login",
    identity: {
      version: 1,
      environment: "host",
      target: "recovery-launcher",
      installationId: input.installationId,
      custodyOwnerUid: process.getuid!(),
      installationRoot: input.root,
      stateDirectory: input.stateDirectory,
      serviceDomain: `gui/${process.getuid!()}`,
      serviceLabel: "local.vorteo.fixture-recovery.installation",
      launcherPath: path.join(
        home,
        "Library/LaunchAgents/local.vorteo.fixture-recovery.installation.plist",
      ),
      selectionPath: path.join(base, "selection.json"),
    },
    previous: null,
    candidate: {
      sourceCommit: "c".repeat(40),
      directory,
      artifactSha256: "0".repeat(64),
      node,
      entrypoint,
      setup: pin(
        path.join(base, "c".repeat(40) + ".json"),
        JSON.stringify({
          version: 1,
          installationRoot: input.root,
          enrollmentStateDirectory: input.stateDirectory,
          identitySha256: "0".repeat(64),
          target: "recovery-launcher",
          sourceCommit: "c".repeat(40),
          nativeAdmission: {
            path: path.join(input.root, "inert-admission.json"),
            sha256: "a".repeat(64),
          },
          control: { admissionSha256: "d".repeat(64), recoveryAccess: access },
        }),
      ),
    },
  };
  const { enrollmentNativeIdentityDigest } = await import("./maintenance/native-identity.js");
  const setup = JSON.parse(readFileSync(plan.candidate.setup.path, "utf8"));
  setup.identitySha256 = enrollmentNativeIdentityDigest(plan.identity);
  plan.candidate.setup = pin(plan.candidate.setup.path, JSON.stringify(setup));
  const previousServe: RecoveryFixtureServe = {
    TCP: { "44444": { HTTPS: true } },
    Web: {
      "machine.tail123.ts.net:44444": { Handlers: { "/": { Proxy: "http://127.0.0.1:6770" } } },
    },
    ExtraFutureSetting: { retained: true },
  };
  plan.recoveryRoute = {
    tailscale: node,
    previousServe: pin(path.join(input.root, "previous-serve.json"), JSON.stringify(previousServe)),
  };
  plan.candidate.artifactSha256 = await digestBootstrapArtifact(directory);
  const f = {
    plan,
    account: { uid: process.getuid!(), home },
    enrollmentStateDirectory: input.stateDirectory,
    writableMountRoots: [],
    routing: {
      access,
      backend: { BackendState: "Running", Self: { DNSName: "machine.tail123.ts.net." } },
      previousServe,
    },
  };
  const inspected = inspectMaintenanceLauncherPlan(plan, f.account);
  mkdirSync(path.join(base, "plans"), { mode: 0o700 });
  writeFileSync(path.join(base, "plans", inspected.planSha256 + ".json"), JSON.stringify(plan), {
    mode: 0o600,
  });
  // Synthetic native identity metadata is a fixture input, never installed evidence.
  retainEnrollmentNativeIdentity(input.stateDirectory, plan.identity);
  const journal = new FileEnrollmentJournal(input.stateDirectory);
  const revoke = () => {
    const current = journal.read();
    if (current.status !== "enrolled") throw Error("Fixture grant absent");
    return changeStandingGrant(journal, {
      expectedRevision: current.grant.revision,
      paused: false,
      disabledTargets: [],
      revoke: true,
    });
  };
  return {
    ...f,
    inspected,
    journal,
    revoke,
    ...prepareRecoveryRegistrationFixturePorts(f, input.mode, revoke),
  };
}
