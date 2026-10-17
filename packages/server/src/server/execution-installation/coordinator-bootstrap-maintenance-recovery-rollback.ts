import path from "node:path";
import { mkdir, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CoordinatorBootstrapPlanSchema,
  CoordinatorBootstrapRequestSchema,
  CoordinatorBootstrapDecisionSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import { openBootstrapRequests, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { terminalBootstrapRelease } from "./coordinator-bootstrap-renewal.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  createBootstrapReviewService,
  readBootstrapHostBinding,
  verifyBootstrapPlan,
} from "./coordinator-bootstrap-host.js";
import { InstallationConfigSchema } from "./config.js";
import {
  createNativeBootstrapServiceReader,
  loadedCoordinatorPid,
  verifyLoadedBootstrapService,
} from "./coordinator-bootstrap-service.js";
import { inspectNativeRecoveryReviewParent } from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";
import { maintenanceExecutorStartupBinding } from "./coordinator-bootstrap-maintenance-executor-evidence.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import { bootstrapRecoveryLauncher } from "./coordinator-bootstrap-boot-recovery.js";
import {
  createDispatchingBootstrapReview,
  writeRecoverySnapshot,
} from "./coordinator-bootstrap-launch.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";

interface RollbackInstallation {
  installationId: string;
  stateDirectory: string;
  service: string;
}

/** Selection is not dispatch authority. An explicit reviewed compatible slot
 * is required; timestamps, version ordering and basic health choose nothing. */
export function selectIndependentCoordinatorRollback(input: {
  records: unknown;
  installation: RollbackInstallation;
}) {
  const records = z.array(CoordinatorBootstrapRequestSchema).parse(input.records);
  const history = terminalBootstrapRelease(records, input.installation);
  if (openBootstrapRequests(records).length > 0)
    throw new BootstrapRequestConflict("Another coordinator review remains open");
  if (!history || history.request.execution?.stage !== "succeeded")
    throw new BootstrapRequestConflict("Rollback requires a successfully selected coordinator");
  const candidate = history.request.plan.compatibleRecovery;
  const previous = history.release;
  if (
    history.request.plan.automaticRecovery !== "restore-compatible" ||
    !candidate ||
    candidate.sourceCommit === previous.sourceCommit ||
    candidate.directory === previous.directory ||
    candidate.configuration.sha256 !== previous.configuration.sha256
  )
    throw new BootstrapRequestConflict(
      "No distinct configuration-preserving compatible rollback is retained",
    );
  return { previous, candidate, state: history.request.plan.state };
}

interface IndependentRollbackInput {
  setupFile: string;
  account: { uid: number; home: string };
  stateDirectory: string;
}

/** Reopening a pending review grants no launch authority. In particular an
 * approved but unclaimed generation cannot enter the decision path again. */
function requirePendingManualRollback(
  records: z.infer<typeof CoordinatorBootstrapRequestSchema>[],
  requestId: string,
) {
  const request = records.find((record) => record.id === requestId);
  if (
    !request ||
    request.status !== "pending" ||
    request.decisionAt ||
    request.execution ||
    request.automaticSubmission ||
    request.automaticApproval ||
    request.automaticDispatch ||
    request.automaticCheck ||
    request.enrollment ||
    request.enrollmentDispatch ||
    request.standingAuthority ||
    request.standingDispatch ||
    request.supervisionDispatch ||
    coordinatorPlanDigest(request.plan) !== request.planSha256
  )
    throw new BootstrapRequestConflict("Exact undecided manual rollback review required");
  return request;
}

export function inspectIndependentCoordinatorRollbackRequest(input: {
  records: unknown;
  requestId: string;
  installation: RollbackInstallation;
  runtime: Awaited<ReturnType<typeof inspectNativeRecoveryReviewParent>>["startup"]["selected"];
  home: string;
}) {
  const records = z.array(CoordinatorBootstrapRequestSchema).parse(input.records);
  const request = requirePendingManualRollback(records, input.requestId);
  const selected = selectIndependentCoordinatorRollback({
    records: records.filter((record) => record.id !== request.id),
    installation: input.installation,
  });
  const recovery = request.plan.bootRecovery;
  const directory = path.join(
    input.installation.stateDirectory,
    `coordinator-recovery-${request.id}`,
  );
  const runner = path.join(
    input.runtime.directory,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
  );
  const service = `${input.installation.service}-recovery-${request.id}`;
  if (
    !recovery ||
    recovery.requestId !== request.id ||
    recovery.service !== service ||
    recovery.setup.path !== path.join(directory, "setup.json") ||
    recovery.launcher.path !== path.join(directory, "boot-recovery.plist") ||
    recovery.installedLauncher !==
      path.join(
        input.home,
        "Library/LaunchAgents",
        `${service.split("/").slice(2).join("/")}.plist`,
      ) ||
    !isDeepStrictEqual(recovery.node, input.runtime.node) ||
    recovery.entrypoint.path !== runner ||
    recovery.ownerLauncher.path !==
      path.join(input.runtime.directory, "scripts/run-coordinator-owner.py")
  )
    throw new BootstrapRequestConflict(
      "Rollback review differs from the selected independent runtime",
    );
  const expected = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: input.installation.installationId,
    service: input.installation.service,
    expectedProcess: request.plan.expectedProcess,
    ...selected,
    hostRequestsAfter: null,
    automaticRecovery: "restore-previous",
    bootRecovery: recovery,
  });
  if (!isDeepStrictEqual(request.plan, expected))
    throw new BootstrapRequestConflict("Rollback review changes its exact retained scope");
  return { request, recovery, selected, directory };
}

