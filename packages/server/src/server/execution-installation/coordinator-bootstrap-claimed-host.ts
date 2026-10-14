import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BootstrapClaimedRecoveryPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import {
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
  readBootstrapHostBinding,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { deriveBootstrapRenewal } from "./coordinator-bootstrap-renewal.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import { validateClaimedRecoveryPlan } from "./coordinator-bootstrap-claimed-recovery.js";
import {
  verifyClaimedPreparationIsolation,
  observeClaimedExecutor,
  verifyClaimedExecutionLock,
  verifyClaimedSelectedService,
  verifySupportedClaimedRunner,
} from "./coordinator-bootstrap-claimed-verification.js";

type RenewalInput = Parameters<typeof deriveBootstrapRenewal>[0];
export interface ClaimedHostInput {
  plan: BootstrapClaimedRecoveryPlan;
  setupFile: string;
  daemonId: string;
  /** Supplied only by disposable/native acceptance, never by a public route. */
  ports?: NonNullable<RenewalInput["ports"]> & {
    moduleFile: string;
    hostProcessId?: number;
    reader: NativeBootstrapServiceReader;
  };
}

/** Reconstruct authority from the installed anchor and terminal history, not
 * from the target runner's claimed renewal document alone. This is read-only. */
export async function deriveClaimedHostRuntime(
  input: ClaimedHostInput,
): Promise<z.infer<typeof BootstrapRunnerSetupSchema>> {
  const plan = validateClaimedRecoveryPlan(input.plan);
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Claimed recovery requires native Host admission");
  const setup = BootstrapRunnerSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setupFile, uid),
  );
  if (setup.daemonId !== input.daemonId || setup.renewal)
    throw new BootstrapRequestConflict("Claimed recovery requires the installed bootstrap anchor");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const binding = readBootstrapHostBinding(admission.configurationFile, input.daemonId);
  if (
    binding.stateDirectory !== plan.original.plan.state.directory ||
    binding.binding.installationId !== plan.original.plan.installationId ||
    binding.binding.service !== plan.original.plan.service
  )
    throw new BootstrapRequestConflict("Claimed recovery belongs to another installation");
  const original = new FileBootstrapRequestJournal(binding.stateDirectory);
  original.verifyUnpromotedClaim(plan.original);
  const derived = await deriveBootstrapRenewal({
    setupFile: input.setupFile,
    setup,
    moduleFile: input.ports?.moduleFile ?? fileURLToPath(import.meta.url),
    hostPid: input.ports?.hostProcessId ?? process.pid,
    ports: input.ports,
    dispatchedRequest: { id: plan.original.id, planSha256: plan.original.planSha256 },
  });
  if (
    !derived?.renewal ||
    !isDeepStrictEqual(derived.renewal.configuration, plan.selectedConfiguration) ||
    admission.launcherFile !== plan.selectedLauncher.path
  )
    throw new BootstrapRequestConflict("Claimed recovery selected authority changed");
  original.verifyUnpromotedClaim(plan.original);
  if (
    !isDeepStrictEqual(setup, readPrivateBootstrapConfiguration(input.setupFile, uid)) ||
    !isDeepStrictEqual(
      admission,
      BootstrapAdmissionSetupSchema.parse(
        readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
      ),
    )
  )
    throw new BootstrapRequestConflict("Claimed recovery anchor changed during reconstruction");
  return derived;
}

/** The Host wires this verifier into preparation, approval and claim. It does
 * not install code, dispatch recovery or make a read-only check into a fence. */
export async function verifyManagedClaimedPreparation(input: ClaimedHostInput): Promise<void> {
  const runtime = await deriveClaimedHostRuntime(input);
  const renewal = runtime.renewal!;
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse((await readBootstrapPreparedFile(renewal.originalAdmission, [])).toString("utf8")),
  );
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  await verifySupportedClaimedRunner({
    plan: input.plan,
    daemonId: input.daemonId,
    admissionSetupFile: runtime.admissionSetupFile,
    anchor: renewal,
    writableMountRoots: roots,
  });
  const inspector = { path: admission.helperPath, sha256: admission.helperSha256 };
  const reader =
    input.ports?.reader ??
    (await createNativeBootstrapServiceReader({
      helperPath: inspector.path,
      helperSha256: inspector.sha256,
      writableMountRoots: roots,
    }));
  const context = { plan: input.plan, reader, inspector, writableMountRoots: roots };
  await verifyClaimedExecutionLock(context);
  if ((await observeClaimedExecutor(context)) === "running")
    await verifyClaimedPreparationIsolation({ ...context, helper: input.plan.ownerLauncher });
  await verifyClaimedSelectedService({
    ...context,
    launcherFile: admission.launcherFile,
    configurationFile: renewal.configuration.path,
  });
  const finalRoots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  if (!isDeepStrictEqual(roots, finalRoots))
    throw new BootstrapRequestConflict("Claimed recovery writable mounts changed");
  new FileBootstrapRequestJournal(input.plan.original.plan.state.directory).verifyUnpromotedClaim(
    input.plan.original,
  );
}
