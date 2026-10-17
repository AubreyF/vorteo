import path from "node:path";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { readEnrollmentNativeIdentity } from "./maintenance/native-registration.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import {
  readProtectedDocument,
  readBootstrapPreparedFile,
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
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  inspectSelectedCoordinatorRuntime,
  createCoordinatorObservationCollection,
  type CoordinatorObservationLimits,
  terminalBootstrapRelease,
  verifyAdmissionDocker,
} from "./coordinator-bootstrap-renewal.js";

interface MaintenanceConfigurationInput {
  configuration: InstallationConfig;
  configurationFile?: string;
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>;
  writableMountRoots: readonly string[];
  ports?: Parameters<typeof inspectSelectedCoordinatorRuntime>[0]["ports"];
  collection?: CoordinatorObservationLimits;
}

function configurationIdentity(config: InstallationConfig) {
  return {
    public: config.public,
    stateDir: config.stateDir,
    ownerPasswordHash: config.ownerPasswordHash,
    hostAgentTokenHash: config.hostAgentTokenHash,
    containerAgentTokenHash: config.containerAgentTokenHash,
    host: {
      endpoint: config.host.endpoint,
      password: config.host.password,
      launchdService: config.host.launchdService,
    },
    container: { endpoint: config.container.endpoint, password: config.container.password },
  };
}

function readConfigurationCoordinator(configuration: InstallationConfig, uid: number) {
  const enrollment = new FileEnrollmentJournal(configuration.stateDir);
  const state = enrollment.readPolicySnapshot();
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Successor configuration requires retained enrollment");
  const grant = state.grant;
  const target = grant.manifest.targets.find((entry) => entry.target === "coordinator");
  if (!target) throw new BootstrapRequestConflict("Successor coordinator identity is unavailable");
  const identitySha256 = target.identitySha256;
  const identity = readEnrollmentNativeIdentity(configuration.stateDir, identitySha256);
  if (
    identity.environment !== "host" ||
    identity.target !== "coordinator" ||
    identity.custodyOwnerUid !== uid ||
    identity.installationId !== configuration.public.installationId ||
    identity.stateDirectory !== configuration.stateDir ||
    identity.serviceDomain !== `gui/${uid}`
  )
    throw new BootstrapRequestConflict("Successor configuration identity differs from enrollment");
  return { enrollment, grant, identitySha256, identity };
}

/** The immutable anchor supplies tools. Only independently verified terminal
 * coordinator history may select a different configuration for those tools. */
export async function inspectEffectiveMaintenanceConfiguration(
  input: MaintenanceConfigurationInput,
) {
  const collection = createCoordinatorObservationCollection(input.collection);
  let success = false;
  try {
    collection.remaining();
    const result = await collectEffectiveMaintenanceConfiguration(input, collection);
    collection.remaining();
    result.assertRetained();
    success = true;
    return result;
  } finally {
    collection.finish(success);
  }
}

