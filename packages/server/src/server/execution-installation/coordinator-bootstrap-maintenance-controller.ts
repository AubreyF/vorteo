import { userInfo } from "node:os";
import { createIndependentBootstrapControlApp } from "./coordinator-bootstrap-preclaim-control.js";
import { verifyNativeMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import {
  observeEnrolledCoordinator,
  verifyEnrolledCoordinatorCandidate,
} from "./coordinator-bootstrap-maintenance-observation.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";
import { verifyMaintenanceProposalFiles } from "./coordinator-bootstrap-maintenance-admission.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { createProvisionedMaintenanceReview } from "./coordinator-bootstrap-maintenance-host.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";
import {
  provisionCoordinatorMaintenance,
  enrollAndProvisionCoordinatorMaintenance,
  recordCoordinatorMaintenanceEnrollment,
} from "./coordinator-bootstrap-maintenance-provisioning.js";
import {
  FileEnrollmentJournal,
  validateEnrollmentManifest,
  enrollmentManifestDigest,
} from "./maintenance/authorization.js";
import { InstallationEnrollmentManifestSchema } from "@getpaseo/protocol/installation-enrollment";
import { createMaintenanceReviewState } from "./coordinator-bootstrap-maintenance-state.js";
import {
  createMaintenanceControlApp,
  MaintenanceOwnerConfigurationSchema,
} from "./coordinator-bootstrap-maintenance-control.js";
import { writeRecoverySnapshot } from "./coordinator-bootstrap-launch.js";

/** Start only the pinned review controller. No opening path approves or resumes
 * a lifecycle decision, including when an earlier response was lost. */
interface MaintenanceControlInput {
  installationRoot: string;
  admissionSha256: string;
  enrollmentSha256?: string;
}
type SelectedStartup = Awaited<ReturnType<typeof verifyNativeMaintenanceLauncherStartup>>;

export async function runMaintenanceControl(input: MaintenanceControlInput) {
  return startMaintenanceControl(input);
}

/** The persistent role inherits only its reviewed setup, never invocation-supplied
 * admission or enrollment digests. Native startup verification precedes listening. */
export async function runPersistentMaintenanceController(setupFile: string) {
  const account = userInfo();
  const startupInput = { setupFile, account: { uid: account.uid, home: account.homedir } };
  const selected = await verifyNativeMaintenanceLauncherStartup(startupInput);
  if (selected.setup.target !== "maintenance-controller" || !selected.setup.control)
    throw new BootstrapRequestConflict("Selected controller lacks its pinned enrollment review");
  return startMaintenanceControl(
    {
      installationRoot: selected.setup.installationRoot,
      ...selected.setup.control,
    },
    { selected, inspect: () => verifyNativeMaintenanceLauncherStartup(startupInput) },
  );
}

async function verifyControlRuntime(
  context: Awaited<ReturnType<typeof verifyMaintenanceProposalFiles>>,
  identity: z.infer<typeof ProcessObservationSchema>,
  args: string[],
  persistent?: { selected: SelectedStartup },
) {
  const expectedModule = path.join(
    persistent?.selected.selected.directory ?? context.receipt.runtime.directory,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-controller.js",
  );
  if (
    persistent &&
    (persistent.selected.plan.identity.installationId !== context.receipt.installationId ||
      persistent.selected.setup.enrollmentStateDirectory !== context.plan.state.directory ||
      !isDeepStrictEqual(identity, persistent.selected.process))
  )
    throw new BootstrapRequestConflict(
      "Persistent controller differs from its retained installation",
    );
  if (
    fileURLToPath(import.meta.url) !== expectedModule ||
    (await realpath(process.execPath)) !==
      (persistent?.selected.selected.node.path ?? context.runner.node.path) ||
    (!persistent && !isDeepStrictEqual(process.argv, args)) ||
    identity.uid !== process.getuid?.() ||
    identity.executable !== (persistent?.selected.selected.node.path ?? context.runner.node.path) ||
    (!persistent &&
      identity.argumentsSha256 !== createHash("sha256").update(JSON.stringify(args)).digest("hex"))
  )
    throw new BootstrapRequestConflict(
      "Maintenance control identity differs from its pinned runtime",
    );
}

/** Retained owner review must describe this enrollment, including after grant
 * revocation. This validates observation context and grants no new dispatch. */
export function verifyPersistentMaintenanceReview(
  stateDirectory: string,
  review: Awaited<ReturnType<typeof readMaintenanceEnrollmentReview>> | undefined,
) {
  const state = new FileEnrollmentJournal(stateDirectory).read();
  if (
    !review ||
    state.status !== "enrolled" ||
    enrollmentManifestDigest(state.grant.manifest) !== enrollmentManifestDigest(review.manifest)
  )
    throw new BootstrapRequestConflict(
      "Persistent controller review differs from retained enrollment",
    );
}

/** Read the original approved review from the durable journal. Pinning its
 * digest in setup would cycle through manifest, plan, setup and review hashes. */
export function readPersistentMaintenanceReview(
  stateDirectory: string,
  admissionSha256: string,
  installationId: string,
) {
  const state = new FileEnrollmentJournal(stateDirectory).read();
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Persistent controller requires retained enrollment");
  const { manifest, approval } = state.grant;
  if (
    manifest.installationId !== installationId ||
    manifest.provisioning?.admissionSha256 !== admissionSha256 ||
    approval.reviewRevision !== manifest.revision ||
    approval.manifestSha256 !== enrollmentManifestDigest(manifest)
  )
    throw new BootstrapRequestConflict("Persistent controller enrollment provenance changed");
  return { id: approval.requestId, revision: approval.reviewRevision, manifest };
}

async function startMaintenanceControl(
  input: MaintenanceControlInput,
  persistent?: { selected: SelectedStartup; inspect(): Promise<SelectedStartup> },
) {
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.admissionSha256);
  const directory = path.join(input.installationRoot, "maintenance-admissions", digest);
  const read = async (name: string) =>
    JSON.parse((await readProtectedDocument(path.join(directory, name))).toString("utf8"));
  const anchor = BootstrapRunnerSetupSchema.parse(
    JSON.parse(
      (
        await readProtectedDocument(
          path.join(input.installationRoot, "coordinator-bootstrap-runner.json"),
        )
      ).toString("utf8"),
    ),
  );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readProtectedDocument(anchor.admissionSetupFile)).toString("utf8")),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  const prepared = {
    ...input,
    plan: await read("proposal-plan.json"),
    hostSetup: await read("proposal-host.json"),
    runnerSetup: await read("proposal-runner.json"),
  };
  const context = await verifyMaintenanceProposalFiles({
    ...prepared,
    receiptFile: { path: path.join(directory, "proposal.json"), sha256: digest },
    writableMountRoots: roots,
  });
  let enrollment: Awaited<ReturnType<typeof readMaintenanceEnrollmentReview>> | undefined;
  if (persistent)
    enrollment = readPersistentMaintenanceReview(
      persistent.selected.setup.enrollmentStateDirectory,
      digest,
      context.receipt.installationId,
    );
  else if (input.enrollmentSha256)
    enrollment = await readMaintenanceEnrollmentReview(
      directory,
      input.enrollmentSha256,
      digest,
      context.receipt.installationId,
    );
  if (persistent)
    verifyPersistentMaintenanceReview(
      persistent.selected.setup.enrollmentStateDirectory,
      enrollment,
    );
  const args = [
    context.runner.node.path,
    context.runner.entrypoint.path,
    input.installationRoot,
    "maintenance-control",
    digest,
    ...(input.enrollmentSha256 ? [input.enrollmentSha256] : []),
  ];
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const identity = ProcessObservationSchema.parse(await reader.inspectProcess(process.pid));
  await verifyControlRuntime(context, identity, args, persistent);
  const journal = new FileBootstrapRequestJournal(context.plan.state.directory);
  const state = createMaintenanceReviewState({
    preparation: {
      id: context.receipt.requestId,
      plan: context.plan,
      reason:
        "Install the reviewed compatible coordinator while preserving installation state and running Host and Dev work.",
    },
    readRequests: () => journal.read(),
    authenticateAndProvision: async (ownerPassword) => {
      await provisionCoordinatorMaintenance({ ...prepared, ownerPassword });
    },
    createService: () => createProvisionedMaintenanceReview(input),
  });
  const admitted = await access(path.join(directory, "admission.json")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (admitted && !enrollment) {
    await readBootstrapPreparedFile(
      { path: path.join(directory, "admission.json"), sha256: digest },
      roots,
    );
    // Read-only status remains usable if current-runtime validation no longer
    // admits mutations. Failure never causes a second preparation or dispatch.
    await state.reopen().catch(() => {
      process.stderr.write(
        "Maintenance review reopening unavailable; retained status preserved.\n",
      );
    });
  }
  const app = createMaintenanceControlApp({
    ...(persistent
      ? {
          runtimeStatus: async () => {
            const current = await persistent.inspect();
            // Queue bookkeeping may complete after startup. Compare native selection
            // and runtime custody, while the startup reader verifies current history.
            if (
              ["planSha256", "selection", "selected", "setup", "process"].some(
                (key) =>
                  !isDeepStrictEqual(
                    current[key as keyof SelectedStartup],
                    persistent.selected[key as keyof SelectedStartup],
                  ),
              )
            )
              throw new BootstrapRequestConflict("Persistent controller selection changed");
            return {
              installationId: current.plan.identity.installationId,
              target: current.setup.target,
              identitySha256: current.identitySha256,
              sourceCommit: current.selected.sourceCommit,
              artifactSha256: current.selected.artifactSha256,
              process: current.process,
              ready: true,
            };
          },
        }
      : {}),
    installationId: context.receipt.installationId,
    ...(enrollment
      ? {
          enrollment: {
            decision: {
              id: enrollment.id,
              revision: enrollment.revision,
              manifestSha256: enrollmentManifestDigest(enrollment.manifest),
            },
            review: enrollment,
            observe: async () => {
              const setup = {
                ...context.runner,
                maintenance: { installationRoot: input.installationRoot, admissionSha256: digest },
              };
              await observeEnrolledCoordinator({
                directory: context.plan.state.directory,
                requestId: context.receipt.requestId,
                verify: (request) => verifyEnrolledCoordinatorCandidate(setup, request),
              });
            },
            ...(!persistent
              ? {
                  saveConsent: async (decision) => {
                    const current = await readMaintenanceEnrollmentReview(
                      directory,
                      input.enrollmentSha256!,
                      digest,
                      context.receipt.installationId,
                    );
                    if (!isDeepStrictEqual(current, enrollment))
                      throw new BootstrapRequestConflict("Enrollment review changed");
                    await recordCoordinatorMaintenanceEnrollment({
                      ...prepared,
                      review: enrollment,
                      decision,
                      ownerPassword: decision.ownerPassword,
                    });
                  },
                }
              : {}),
            enroll: async (decision) => {
              if (persistent)
                throw new BootstrapRequestConflict("Installation enrollment is already retained");
              const current = await readMaintenanceEnrollmentReview(
                directory,
                input.enrollmentSha256!,
                digest,
                context.receipt.installationId,
              );
              if (!isDeepStrictEqual(current, enrollment))
                throw new BootstrapRequestConflict("Enrollment review changed");
              await enrollAndProvisionCoordinatorMaintenance({
                ...prepared,
                review: enrollment,
                decision,
                ownerPassword: decision.ownerPassword,
              });
              const executor = await createProvisionedMaintenanceReview(input);
              if (!executor.activateEnrollment)
                throw new BootstrapRequestConflict("Enrolled native execution unavailable");
              await executor.activateEnrollment();
            },
          },
        }
      : {}),
    service: state.service,
    status: () => ({
      version: 1,
      installationId: context.receipt.installationId,
      available: state.phase() === "ready",
      phase: state.phase(),
      requests: state.list().length,
      provisioning: {
        admissionSha256: digest,
        requestId: context.receipt.requestId,
        sourceCommit: context.receipt.runtime.sourceCommit,
        artifactSha256: context.receipt.runtime.artifactSha256,
      },
    }),
    provision: (request) => state.provision(request.ownerPassword),
    readOwnerConfiguration: async () => {
      const launcher = await readProtectedDocument(admission.launcherFile);
      const configuration = selectMaintenanceOwnerConfiguration(context.plan, launcher);
      const bytes = await readBootstrapPreparedFile(configuration, roots);
      const config = MaintenanceOwnerConfigurationSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (
        config.stateDir !== context.plan.state.directory ||
        config.public.installationId !== context.receipt.installationId
      )
        throw new BootstrapRequestConflict("Maintenance owner state changed");
      return config;
    },
  });
  let origin = "";
  if (!persistent && !enrollment) {
    const review = () => {
      const retained = state.list().find((request) => request.id === context.receipt.requestId);
      if (!retained) throw new BootstrapRequestConflict("Exact maintenance review is unavailable");
      return {
        binding: { id: retained.id, revision: retained.revision, planSha256: retained.planSha256 },
        client: {
          listCoordinatorBootstrapRequests: async () => state.service().list(),
          decideCoordinatorBootstrap: async (
            decision: Parameters<BootstrapReviewService["decide"]>[0],
            password: string,
          ) => {
            await state.service().decide(decision, password);
            return [];
          },
        },
      };
    };
    app.use(
      createIndependentBootstrapControlApp({
        scope: "coordinator-migration",
        origin: () => origin,
        admissionSha256: digest,
        proposal: { receipt: context.receipt, plan: context.plan },
        ...(state.list().length ? { admitted: review() } : {}),
        provision: async (password) => {
          await state.provision(password);
          return review();
        },
      }),
    );
  }
  const server = createServer(app);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new BootstrapRequestConflict("Maintenance listener unavailable");
    origin = "http://127.0.0.1:" + address.port;
    const descriptor = {
      version: 1,
      ...(input.enrollmentSha256 ? { enrollmentSha256: input.enrollmentSha256 } : {}),
      admissionSha256: digest,
      requestId: context.receipt.requestId,
      process: identity,
      address: "127.0.0.1",
      port: address.port,
    };
    await writeRecoverySnapshot(
      path.join(input.installationRoot, `maintenance-control-${process.pid}.json`),
      descriptor,
    );
    return { server, descriptor };
  } catch (error) {
    server.close();
    throw error;
  }
}