export function createIndependentCoordinatorRecoveryReviews(
  input: IndependentRollbackInput,
): BootstrapReviewService & {
  prepareRollback(): Promise<void>;
} {
  return {
    list: () => new FileBootstrapRequestJournal(input.stateDirectory).read(),
    async prepare() {
      throw new BootstrapRequestConflict("Recovery prepares only its retained compatible rollback");
    },
    async prepareRollback() {
      await prepareIndependentCoordinatorRollback(input);
    },
    async decide(value, password) {
      const decision = CoordinatorBootstrapDecisionSchema.parse(value);
      const context = await readRollbackReviewContext(input);
      if (decision.decision === "cancel") {
        const requests = await createBootstrapReviewService(
          context.parent.startup.setup.nativeAdmission.path,
          context.host.serverId,
        );
        return requests.decide(decision, password);
      }
      const retained = inspectIndependentCoordinatorRollbackRequest({
        records: context.journal.read(),
        requestId: decision.id,
        installation: context.installation,
        runtime: context.parent.startup.selected,
        home: input.account.home,
      });
      const setup = BootstrapRunnerSetupSchema.parse(
        JSON.parse(
          (
            await readBootstrapPreparedFile(
              retained.recovery.setup,
              context.parent.writableMountRoots,
            )
          ).toString("utf8"),
        ),
      );
      const admissionFile = path.join(retained.directory, "admission.json");
      const admission = BootstrapAdmissionSetupSchema.parse(
        JSON.parse((await readProtectedDocument(admissionFile)).toString("utf8")),
      );
      if (
        setup.admissionSetupFile !== admissionFile ||
        setup.daemonId !== context.host.serverId ||
        setup.runtimeDirectory !== context.parent.startup.selected.directory ||
        setup.runtimeSha256 !== context.parent.startup.selected.artifactSha256 ||
        setup.renewal ||
        setup.maintenance ||
        setup.supervision ||
        !isDeepStrictEqual(admission, {
          ...context.admission,
          configurationFile: retained.selected.previous.configuration.path,
        })
      )
        throw new BootstrapRequestConflict(
          "Retained rollback setup changed its installation binding",
        );
      const verifySetup = async () => {
        const current = await inspectNativeRecoveryReviewParent(input);
        if (
          !isDeepStrictEqual(current.process, context.parent.process) ||
          !isDeepStrictEqual(
            maintenanceExecutorStartupBinding(current.startup),
            maintenanceExecutorStartupBinding(context.parent.startup),
          )
        )
          throw new BootstrapRequestConflict("Recovery review parent changed before decision");
        current.assertCurrent();
        return current.writableMountRoots;
      };
      const requests = await createBootstrapReviewService(admissionFile, context.host.serverId);
      const review = createDispatchingBootstrapReview({
        setup,
        setupFile: retained.recovery.setup.path,
        requests,
        verifySetup,
        dispatchWaitTimeoutMs: 25_000,
      });
      return review.decide(decision, password);
    },
  };
}