async function collectEffectiveMaintenanceConfiguration(
  input: MaintenanceConfigurationInput,
  collection: ReturnType<typeof createCoordinatorObservationCollection>,
) {
  const configuration = structuredClone(input.configuration);
  const anchorAdmission = BootstrapAdmissionSetupSchema.parse(input.admission);
  const requestedFile = input.configurationFile;
  const roots = [...input.writableMountRoots];
  const uid = process.getuid!();
  const retainedFiles = [anchorAdmission.configurationFile];
  if (requestedFile) retainedFiles.push(requestedFile);
  const assertFiles = retainServiceFiles(retainedFiles);
  const anchorConfiguration = readPrivateBootstrapConfiguration(
    anchorAdmission.configurationFile,
    uid,
  );
  function assertInputs() {
    collection.assertRetained();
    assertFiles();
    if (
      !isDeepStrictEqual(input.configuration, configuration) ||
      !isDeepStrictEqual(input.admission, anchorAdmission) ||
      !isDeepStrictEqual(input.writableMountRoots, roots) ||
      input.configurationFile !== requestedFile
    )
      throw new BootstrapRequestConflict("Observation configuration inputs changed");
  }
  assertInputs();
  const anchoredAdmission = structuredClone(anchorAdmission);
  function assertAnchored() {
    assertInputs();
    if (!isDeepStrictEqual(anchoredAdmission, anchorAdmission))
      throw new BootstrapRequestConflict("Observation effective admission changed");
  }
  if (
    isDeepStrictEqual(anchorConfiguration, configuration) &&
    (requestedFile === undefined || requestedFile === anchorAdmission.configurationFile)
  )
    return {
      admission: anchoredAdmission,
      assertCurrent: assertAnchored,
      assertRetained: assertAnchored,
    };
  if (
    requestedFile === anchorAdmission.configurationFile ||
    !isDeepStrictEqual(
      configurationIdentity(InstallationConfigSchema.parse(anchorConfiguration)),
      configurationIdentity(configuration),
    )
  )
    throw new BootstrapRequestConflict(
      "Observation configuration changes the protected installation",
    );

  const { enrollment, grant, identitySha256, identity } = readConfigurationCoordinator(
    configuration,
    uid,
  );
  const history = new FileBootstrapRequestJournal(configuration.stateDir);
  const binding = {
    installationId: identity.installationId,
    stateDirectory: identity.stateDirectory,
    service: `${identity.serviceDomain}/${identity.serviceLabel}`,
  };
  const terminal = terminalBootstrapRelease(history.readStartupHistory(), binding);
  if (
    !terminal ||
    terminal.release.configuration.path === anchorAdmission.configurationFile ||
    (requestedFile !== undefined && requestedFile !== terminal.release.configuration.path)
  )
    throw new BootstrapRequestConflict("Observation configuration is not the approved successor");
  const assertSelectedFile = retainServiceFiles([terminal.release.configuration.path]);
  const selectedBytes = await collection.read(() =>
    readBootstrapPreparedFile(terminal.release.configuration, roots),
  );
  if (
    !isDeepStrictEqual(
      InstallationConfigSchema.parse(JSON.parse(selectedBytes.toString("utf8"))),
      configuration,
    )
  )
    throw new BootstrapRequestConflict(
      "Selected successor configuration differs from running configuration",
    );
  verifyAdmissionDocker(configuration, anchorAdmission);
  const ports =
    input.ports ??
    (await collection.read(() =>
      createMaintenanceServiceInspectionPorts({
        ...anchorAdmission,
        writableMountRoots: roots,
      }),
    ));
  const witness = await collection.read(() =>
    inspectSelectedCoordinatorRuntime({
      identity,
      executables: [terminal.release.node.path],
      writableMountRoots: roots,
      ports,
      collection: collection.limits,
    }),
  );
  if (!witness || !isDeepStrictEqual(witness.release, terminal.release))
    throw new BootstrapRequestConflict("Selected successor runtime differs from approved history");
  const retainedWitness = witness;
  const assertWitness = retainedWitness.assertCurrent;
  const assertWitnessRetained = retainedWitness.assertRetained;
  const witnessData = structuredClone({
    release: retainedWitness.release,
    process: retainedWitness.process,
  });
  const selectedAdmission = {
    ...anchorAdmission,
    configurationFile: terminal.release.configuration.path,
  };
  const effectiveAdmission = structuredClone(selectedAdmission);
  function assertRetained() {
    assertInputs();
    assertSelectedFile();
    assertWitnessRetained();
    const current = enrollment.readPolicySnapshot();
    if (
      retainedWitness.assertCurrent !== assertWitness ||
      retainedWitness.assertRetained !== assertWitnessRetained ||
      !isDeepStrictEqual(effectiveAdmission, selectedAdmission) ||
      !isDeepStrictEqual(
        { release: retainedWitness.release, process: retainedWitness.process },
        witnessData,
      ) ||
      !isDeepStrictEqual(
        terminalBootstrapRelease(history.readStartupHistory(), binding),
        terminal,
      ) ||
      current.status !== "enrolled" ||
      current.grant.id !== grant.id ||
      !isDeepStrictEqual(current.grant.manifest, grant.manifest) ||
      !isDeepStrictEqual(current.grant.approval, grant.approval) ||
      !isDeepStrictEqual(
        readEnrollmentNativeIdentity(configuration.stateDir, identitySha256),
        identity,
      )
    )
      throw new BootstrapRequestConflict("Successor configuration approval or custody changed");
    assertSelectedFile();
    assertInputs();
    collection.assertRetained();
  }
  function assertCurrent() {
    assertRetained();
    if (collection.sync(assertWitness, 4_000) !== undefined)
      throw new BootstrapRequestConflict("Successor runtime custody changed");
    assertRetained();
  }
  assertCurrent();
  return {
    admission: effectiveAdmission,
    assertCurrent,
    assertRetained,
  };
}

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
interface MaintenanceObservationInput {
  configuration: InstallationConfig;
  configurationFile: string;
  signal?: AbortSignal;
  collection?: CoordinatorObservationLimits;
}

