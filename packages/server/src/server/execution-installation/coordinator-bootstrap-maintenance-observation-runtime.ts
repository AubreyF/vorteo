import path from "node:path";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { InstallationConfig } from "./config.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import {
  readProtectedDocument,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import {
  createMaintenanceServiceInspectionPorts,
  retainServiceFiles,
  type MaintenanceServiceInspectionPorts,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";

export interface MaintenanceObservationRuntime {
  installationRoot: string;
  stateDirectory: string;
  account: { uid: number; home: string };
  nativeAdmission: { path: string; sha256: string };
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>;
  writableMountRoots: readonly string[];
  ports: MaintenanceServiceInspectionPorts;
  assertCurrent(): void;
}

/** The main configuration and enrolled identity anchor inspection tools without
 * resolving a selected maintenance role. This grants no effect readiness. */
export async function inspectMaintenanceObservationRuntime(input: {
  configuration: InstallationConfig;
  configurationFile: string;
}): Promise<MaintenanceObservationRuntime> {
  const configuration = structuredClone(input.configuration);
  const owner = userInfo();
  const account = { uid: owner.uid, home: owner.homedir };
  const journal = new FileEnrollmentJournal(configuration.stateDir);
  const state = journal.readPolicySnapshot();
  if (
    state.status !== "enrolled" ||
    state.grant.manifest.installationId !== configuration.public.installationId
  )
    throw new BootstrapRequestConflict("Observation tools require matching retained enrollment");
  const grant = state.grant;
  const target = state.grant.manifest.targets.find((entry) => entry.target === "coordinator");
  if (!target)
    throw new BootstrapRequestConflict("Observation coordinator identity is unavailable");
  const identity = readEnrollmentNativeIdentity(configuration.stateDir, target.identitySha256);
  if (
    identity.environment !== "host" ||
    identity.target !== "coordinator" ||
    identity.custodyOwnerUid !== account.uid ||
    identity.installationId !== configuration.public.installationId ||
    identity.stateDirectory !== configuration.stateDir
  )
    throw new BootstrapRequestConflict(
      "Observation coordinator identity differs from configuration",
    );
  const anchor = path.join(identity.installationRoot, "coordinator-bootstrap-runner.json");
  const assertAnchor = retainServiceFiles([
    identity.installationRoot,
    configuration.stateDir,
    input.configurationFile,
    anchor,
  ]);
  const runner = z
    .object({ admissionSetupFile: z.string().startsWith("/") })
    .parse(readPrivateBootstrapConfiguration(anchor, account.uid));
  const assertAdmission = retainServiceFiles([runner.admissionSetupFile]);
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(runner.admissionSetupFile, account.uid),
  );
  const nativeAdmission = {
    path: runner.admissionSetupFile,
    sha256: createHash("sha256")
      .update(await readProtectedDocument(runner.admissionSetupFile))
      .digest("hex"),
  };
  if (
    admission.configurationFile !== input.configurationFile ||
    !isDeepStrictEqual(
      readPrivateBootstrapConfiguration(admission.configurationFile, account.uid),
      configuration,
    )
  )
    throw new BootstrapRequestConflict("Observation installation configuration differs");
  const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
  await assertBootstrapPathsProtected(
    [
      identity.installationRoot,
      configuration.stateDir,
      anchor,
      input.configurationFile,
      runner.admissionSetupFile,
    ],
    writableMountRoots,
  );
  const ports = await createMaintenanceServiceInspectionPorts({ ...admission, writableMountRoots });
  function assertCurrent() {
    assertAnchor();
    assertAdmission();
    const current = journal.readPolicySnapshot();
    if (
      current.status !== "enrolled" ||
      current.grant.id !== grant.id ||
      !isDeepStrictEqual(current.grant.manifest, grant.manifest) ||
      !isDeepStrictEqual(current.grant.approval, grant.approval) ||
      !isDeepStrictEqual(
        readEnrollmentNativeIdentity(configuration.stateDir, target!.identitySha256),
        identity,
      )
    )
      throw new BootstrapRequestConflict("Observation enrollment binding changed");
  }
  assertCurrent();
  return {
    installationRoot: identity.installationRoot,
    stateDirectory: configuration.stateDir,
    account,
    nativeAdmission,
    admission,
    writableMountRoots,
    ports,
    assertCurrent,
  };
}