/** Called lazily after owner authentication by the independent page. This
 * prepares one pending manual review; only its matching owner decision dispatches. */
export async function prepareIndependentCoordinatorRollback(input: IndependentRollbackInput) {
  const expiresAt = performance.now() + 120_000;
  const assertWithinDeadline = () => {
    if (performance.now() >= expiresAt)
      throw new BootstrapRequestConflict(
        "Rollback preparation expired. Inspect retained reviews before retrying.",
      );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BootstrapRequestConflict(
            "Rollback preparation timed out. Inspect retained reviews before retrying.",
          ),
        ),
      120_000,
    );
  });
  try {
    return await Promise.race([prepareRollback(input, assertWithinDeadline), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function readRollbackReviewContext(input: IndependentRollbackInput) {
  const parent = await inspectNativeRecoveryReviewParent(input);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (
        await readBootstrapPreparedFile(
          parent.startup.setup.nativeAdmission,
          parent.writableMountRoots,
        )
      ).toString("utf8"),
    ),
  );
  const configuration = InstallationConfigSchema.parse(
    JSON.parse((await readProtectedDocument(admission.configurationFile)).toString("utf8")),
  );
  const host = configuration.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new BootstrapRequestConflict("Recovery has no configured Host identity");
  const binding = readBootstrapHostBinding(admission.configurationFile, host.serverId);
  if (
    binding.stateDirectory !== input.stateDirectory ||
    binding.binding.installationId !== parent.access.installationId
  )
    throw new BootstrapRequestConflict("Recovery review belongs to another installation");
  const installation = {
    installationId: binding.binding.installationId,
    stateDirectory: binding.stateDirectory,
    service: binding.binding.service,
  };
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  return { parent, admission, host, installation, journal };
}

async function prepareRollback(input: IndependentRollbackInput, assertWithinDeadline: () => void) {
  const { parent, admission, host, installation, journal } = await readRollbackReviewContext(input);
  const selected = selectIndependentCoordinatorRollback({ records: journal.read(), installation });
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: parent.writableMountRoots,
  });
  const pid = loadedCoordinatorPid(
    installation.service,
    await reader.readService(installation.service),
  );
  const observed = ProcessObservationSchema.parse(await reader.inspectProcess(pid));
  const plan = CoordinatorBootstrapPlanSchema.parse({
    version: 1,
    operation: "coordinator-bootstrap",
    installationId: installation.installationId,
    service: installation.service,
    expectedProcess: {
      pid: observed.pid,
      bootId: observed.bootId,
      startIdentity: observed.startIdentity,
      argumentsSha256: observed.argumentsSha256,
    },
    ...selected,
    hostRequestsAfter: null,
    automaticRecovery: "restore-previous",
  });
  await verifyLoadedBootstrapService({
    plan,
    hostUid: input.account.uid,
    configurationFile: selected.previous.configuration.path,
    reader,
  });
  await readBootstrapPreparedFile(
    { path: admission.launcherFile, sha256: selected.previous.launcher.sha256 },
    parent.writableMountRoots,
  );
  const requestId = randomUUID();
  const directory = path.join(input.stateDirectory, `coordinator-recovery-${requestId}`);
  await assertBootstrapPathsProtected([input.stateDirectory], parent.writableMountRoots);
  assertWithinDeadline();
  await mkdir(directory, { mode: 0o700 });
  const pin = async (file: string) => {
    const bytes = await readProtectedDocument(file);
    return { path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const put = async (name: string, value: unknown) => {
    assertWithinDeadline();
    const file = path.join(directory, name);
    await writeRecoverySnapshot(file, value);
    return pin(file);
  };
  const nativeAdmission = await put("admission.json", {
    ...admission,
    configurationFile: selected.previous.configuration.path,
  });
  const runtime = parent.startup.selected;
  const entrypoint = await pin(
    path.join(
      runtime.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
    ),
  );
  const setup = BootstrapRunnerSetupSchema.parse({
    admissionSetupFile: nativeAdmission.path,
    daemonId: host.serverId,
    node: runtime.node,
    entrypoint,
    ownerLauncher: await pin(path.join(runtime.directory, "scripts/run-coordinator-owner.py")),
    ownershipVerifier: await pin(
      path.join(runtime.directory, "scripts/verify-coordinator-owner.py"),
    ),
    runtimeDirectory: runtime.directory,
    runtimeSha256: runtime.artifactSha256,
  });
  const setupFile = await put("setup.json", setup);
  const service = `${installation.service}-recovery-${requestId}`;
  const label = service.split("/").slice(2).join("/");
  plan.bootRecovery = {
    requestId,
    service,
    launcher: { path: path.join(directory, "boot-recovery.plist"), sha256: "0".repeat(64) },
    installedLauncher: path.join(input.account.home, "Library/LaunchAgents", `${label}.plist`),
    setup: setupFile,
    ownerLauncher: setup.ownerLauncher,
    node: setup.node,
    entrypoint: setup.entrypoint,
  };
  // plutil converts inert configuration only. No service is registered here.
  const plist = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], {
    input: JSON.stringify(bootstrapRecoveryLauncher(plan)),
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  });
  if (plist.error || plist.signal || plist.status !== 0 || plist.stderr.length)
    throw new BootstrapRequestConflict("Rollback startup launcher could not be prepared");
  assertWithinDeadline();
  const launcher = await open(plan.bootRecovery.launcher.path, "wx", 0o600);
  try {
    await launcher.writeFile(plist.stdout);
    await launcher.sync();
  } finally {
    await launcher.close();
  }
  for (const name of [directory, input.stateDirectory]) {
    const parentDirectory = await open(name, "r");
    try {
      await parentDirectory.sync();
    } finally {
      await parentDirectory.close();
    }
  }
  plan.bootRecovery.launcher = await pin(plan.bootRecovery.launcher.path);
  const verifySetup = async () => {
    const current = await inspectNativeRecoveryReviewParent(input);
    if (
      !isDeepStrictEqual(current.process, parent.process) ||
      !isDeepStrictEqual(
        maintenanceExecutorStartupBinding(current.startup),
        maintenanceExecutorStartupBinding(parent.startup),
      )
    )
      throw new BootstrapRequestConflict("Recovery review parent selection changed");
    current.assertCurrent();
    return current.writableMountRoots;
  };
  await verifySetup();
  if (
    !isDeepStrictEqual(
      selected,
      selectIndependentCoordinatorRollback({ records: journal.read(), installation }),
    )
  )
    throw new BootstrapRequestConflict("Coordinator rollback history changed during preparation");
  const requests = await createBootstrapReviewService(nativeAdmission.path, host.serverId, {
    setup: { ...admission, configurationFile: selected.previous.configuration.path },
    async verify() {
      assertWithinDeadline();
    },
    async verifyPrepared(preparedPlan, preparedHost) {
      await verifyBootstrapPlan(preparedPlan, preparedHost);
      await verifySetup();
      assertWithinDeadline();
    },
  });
  const preparation = createDispatchingBootstrapReview({
    setup,
    setupFile: setupFile.path,
    requests,
    verifySetup,
  });
  const request = await preparation.prepare({
    id: requestId,
    reason:
      "Owner-requested compatible coordinator rollback. Replaces the coordinator and briefly interrupts the main interface; Host and Dev agents and retained histories are preserved. Basic health does not establish interface usability.",
    plan,
  });
  return request;
}