export async function inspectMaintenanceObservationRuntime(
  input: MaintenanceObservationInput,
): Promise<MaintenanceObservationRuntime> {
  const signal =
    input.signal && input.collection?.signal
      ? AbortSignal.any([input.signal, input.collection.signal])
      : (input.signal ?? input.collection?.signal);
  const collection = createCoordinatorObservationCollection({ ...input.collection, signal });
  let success = false;
  try {
    collection.remaining();
    const result = await collectMaintenanceObservationRuntime(input, collection);
    collection.remaining();
    result.assertRetained();
    success = true;
    return result;
  } finally {
    collection.finish(success);
  }
}

async function collectMaintenanceObservationRuntime(
  input: MaintenanceObservationInput,
  collection: ReturnType<typeof createCoordinatorObservationCollection>,
) {
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
      .update(await collection.read(() => readProtectedDocument(runner.admissionSetupFile)))
      .digest("hex"),
  };
  const writableMountRoots = await collection.read(() =>
    inspectBootstrapWritableMountRoots(admission, { collection }),
  );
  await collection.read(() =>
    assertBootstrapPathsProtected(
      [
        identity.installationRoot,
        configuration.stateDir,
        anchor,
        input.configurationFile,
        runner.admissionSetupFile,
      ],
      writableMountRoots,
    ),
  );
  const ports = await collection.read(() =>
    createMaintenanceServiceInspectionPorts({ ...admission, writableMountRoots }),
  );
  const effective = await collection.read(() =>
    inspectEffectiveMaintenanceConfiguration({
      configuration,
      configurationFile: input.configurationFile,
      admission,
      writableMountRoots,
      ports,
      collection: collection.limits,
    }),
  );
  const assertEffective = effective.assertCurrent;
  const assertEffectiveRetained = effective.assertRetained;
  function assertRetained() {
    collection.assertRetained();
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
    assertAnchor();
    assertAdmission();
    if (
      effective.assertCurrent !== assertEffective ||
      effective.assertRetained !== assertEffectiveRetained
    )
      throw new BootstrapRequestConflict("Observation configuration custody callbacks changed");
    assertEffectiveRetained();
    collection.assertRetained();
  }
  function assertCurrent() {
    assertAnchor();
    assertAdmission();
    collection.sync(assertEffective, 4_000);
    assertRetained();
  }
  assertCurrent();
  return {
    assertRetained,
    installationRoot: identity.installationRoot,
    stateDirectory: configuration.stateDir,
    account,
    nativeAdmission,
    admission: effective.admission,
    writableMountRoots,
    ports,
    assertCurrent,
  };
}
