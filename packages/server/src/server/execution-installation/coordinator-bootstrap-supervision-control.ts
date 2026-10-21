import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapRequestConflict,
  type CoordinatorBootstrapRequests,
} from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  BootstrapRunnerSetupSchema,
  waitForBootstrapWatchdog,
  nativeRunnerUid,
  assertSupervisionHelpers,
} from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  createBootstrapReviewService,
  readPrivateBootstrapConfiguration,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
  verifyBootstrapPlanInChild,
} from "./coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import { createMaintenanceChildCustody } from "./coordinator-bootstrap-maintenance-child-custody.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  createBootstrapOwnerReviewApp,
  type OwnerReviewInput,
} from "./coordinator-bootstrap-owner-review.js";

interface SupervisionReviewClientInput {
  requests: CoordinatorBootstrapRequests;
  binding: OwnerReviewInput["binding"];
  dispatch(request: CoordinatorBootstrapRequest): Promise<void>;
}

/** Authentication and CAS stay in the existing request service. Presentation
 * never supplies a setup, command or process identity to dispatch. */
export function supervisionReviewClient(
  input: SupervisionReviewClientInput,
): OwnerReviewInput["client"] {
  return {
    async listCoordinatorBootstrapRequests() {
      return input.requests.list().filter((request) => request.id === input.binding.id);
    },
    async decideCoordinatorBootstrap(decision, password) {
      if (decision.id !== input.binding.id || decision.planSha256 !== input.binding.planSha256)
        throw new BootstrapRequestConflict("Exact supervision review changed");
      const decided = await input.requests.decide(decision, password);
      if (decided.status === "approved") await input.dispatch(decided);
      return input.requests.list();
    },
  };
}

/** Fixed protected native role. It serves one recorded request and never scans
 * for other approvals, creates a queue or supplies an owner's password. */
