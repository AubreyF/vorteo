import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import {
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import {
  prepareMaintenanceLauncherRouting,
  inspectMaintenanceLauncherPlan,
  renderMaintenanceUserLauncher,
  verifyMaintenanceLauncherArtifacts,
  verifyMaintenanceLauncherProcess,
} from "./coordinator-bootstrap-maintenance-launcher.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import {
  reserveMaintenanceLauncherEffect,
  withReservedMaintenanceLauncherEffect,
} from "./coordinator-bootstrap-maintenance-launcher-state.js";
import { selectMaintenanceFiles } from "./coordinator-bootstrap-maintenance-file-selection.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { withinMaintenanceExecutionDeadline } from "./coordinator-bootstrap-maintenance-service-producer.js";
import { verifyMaintenanceRecoveryRouteSelection } from "./coordinator-bootstrap-maintenance-recovery-routing.js";
import {
  loadedCoordinatorPid,
  type BootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import { MaintenanceLauncherIntentSchema } from "./coordinator-bootstrap-maintenance-selection.js";

type Activation = Parameters<typeof reserveMaintenanceLauncherEffect>[0];
type Intent = ReturnType<typeof reserveMaintenanceLauncherEffect>;
type NativeProcess = Awaited<ReturnType<typeof verifyMaintenanceLauncherProcess>>;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export interface RecoveryRegistrationInput extends Activation {
  writableMountRoots: readonly string[];
}

interface RoutingObservation {
  backend: unknown;
  serve: unknown;
  assertCurrent(): void;
}

interface RecoveryListenerCustody {
  assertCurrent(): void;
}

export interface RecoveryRegistrationPorts {
  reader: BootstrapServiceReader;
  readRouting(executable: string): Promise<RoutingObservation>;
  /** Independent synchronous service, listener and runtime absence proof. */
  assertAbsent(service: string, listenPort: number): void;
  /** Native socket ownership and loopback HTTP proof for this exact process. */
  inspectListener(input: {
    process: NativeProcess;
    origin: string;
    listenPort: number;
  }): Promise<RecoveryListenerCustody>;
  run(executable: string, args: readonly string[], assertWithinDeadline: () => void): Promise<void>;
}

/** Production commands are bounded separately from the total activation budget.
 * An error or lost reply is uncertain; callers must observe the retained intent. */
export async function runRecoveryRegistrationCommand(
  executable: string,
  args: readonly string[],
  assertWithinDeadline: () => void,
) {
  assertWithinDeadline();
  await promisify(execFile)(executable, [...args], {
    env: { PATH: "/usr/bin:/bin", TAILSCALE_BE_CLI: "1" },
    timeout: 10_000,
    maxBuffer: 8192,
  });
}

/** Initial registration only. The existing exact enrollment step owns every
 * effect; there is no retry loop, separate queue, password or authority ledger.
 * A caller must provide independently verified native ports, not HTTP input. */
export async function activateMaintenanceRecoveryAccess(
  input: RecoveryRegistrationInput,
  ports: RecoveryRegistrationPorts,
) {
  return withinMaintenanceExecutionDeadline(Date.now() + 60_000, async (checkDeadline) => {
    const context = await inspectRecoveryRegistrationContext(input);
    checkDeadline();
    const routing = await ports.readRouting(context.route.tailscale.path);
    checkDeadline();
    const prepared = await prepareMaintenanceLauncherRouting({
      ...input,
      backend: routing.backend,
      currentServe: routing.serve,
    });
    const assertAbsent = () => {
      checkDeadline();
      context.assertCurrent();
      if (routing.assertCurrent() !== undefined)
        throw new BootstrapRequestConflict("Recovery routing requires synchronous custody proof");
      if (
        input.assertCurrent() !== undefined ||
        ports.assertAbsent(context.service, context.access.listenPort) !== undefined
      )
        throw new BootstrapRequestConflict(
          "Recovery registration requires synchronous native absence proof",
        );
    };
    const absentInput = { ...input, assertCurrent: assertAbsent };
    checkDeadline();
    const retained = reserveMaintenanceLauncherEffect(absentInput);
    withReservedMaintenanceLauncherEffect(absentInput, retained, () => {
      selectMaintenanceFiles({
        attemptFile: path.join(
          input.enrollmentStateDirectory,
          `maintenance-selection-${retained.intent.id}.json`,
        ),
        reservationSha256: hash(JSON.stringify(retained.intent)),
        launcher: {
          path: context.identity.launcherPath,
          previousSha256: null,
          bytes: renderMaintenanceUserLauncher(context.plan, "candidate"),
        },
        selection: {
          path: context.selectionPath,
          previousSha256: null,
          bytes: Buffer.from(
            JSON.stringify({
              version: 1,
              intentId: retained.intent.id,
              stepId: input.stepId,
              generation: input.generation,
              planSha256: context.planSha256,
              slot: "candidate",
            }),
          ),
        },
        assertCurrent: assertAbsent,
      });
      return undefined;
    });
    withReservedMaintenanceLauncherEffect(absentInput, retained, () => undefined);
    checkDeadline();
    await ports.run(
      "/bin/launchctl",
      ["bootstrap", context.identity.serviceDomain, context.identity.launcherPath],
      checkDeadline,
    );
    checkDeadline();
    const current = await ports.readRouting(context.route.tailscale.path);
    checkDeadline();
    const rechecked = await prepareMaintenanceLauncherRouting({
      ...input,
      backend: current.backend,
      currentServe: current.serve,
    });
    if (!isDeepStrictEqual(prepared, rechecked))
      throw new BootstrapRequestConflict("Recovery route changed before activation");
    const native = await waitForRegisteredListener(input, ports, retained, checkDeadline);
    checkDeadline();
    withReservedMaintenanceLauncherEffect(
      {
        ...input,
        assertCurrent: () => {
          checkDeadline();
          context.assertCurrent();
          if (input.assertCurrent() !== undefined)
            throw new BootstrapRequestConflict("Recovery executor custody must remain synchronous");
          native.assertCurrent();
          if (current.assertCurrent() !== undefined)
            throw new BootstrapRequestConflict("Recovery routing custody changed before dispatch");
        },
      },
      retained,
      () => undefined,
    );
    checkDeadline();
    await ports.run(context.route.tailscale.path, prepared.arguments, checkDeadline);
    checkDeadline();
    return observeMaintenanceRecoveryAccessRegistration(input, ports, retained);
  });
}

/** Safe after revocation or an uncertain command. This never registers a
 * service, changes routing, reserves another attempt or terminalizes a grant. */
export async function observeMaintenanceRecoveryAccessRegistration(
  input: RecoveryRegistrationInput,
  ports: RecoveryRegistrationPorts,
  retained: Intent,
) {
  return withinMaintenanceExecutionDeadline(Date.now() + 10_000, async (checkDeadline) => {
    const native = await inspectRegisteredListener(input, ports, retained);
    checkDeadline();
    const routing = await ports.readRouting(native.context.route.tailscale.path);
    const previousBytes = await readBootstrapPreparedFile(
      native.context.route.previousServe,
      input.writableMountRoots,
    );
    verifyMaintenanceRecoveryRouteSelection({
      access: native.context.access,
      previousServe: JSON.parse(previousBytes.toString("utf8")),
      currentServe: routing.serve,
      backend: routing.backend,
    });
    checkDeadline();
    native.assertCurrent();
    if (routing.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Recovery routing observation custody changed");
    return {
      intent: retained.intent,
      planSha256: native.context.planSha256,
      identitySha256: native.context.identitySha256,
      origin: native.context.access.origin,
      process: native.process,
      observedAt: new Date().toISOString(),
      listenerAndRouteVerified: true as const,
      ownerRemoteAcceptance: false as const,
      assertCurrent() {
        native.assertCurrent();
        if (routing.assertCurrent() !== undefined)
          throw new BootstrapRequestConflict("Recovery routing observation custody changed");
      },
    };
  });
}

export async function inspectRecoveryRegistrationContext(input: RecoveryRegistrationInput) {
  const context = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const { identity, previous, recoveryRoute } = context.plan;
  if (
    identity.environment !== "host" ||
    identity.target !== "recovery-launcher" ||
    previous ||
    !identity.selectionPath ||
    !recoveryRoute
  )
    throw new BootstrapRequestConflict(
      "Independent recovery registration requires its exact initial access plan",
    );
  const planFile = path.join(
    path.dirname(identity.selectionPath),
    "plans",
    `${context.planSha256}.json`,
  );
  const assertCurrent = retainServiceFiles([
    planFile,
    context.plan.candidate.setup.path,
    context.plan.candidate.entrypoint.path,
    context.plan.candidate.node.path,
    recoveryRoute.tailscale.path,
    recoveryRoute.previousServe.path,
  ]);
  await verifyMaintenanceLauncherArtifacts(input);
  const planBytes = await readProtectedDocument(planFile);
  if (!isDeepStrictEqual(JSON.parse(planBytes.toString("utf8")), context.plan))
    throw new BootstrapRequestConflict(
      "Recovery registration plan differs from protected preparation",
    );
  const setupBytes = await readBootstrapPreparedFile(
    context.plan.candidate.setup,
    input.writableMountRoots,
  );
  const setup = MaintenanceLauncherSetupSchema.parse(JSON.parse(setupBytes.toString("utf8")));
  const access = setup.control?.recoveryAccess;
  if (!access || setup.enrollmentStateDirectory !== input.enrollmentStateDirectory)
    throw new BootstrapRequestConflict(
      "Recovery registration state or access configuration changed",
    );
  assertCurrent();
  return {
    ...context,
    identity,
    selectionPath: identity.selectionPath,
    route: recoveryRoute,
    access,
    setup,
    planFile,
    assertCurrent,
    service: `${identity.serviceDomain}/${identity.serviceLabel}`,
  };
}

async function inspectRegisteredListener(
  input: RecoveryRegistrationInput,
  ports: RecoveryRegistrationPorts,
  retained: Intent,
) {
  const context = await inspectRecoveryRegistrationContext(input);
  const startup = await readMaintenanceLauncherStartup({
    setupFile: context.plan.candidate.setup.path,
    account: input.account,
  });
  const intent = MaintenanceLauncherIntentSchema.parse(startup.intent);
  if (
    startup.selection.version !== 1 ||
    startup.intentFile !== retained.file ||
    !isDeepStrictEqual(startup.intent, retained.intent) ||
    startup.planSha256 !== context.planSha256 ||
    startup.selection.generation !== input.generation ||
    intent.grantId !== input.grantId ||
    intent.grantRevision !== input.grantRevision ||
    startup.selection.slot !== "candidate"
  )
    throw new BootstrapRequestConflict(
      "Recovery listener belongs to another activation generation",
    );
  const assertFiles = retainServiceFiles([
    context.planFile,
    retained.file,
    context.identity.launcherPath,
    context.selectionPath,
    context.plan.candidate.setup.path,
    context.route.tailscale.path,
  ]);
  const launcher = await readProtectedDocument(context.identity.launcherPath);
  if (!launcher.equals(renderMaintenanceUserLauncher(context.plan, "candidate")))
    throw new BootstrapRequestConflict("Recovery listener launcher differs from the selected plan");
  const pid = loadedCoordinatorPid(
    context.service,
    await ports.reader.readService(context.service),
  );
  const process = await verifyMaintenanceLauncherProcess({
    ...input,
    selected: "candidate",
    pid,
    reader: ports.reader,
  });
  const listener = await ports.inspectListener({
    process,
    origin: context.access.origin,
    listenPort: context.access.listenPort,
  });
  const assertCurrent = () => {
    context.assertCurrent();
    assertFiles();
    if (listener.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Recovery listener requires synchronous custody proof");
  };
  assertCurrent();
  return { context, process, assertCurrent };
}

/** launchd registration can return before exec and the loopback listener settle.
 * Repeat observation within the existing activation budget, never the command.
 * Final routing admission still rechecks the grant and exact native custody. */
async function waitForRegisteredListener(
  input: RecoveryRegistrationInput,
  ports: RecoveryRegistrationPorts,
  retained: Intent,
  checkDeadline: () => void,
) {
  for (;;) {
    checkDeadline();
    try {
      const native = await inspectRegisteredListener(input, ports, retained);
      checkDeadline();
      return native;
    } catch {
      checkDeadline();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}
