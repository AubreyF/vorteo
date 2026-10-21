import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import type { InstallationConfig } from "./config.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import {
  readPrivateBootstrapConfigurationBytes,
  retainPrivateBootstrapFiles,
} from "./coordinator-bootstrap-private-configuration.js";
import {
  prepareDevRegistrationC1Documents,
  verifyDevRegistrationC1Script,
  type PreparedDevRegistrationProvisioner,
} from "./maintenance/dev-registration-provisioner.js";

interface RegistrationConfigurationInput {
  plan: CoordinatorBootstrapPlan;
  currentFile: string;
  current: InstallationConfig;
  candidate: InstallationConfig;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ConfigurationScopeInput extends RegistrationConfigurationInput {
  preparation: PreparedDevRegistrationProvisioner["plan"];
  format: NonNullable<PreparedDevRegistrationProvisioner["plan"]["c1First"]>;
  reference: NonNullable<InstallationConfig["container"]["supervisorMaintenance"]>;
}
function assertConfigurationScope(input: ConfigurationScopeInput): void {
  const { current, plan, preparation, format, reference, currentFile } = input;
  const settings = current.containerSourceUpdates;
  if (
    !settings ||
    preparation.installationId !== plan.installationId ||
    preparation.installationId !== current.public.installationId ||
    settings.docker !== preparation.docker.path ||
    settings.containerId !== preparation.docker.containerId ||
    settings.user !== preparation.account.user ||
    settings.home !== preparation.account.stateDirectory ||
    settings.node !== preparation.node.path ||
    settings.releaseRoot !== preparation.releaseRoot ||
    settings.currentReleaseLink !== preparation.selectionPath ||
    format.configurationFiles.original !== currentFile ||
    format.configurationFiles.selected !== plan.candidate.configuration.path ||
    format.scripts.node !== reference.node ||
    format.scripts.replacement !== reference.script
  )
    throw new BootstrapRequestConflict("Dev registration configuration scope differs");
}

/** The approved C1 pin commits its exact script. Decoding that fixed script
 * supplies data to the trusted verifier, never code loaded from the candidate. */
export function inspectDevRegistrationConfiguration(input: RegistrationConfigurationInput) {
  const retainedInput = structuredClone(input);
  const { plan, current, candidate, currentFile } = retainedInput;
  if (
    plan.hostRequestsAfter !== null ||
    plan.sourceUpdateTooling !== undefined ||
    plan.factoryRuntimeAdoptionConfiguration !== undefined ||
    plan.nativeHelperConfiguration !== undefined ||
    plan.previewMonitorConfiguration !== undefined ||
    plan.supervisionRecovery !== undefined
  )
    throw new BootstrapRequestConflict("Initial Dev configuration cannot combine policy changes");
  const reference = candidate.container.supervisorMaintenance;
  if (
    !reference ||
    current.container.supervisorMaintenance ||
    current.container.persistentRegistration
  )
    throw new BootstrapRequestConflict(
      "Initial Dev configuration requires an unregistered predecessor",
    );
  if (reference.node !== plan.candidate.node.path)
    throw new BootstrapRequestConflict("Dev registration must use the approved coordinator Node");
  const uid = process.getuid!();
  const firstPaths = [
    currentFile,
    plan.previous.configuration.path,
    plan.candidate.configuration.path,
    reference.script,
  ];
  const firstCustody = retainPrivateBootstrapFiles(firstPaths, uid);
  const replacementBytes = readPrivateBootstrapConfigurationBytes(reference.script, uid);
  if (digest(replacementBytes) !== reference.sha256)
    throw new BootstrapRequestConflict("Dev registration replacement script pin differs");
  const provisioner = verifyDevRegistrationC1Script(replacementBytes.toString("utf8"));
  const preparation = provisioner.plan;
  const format = preparation.c1First;
  if (!format) throw new BootstrapRequestConflict("Initial Dev configuration format is absent");
  const replacementFile = reference.script;
  const rollbackFile = format.scripts.rollback;
  assertConfigurationScope({ ...retainedInput, preparation, format, reference });
  const paths = [
    ...firstPaths,
    ...Object.values(format.configurationFiles),
    format.preparedReceiptFile,
    format.scripts.rollback,
  ];
  const custody = retainPrivateBootstrapFiles(paths, uid);
  firstCustody();
  const originalBytes = readPrivateBootstrapConfigurationBytes(currentFile, uid);
  if (
    digest(originalBytes) !== plan.previous.configuration.sha256 ||
    !isDeepStrictEqual(JSON.parse(originalBytes.toString("utf8")), current)
  )
    throw new BootstrapRequestConflict("Dev registration predecessor configuration differs");
  const rollbackBytes = readPrivateBootstrapConfigurationBytes(format.scripts.rollback, uid);
  const documents = prepareDevRegistrationC1Documents({
    provisioner,
    original: {
      path: currentFile,
      bytes: originalBytes,
      sha256: digest(originalBytes),
      parsed: current,
    },
    replacementScript: {
      path: reference.script,
      bytes: replacementBytes,
      sha256: reference.sha256,
    },
    rollbackScript: {
      path: format.scripts.rollback,
      bytes: rollbackBytes,
      sha256: digest(rollbackBytes),
    },
    hostNode: reference.node,
  });
  if (
    !isDeepStrictEqual(documents.selected.parsed, candidate) ||
    documents.selected.sha256 !== plan.candidate.configuration.sha256
  )
    throw new BootstrapRequestConflict("Dev registration selected configuration differs");
  const returnedPaths = [...paths];
  const returnedDocker = structuredClone(preparation.docker);
  const returnedConfiguration = structuredClone(documents.selected.parsed);
  function assertCurrent(): void {
    firstCustody();
    custody();
    if (
      !isDeepStrictEqual(input, retainedInput) ||
      !isDeepStrictEqual(returnedPaths, paths) ||
      !isDeepStrictEqual(returnedDocker, preparation.docker) ||
      !isDeepStrictEqual(returnedConfiguration, documents.selected.parsed)
    )
      throw new BootstrapRequestConflict("Dev registration configuration input changed");
    if (
      !readPrivateBootstrapConfigurationBytes(plan.previous.configuration.path, uid).equals(
        originalBytes,
      )
    )
      throw new BootstrapRequestConflict("Dev registration approved predecessor bytes differ");
    for (const document of Object.values(documents))
      if (!readPrivateBootstrapConfigurationBytes(document.path, uid).equals(document.bytes))
        throw new BootstrapRequestConflict("Dev registration immutable document changed");
    if (
      !readPrivateBootstrapConfigurationBytes(replacementFile, uid).equals(replacementBytes) ||
      !readPrivateBootstrapConfigurationBytes(rollbackFile, uid).equals(rollbackBytes)
    )
      throw new BootstrapRequestConflict("Dev registration immutable script changed");
    firstCustody();
    custody();
  }
  assertCurrent();
  return {
    paths: returnedPaths,
    docker: returnedDocker,
    configuration: returnedConfiguration,
    assertCurrent,
  };
}