export async function runBootstrapSupervisionControl(setupFile: string, requestId: string) {
  const uid = nativeRunnerUid();
  z.string().uuid().parse(requestId);
  const setup = BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const supervision = setup.supervision;
  assertSupervisionHelpers(setup);
  const moduleFile = fileURLToPath(new URL("./coordinator-bootstrap-runner.js", import.meta.url));
  if (
    !supervision ||
    supervision.requestId !== requestId ||
    setup.renewal ||
    setup.maintenance ||
    setup.entrypoint.path !== moduleFile ||
    realpathSync(process.execPath) !== setup.node.path
  )
    throw new BootstrapRequestConflict("Supervision control differs from its protected runtime");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const host = {
    ...admission,
    configurationFile: supervision.configuration.path,
    daemonId: setup.daemonId,
  };
  const anchor = readBootstrapHostBinding(host.configurationFile, host.daemonId);
  const roots = await inspectBootstrapWritableMountRoots(host);
  await assertBootstrapPathsProtected(
    [setupFile, setup.runtimeDirectory, setup.admissionSetupFile],
    roots,
  );
  const setupPin = { path: setupFile, sha256: hash(await readProtectedDocument(setupFile)) };
  const assertFiles = retainServiceFiles([
    setupFile,
    setup.admissionSetupFile,
    setup.entrypoint.path,
    fileURLToPath(import.meta.url),
    setup.ownerLauncher.path,
    setup.ownershipVerifier.path,
    host.helperPath,
    host.configurationFile,
    host.launcherFile,
  ]);
  for (const file of [setup.ownerLauncher, setup.ownershipVerifier, supervision.configuration])
    await readBootstrapPreparedFile(file, roots);
  const verifyPlan = async (plan: CoordinatorBootstrapRequest["plan"]) => {
    if (
      !plan.supervisionRecovery ||
      plan.candidate.directory !== setup.runtimeDirectory ||
      plan.candidate.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(plan.candidate.node, setup.node) ||
      plan.previous.configuration.sha256 !== supervision.configuration.sha256
    )
      throw new BootstrapRequestConflict("Supervision review runtime changed");
    assertFiles();
  };
  const requests = await createBootstrapReviewService(setup.admissionSetupFile, setup.daemonId, {
    setup: host,
    verify: verifyPlan,
    verifyPrepared: (plan, context) =>
      verifyBootstrapPlanInChild({ plan, host: context, node: setup.node.path }),
  });
  const initial = requests.list().find((request) => request.id === requestId);
  if (!initial?.plan.supervisionRecovery)
    throw new BootstrapRequestConflict("Exact supervision request is unavailable");
  await verifyPlan(initial.plan);
  if (initial.status === "pending" || awaitingSupervisionLaunch(initial))
    await verifyBootstrapPlanInChild({ plan: initial.plan, host, node: setup.node.path });
  assertFiles();
  const binding = { id: initial.id, revision: initial.revision, planSha256: initial.planSha256 };
  const reader = await createNativeBootstrapServiceReader({ ...host, writableMountRoots: roots });
  const journal = new FileBootstrapRequestJournal(anchor.stateDirectory);
  async function inspectControl(approved: CoordinatorBootstrapRequest) {
    const identity = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
    const args = [
      setup.node.path,
      setup.entrypoint.path,
      setupFile,
      "supervision-control",
      requestId,
    ];
    if (
      identity.argumentsSha256 !== hash(JSON.stringify(args)) ||
      identity.bootId !== approved.plan.expectedProcess.bootId
    )
      throw new BootstrapRequestConflict("Supervision control native role changed");
    const custody = await createMaintenanceChildCustody({
      expected: identity,
      helperPath: host.helperPath,
      helperSha256: host.helperSha256,
      writableMountRoots: roots,
    });
    return custody;
  }
  if (initial.status === "pending" || awaitingSupervisionLaunch(initial))
    await inspectControl(initial);
  async function dispatch(approved: CoordinatorBootstrapRequest): Promise<void> {
    const currentRoots = await inspectBootstrapWritableMountRoots(host);
    if (!isDeepStrictEqual(currentRoots, roots))
      throw new BootstrapRequestConflict("Supervision mount custody changed");
    await readBootstrapPreparedFile(setupPin, roots);
    const custody = await inspectControl(approved);
    const reserved = journal.reserveSupervisionLaunch({
      request: approved,
      setup: setupPin,
      parent: custody.process,
      assertCurrent() {
        assertFiles();
        custody.assertCurrent();
      },
    });
    // Once reserved, every uncertain result permits observation only. No fork
    // retry is made here, including after spawn errors or a lost response.
    const source = await readBootstrapPreparedFile(setup.ownerLauncher, roots);
    const current = requests.list().find((request) => request.id === reserved.id);
    if (!isDeepStrictEqual(current, reserved))
      throw new BootstrapRequestConflict("Supervision approval changed before fork");
    assertFiles();
    custody.assertCurrent();
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-B",
        "-c",
        source.toString("utf8"),
        path.join(anchor.stateDirectory, "coordinator-bootstrap-execution.lock"),
        setup.node.path,
        setup.entrypoint.path,
        setupFile,
        "executor",
        reserved.id,
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
    );
    child.on("error", () => {});
    try {
      await waitForBootstrapWatchdog(child, { role: "executor", timeoutMs: 25_000 });
    } finally {
      child.stdout?.destroy();
      child.unref();
    }
  }
  let origin = "";
  const app = createBootstrapOwnerReviewApp({
    binding,
    scope: "coordinator-supervision",
    origin: () => origin,
    client: supervisionReviewClient({ requests, binding, dispatch }),
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new BootstrapRequestConflict("Supervision review listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
  if (awaitingSupervisionLaunch(initial))
    void dispatch(initial).catch(() =>
      process.stderr.write("Supervision launch requires retained observation.\n"),
    );
  return { server, url: origin, binding };
}

function awaitingSupervisionLaunch(request: CoordinatorBootstrapRequest): boolean {
  return request.status === "approved" && !request.supervisionDispatch && !request.execution;
}

function hash(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
