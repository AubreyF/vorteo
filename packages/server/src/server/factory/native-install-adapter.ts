import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";
import {
  FactoryInstallInputSchema,
  FactoryInstallResultSchema,
  FactorySetupSchema,
  type FactoryInstallResult,
  type FactorySetup,
  FactoryControlStateSchema,
  FactoryControlInputSchema,
  FactoryControlResultSchema,
  type FactoryControlState,
  type FactoryControlInput,
  type FactoryControlResult,
} from "@getpaseo/server/factory-operations";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { GovernedScheduleRuntime } from "../schedule/governed-runtime.js";
import type {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { attachFactoryControllerObservation } from "./attach-controller-observation.js";
import { captureFactoryCoordinatorAuthority } from "./coordinator-authority.js";
import { createFactoryCoordinatorBinder } from "./create-coordinator-binder.js";
import type { FactoryControllerObservationSource } from "./controller-observation-provider.js";
import { FactoryInstallCheckpointError } from "./install-checkpoint.js";
import {
  NativeFactoryObservationService,
  type NativeFactoryObservationProvider,
} from "./observation-service.js";

interface InstallDependencies {
  serverId: string;
  projects: FileBackedProjectRegistry;
  workspaces: FileBackedWorkspaceRegistry;
  agents: Pick<AgentStorage, "get" | "getLoadedRecord">;
  readProfiles(): AgentProfile[];
  provider: string;
  profileId: string;
  runtime: GovernedScheduleRuntime;
  /** Already account-contract-wrapped source from the retained startup owner. */
  source: FactoryControllerObservationSource;
  /** Startup-owned custody, singleton and lifecycle permit; never an RPC argument. */
  assertReconciled(): void;
  controls?: {
    read(): unknown | Promise<unknown>;
    execute(request: FactoryControlInput): Promise<unknown>;
  };
}

const reconciliationHolds = new WeakSet<GovernedScheduleRuntime>();

export type NativeFactoryInstallAdapter = ReturnType<typeof createNativeFactoryInstallAdapter>;
interface AdapterOrigin {
  runtime: GovernedScheduleRuntime;
  serverId: string;
  projectId: string;
  readSetup: NativeFactoryInstallAdapter["readSetup"];
  install: NativeFactoryInstallAdapter["install"];
  restore: NativeFactoryInstallAdapter["restore"];
  readControls: NativeFactoryInstallAdapter["readControls"];
  control: NativeFactoryInstallAdapter["control"];
}
const adapterOrigins = new WeakMap<object, AdapterOrigin>();

/** Private native provenance. A shape-compatible object is not a startup-owned adapter. */
export function nativeFactoryInstallAdapterOrigin(
  adapter: NativeFactoryInstallAdapter,
): Readonly<AdapterOrigin> | null {
  const origin = adapterOrigins.get(adapter);
  if (
    !origin ||
    adapter.readSetup !== origin.readSetup ||
    adapter.install !== origin.install ||
    adapter.restore !== origin.restore ||
    adapter.readControls !== origin.readControls ||
    adapter.control !== origin.control
  )
    return null;
  return { ...origin };
}

/** A failed public dispatch must not permit a fresh adapter to bypass reconciliation. */
export function holdNativeFactoryInstallAdapter(adapter: NativeFactoryInstallAdapter): void {
  const origin = adapterOrigins.get(adapter);
  if (origin) reconciliationHolds.add(origin.runtime);
}

/** Does not start a controller or register RPCs. Startup must supply a reconciled retained owner. */
export function createNativeFactoryInstallAdapter(deps: InstallDependencies) {
  const captured = { ...deps };
  const projectMethods = {
    get: captured.projects.get,
    loaded: captured.projects.getLoadedRecord,
    begin: captured.projects.beginFactoryInstallation,
    complete: captured.projects.completeFactoryInstallation,
  };
  const workspaceMethods = {
    get: captured.workspaces.get,
    loaded: captured.workspaces.getLoadedRecord,
    bind: captured.workspaces.bindFactoryMember,
  };
  const agentMethods = { get: captured.agents.get, loaded: captured.agents.getLoadedRecord };
  const source = captured.source;
  const sourceMethods = { ...source };
  const assertOwner = source.authority.assertCurrent;
  const assertAuthentication = source.authentication.assertCurrent;
  const authenticationGeneration = source.authentication.authenticationGeneration;
  const binding = structuredClone(source.binding);
  const ownerIdentity = structuredClone(source.authority.identity);
  const policy = structuredClone(source.policy);
  const bind = createFactoryCoordinatorBinder(captured);
  let expectedStop = captured.runtime.stop;
  let expectedObservation = captured.runtime.factoryObservation;
  let uncertain = false;
  let confirmed: NativeFactoryObservationProvider | null = null;
  const controlMethods = captured.controls && { ...captured.controls };

  function assertNativeMethods(): void {
    if (
      captured.projects.get !== projectMethods.get ||
      captured.projects.getLoadedRecord !== projectMethods.loaded ||
      captured.projects.beginFactoryInstallation !== projectMethods.begin ||
      captured.projects.completeFactoryInstallation !== projectMethods.complete ||
      captured.workspaces.get !== workspaceMethods.get ||
      captured.workspaces.getLoadedRecord !== workspaceMethods.loaded ||
      captured.workspaces.bindFactoryMember !== workspaceMethods.bind ||
      captured.agents.get !== agentMethods.get ||
      captured.agents.getLoadedRecord !== agentMethods.loaded
    )
      throw new Error("Factory native installation methods changed.");
  }

  function assertCurrent(): void {
    assertNativeMethods();
    if (
      captured.controls &&
      (captured.controls.read !== controlMethods?.read ||
        captured.controls.execute !== controlMethods?.execute)
    )
      throw new Error("Factory owner control methods changed.");
    captured.assertReconciled();
    assertOwner.call(source.authority);
    assertAuthentication.call(source.authentication);
    const replaced = (Object.keys(captured) as Array<keyof InstallDependencies>).some(
      (key) => deps[key] !== captured[key],
    );
    if (
      replaced ||
      captured.runtime.stop !== expectedStop ||
      captured.runtime.factoryObservation !== expectedObservation ||
      (Object.keys(sourceMethods) as Array<keyof FactoryControllerObservationSource>).some(
        (key) => source[key] !== sourceMethods[key],
      ) ||
      source.authority.assertCurrent !== assertOwner ||
      source.authentication.assertCurrent !== assertAuthentication ||
      source.authentication.authenticationGeneration !== authenticationGeneration ||
      binding.serverId !== captured.serverId ||
      !isDeepStrictEqual(source.binding, binding) ||
      !isDeepStrictEqual(source.policy, policy) ||
      !isDeepStrictEqual(source.authority.identity, ownerIdentity)
    )
      throw new Error("Factory installation retained source or authority changed.");
  }

  function observedAt(): string {
    return new Date().toISOString();
  }

  async function prepare() {
    assertCurrent();
    await source.readLifecycle();
    assertCurrent();
    const project = await captured.projects.get(binding.projectId);
    assertCurrent();
    if (
      !project ||
      project.factoryInstallation ||
      project.archivedAt ||
      uncertain ||
      reconciliationHolds.has(captured.runtime)
    )
      return null;
    const profiles = captured.readProfiles().filter((entry) => entry.id === captured.profileId);
    if (profiles.length !== 1) throw new Error("Factory configured profile is unavailable.");
    const profile = structuredClone(profiles[0]);
    const grant = await captureFactoryCoordinatorAuthority({
      owner: { identity: source.authority.identity, assertCurrent },
      binding,
      operationId: "factory-install-precondition",
      ...captured,
      profile,
    });
    assertCurrent();
    if (!isDeepStrictEqual(captured.projects.getLoadedRecord(binding.projectId), project))
      throw new Error("Factory installation native project changed.");
    const revision = createHash("sha256")
      .update(JSON.stringify({ native: grant.revision, policy, authenticationGeneration }))
      .digest("hex");
    return { project, profile, revision };
  }

  async function readSetup(projectId: string): Promise<FactorySetup> {
    if (projectId !== binding.projectId)
      throw new Error("Factory installer belongs to another project.");
    const prepared = await prepare();
    const retained = await captured.projects.get(projectId);
    assertCurrent();
    if (!prepared) {
      const checkpoint = retained?.factoryInstallation;
      const matches =
        checkpoint?.serverId === captured.serverId && checkpoint.projectId === projectId;
      const installationId = matches ? checkpoint.installationId : null;
      if (
        matches &&
        checkpoint.stage === "attached" &&
        confirmed &&
        !uncertain &&
        !reconciliationHolds.has(captured.runtime)
      ) {
        const observation = new NativeFactoryObservationService(confirmed, captured);
        await observation.invoke("factory.snapshot", { projectId });
        const profiles = captured.readProfiles().filter((entry) => entry.id === captured.profileId);
        if (profiles.length !== 1) throw new Error("Factory configured profile is unavailable.");
        await captureFactoryCoordinatorAuthority({
          ...captured,
          owner: { identity: source.authority.identity, assertCurrent },
          binding,
          operationId: checkpoint.operationId,
          profile: structuredClone(profiles[0]),
        });
        assertCurrent();
        if (!isDeepStrictEqual(captured.projects.getLoadedRecord(projectId), retained))
          throw new Error("Factory installation changed during setup observation.");
        return FactorySetupSchema.parse({
          schemaVersion: 1,
          serverId: captured.serverId,
          projectId,
          installationId,
          revision: checkpoint.revision,
          observedAt: observedAt(),
          state: "installed",
          reason: null,
          operations: { install: false, pause: false, resume: false, stop: false, disable: false },
        });
      }

      return FactorySetupSchema.parse({
        schemaVersion: 1,
        serverId: captured.serverId,
        projectId,
        installationId,
        revision: null,
        observedAt: observedAt(),
        state: "held",
        reason:
          "Factory installation requires retained owner and native checkpoint reconciliation.",
        operations: { install: false, pause: false, resume: false, stop: false, disable: false },
      });
    }
    if (!isDeepStrictEqual(retained, prepared.project))
      throw new Error("Factory installation native project changed.");
    return FactorySetupSchema.parse({
      schemaVersion: 1,
      serverId: captured.serverId,
      projectId,
      installationId: null,
      revision: prepared.revision,
      observedAt: observedAt(),
      state: "ready",
      reason: null,
      operations: { install: true, pause: false, resume: false, stop: false, disable: false },
    });
  }

  async function install(value: unknown): Promise<FactoryInstallResult> {
    const request = FactoryInstallInputSchema.parse(value);
    const identity = {
      schemaVersion: 1 as const,
      serverId: captured.serverId,
      projectId: request.projectId,
      operationId: request.operationId,
    };
    function refused(code: "identity_mismatch" | "held" | "precondition_changed", reason: string) {
      return FactoryInstallResultSchema.parse({ ...identity, outcome: "refused", code, reason });
    }
    if (request.expectedServerId !== captured.serverId || request.projectId !== binding.projectId)
      return refused(
        "identity_mismatch",
        "Factory installer belongs to another daemon or project.",
      );
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare();
    } catch {
      return refused("held", "Factory retained authority or native setup requires reconciliation.");
    }
    if (!prepared) return refused("held", "Retained Factory installation requires reconciliation.");
    if (request.expectedInstallationId !== null || request.expectedRevision !== prepared.revision)
      return refused("precondition_changed", "Factory setup changed before installation.");
    const checkpoint = {
      serverId: captured.serverId,
      projectId: binding.projectId,
      installationId: binding.installationId,
      operationId: request.operationId,
      revision: prepared.revision,
      observedAt: observedAt(),
      stage: "binding" as const,
      coordinators: binding.coordinators,
    };
    const expectedProfile = prepared.profile;
    function assertAttempt(): void {
      assertCurrent();
      const profiles = captured.readProfiles().filter((entry) => entry.id === captured.profileId);
      if (profiles.length !== 1 || !isDeepStrictEqual(profiles[0], expectedProfile))
        throw new Error("Factory installation configured profile changed.");
    }
    let persisted = false;
    try {
      const pending = await captured.projects.beginFactoryInstallation({
        expected: prepared.project,
        checkpoint,
        assertCurrent: assertAttempt,
      });
      persisted = true;
      assertAttempt();
      await bind({
        owner: { identity: source.authority.identity, assertCurrent: assertAttempt },
        binding,
        operationId: request.operationId,
        provider: captured.provider,
        profileId: captured.profileId,
      });
      assertAttempt();
      const provider = attachFactoryControllerObservation({ runtime: captured.runtime, source });
      expectedStop = captured.runtime.stop;
      expectedObservation = provider;
      const observation = new NativeFactoryObservationService(provider, captured);
      await observation.invoke("factory.snapshot", { projectId: binding.projectId });
      assertAttempt();
      const revision = createHash("sha256")
        .update(JSON.stringify({ checkpoint, stage: "attached", ownerIdentity }))
        .digest("hex");
      const attached = await captured.projects.completeFactoryInstallation({
        expected: pending,
        checkpoint: { ...checkpoint, stage: "attached", revision },
        assertCurrent: assertAttempt,
      });
      await observation.invoke("factory.snapshot", { projectId: binding.projectId });
      assertAttempt();
      if (!isDeepStrictEqual(captured.projects.getLoadedRecord(binding.projectId), attached))
        throw new Error("Factory installation changed after completion.");
      confirmed = provider;
      const at = observedAt();
      return FactoryInstallResultSchema.parse({
        ...identity,
        outcome: "applied",
        installationId: binding.installationId,
        observedAt: at,
        setup: {
          schemaVersion: 1,
          serverId: captured.serverId,
          projectId: binding.projectId,
          installationId: binding.installationId,
          revision,
          observedAt: at,
          state: "installed",
          reason: null,
          operations: { install: false, pause: false, resume: false, stop: false, disable: false },
        },
      });
    } catch (error) {
      if (!persisted && !(error instanceof FactoryInstallCheckpointError))
        return refused("precondition_changed", "Factory setup changed before native binding.");
      uncertain = true;
      reconciliationHolds.add(captured.runtime);
      return FactoryInstallResultSchema.parse({
        ...identity,
        outcome: "uncertain",
        installationId: binding.installationId,
        reason:
          "Factory installation may have partially applied and requires native reconciliation.",
        reconciliationRequired: true,
      });
    }
  }

  /** Startup-only restoration of a completed installation, never an RPC repair
   * of partially persisted membership or an implicit execution admission. */
  async function restore(): Promise<void> {
    function assertRestorable(): void {
      assertCurrent();
      if (uncertain || reconciliationHolds.has(captured.runtime))
        throw new Error("Factory installation requires reconciliation before restoration.");
    }
    assertRestorable();
    const project = await captured.projects.get(binding.projectId);
    assertRestorable();
    const checkpoint = project?.factoryInstallation;
    if (
      !checkpoint ||
      checkpoint.stage !== "attached" ||
      checkpoint.serverId !== captured.serverId ||
      checkpoint.projectId !== binding.projectId ||
      checkpoint.installationId !== binding.installationId ||
      !isDeepStrictEqual(checkpoint.coordinators, binding.coordinators)
    )
      throw new Error("Factory restoration requires the exact completed native installation.");
    const profiles = captured.readProfiles().filter((entry) => entry.id === captured.profileId);
    if (profiles.length !== 1) throw new Error("Factory configured profile is unavailable.");
    const profile = structuredClone(profiles[0]);
    const authorityInput = {
      ...captured,
      owner: { identity: source.authority.identity, assertCurrent: assertRestorable },
      binding,
      operationId: checkpoint.operationId,
      profile,
    };
    const before = await captureFactoryCoordinatorAuthority(authorityInput);
    assertRestorable();
    if (!isDeepStrictEqual(captured.projects.getLoadedRecord(binding.projectId), project))
      throw new Error("Factory installation changed during restoration.");
    try {
      const provider = attachFactoryControllerObservation({ runtime: captured.runtime, source });
      expectedStop = captured.runtime.stop;
      expectedObservation = provider;
      const observation = new NativeFactoryObservationService(provider, captured);
      await observation.invoke("factory.snapshot", { projectId: binding.projectId });
      const after = await captureFactoryCoordinatorAuthority(authorityInput);
      assertRestorable();
      if (after.revision !== before.revision)
        throw new Error("Factory native coordinator changed during restoration.");
      if (
        !isDeepStrictEqual(
          captured.readProfiles().filter((entry) => entry.id === captured.profileId),
          [profile],
        )
      )
        throw new Error("Factory configured profile changed during restoration.");
      if (!isDeepStrictEqual(captured.projects.getLoadedRecord(binding.projectId), project))
        throw new Error("Factory installation changed after restoration.");
      assertRestorable();
      confirmed = provider;
    } catch (error) {
      uncertain = true;
      reconciliationHolds.add(captured.runtime);
      throw error;
    }
  }

  async function readControls(projectId: string): Promise<FactoryControlState> {
    const setup = await readSetup(projectId);
    assertCurrent();
    if (setup.state !== "installed" || !captured.controls)
      return {
        schemaVersion: 1,
        serverId: captured.serverId,
        projectId,
        installationId: setup.installationId,
        revision: null,
        state: "unavailable",
        desiredState: null,
        reason: "A reconciled native Factory owner control is unavailable.",
        operations: { pause: false, resume: false, stop: false },
        operationId: null,
      };
    const result = FactoryControlStateSchema.parse(await captured.controls.read());
    assertCurrent();
    if (
      result.serverId !== captured.serverId ||
      result.projectId !== projectId ||
      result.installationId !== binding.installationId
    )
      throw new Error("Factory owner control belongs to another installation.");
    return result;
  }

  async function control(value: FactoryControlInput): Promise<FactoryControlResult> {
    const request = FactoryControlInputSchema.parse(value);
    const current = await readControls(request.projectId);
    assertCurrent();
    const identity = {
      schemaVersion: 1 as const,
      serverId: captured.serverId,
      projectId: request.projectId,
      installationId: binding.installationId,
      operationId: request.operationId,
    };
    if (
      !captured.controls ||
      request.expectedServerId !== captured.serverId ||
      request.expectedInstallationId !== binding.installationId ||
      !current.operations[request.action]
    )
      return {
        ...identity,
        outcome: "refused",
        reason: "Factory control is unavailable or its identity changed.",
      };
    const result = FactoryControlResultSchema.parse(await captured.controls.execute(request));
    assertCurrent();
    if (
      result.serverId !== identity.serverId ||
      result.projectId !== identity.projectId ||
      result.installationId !== identity.installationId ||
      result.operationId !== identity.operationId
    )
      throw new Error("Factory control result differs from its request.");
    return result;
  }

  const adapter = { readSetup, install, restore, readControls, control };
  adapterOrigins.set(adapter, {
    runtime: captured.runtime,
    serverId: captured.serverId,
    projectId: binding.projectId,
    readSetup,
    install,
    restore,
    readControls,
    control,
  });
  return adapter;
}