/** A selected launcher may occur in both previous and recovery slots, but all
 * matching slots must name the same exact owner configuration. */
export function selectMaintenanceOwnerConfiguration(
  plan: CoordinatorBootstrapPlan,
  launcher: Buffer,
) {
  const hash = createHash("sha256").update(launcher).digest("hex");
  const releases = [plan.previous, plan.candidate, plan.compatibleRecovery].filter(
    (release) => release !== undefined,
  );
  const matches = releases.filter((release) => release.launcher.sha256 === hash);
  const selected = matches[0]?.configuration;
  if (!selected || matches.some((release) => !isDeepStrictEqual(release.configuration, selected)))
    throw new BootstrapRequestConflict("Selected maintenance owner configuration is ambiguous");
  return selected;
}

/** The manifest comes only from the protected review whose digest is pinned in
 * native startup arguments. HTTP input cannot choose or replace this document. */
export async function readMaintenanceEnrollmentReview(
  directory: string,
  sha256: string,
  admissionSha256: string,
  installationId: string,
) {
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(sha256);
  const bytes = await readBootstrapPreparedFile(
    { path: path.join(directory, "enrollment-review.json"), sha256: digest },
    [],
  );
  const review = z
    .strictObject({
      id: z.string().uuid(),
      revision: z.string().uuid(),
      manifest: InstallationEnrollmentManifestSchema,
    })
    .parse(JSON.parse(bytes.toString("utf8")));
  const manifest = validateEnrollmentManifest(review.manifest);
  if (
    review.revision !== manifest.revision ||
    manifest.installationId !== installationId ||
    manifest.provisioning?.admissionSha256 !== admissionSha256
  )
    throw new BootstrapRequestConflict("Enrollment review does not match maintenance admission");
  return { ...review, manifest };
}
