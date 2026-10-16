import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import {
  MaintenanceLauncherSetupSchema,
  MaintenanceOwnerConfigurationSchema,
} from "./coordinator-bootstrap-maintenance-setup.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import {
  MaintenanceRecoveryRouteSchema,
  inspectMaintenanceRecoveryRouting,
  verifyMaintenanceRecoveryRouteArtifacts,
} from "./coordinator-bootstrap-maintenance-recovery-routing.js";
import {
  loadedCoordinatorPid,
  type BootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  verifyBootstrapPreparedDependency,
} from "./coordinator-bootstrap-artifact.js";
import {
  EnrollmentNativeIdentitySchema,
  enrollmentNativeIdentityDigest,
} from "./maintenance/native-identity.js";

const pin = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const slot = z.strictObject({
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  directory: z.string().startsWith("/"),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  node: pin,
  entrypoint: pin,
  setup: pin,
});

/** Both immutable slots and the stable user service identity enter the owner
 * manifest. Preparing this document neither selects nor registers either slot. */
export const MaintenanceLauncherPlanSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("maintenance-launcher-replacement"),
  identity: EnrollmentNativeIdentitySchema,
  previous: slot.nullable(),
  candidate: slot,
  retryLimit: z.literal(3),
  recovery: z.literal("after-login"),
  recoveryRoute: MaintenanceRecoveryRouteSchema.optional(),
});
export type MaintenanceLauncherPlan = z.infer<typeof MaintenanceLauncherPlanSchema>;

export function inspectMaintenanceLauncherPlan(
  value: unknown,
  account: { uid: number; home: string },
) {
  const plan = MaintenanceLauncherPlanSchema.parse(value);
  const { identity } = plan;
  if (
    identity.environment !== "host" ||
    !["maintenance-controller", "recovery-launcher"].includes(identity.target) ||
    identity.custodyOwnerUid !== account.uid ||
    identity.serviceDomain !== `gui/${account.uid}` ||
    !/^local\.vorteo\.[a-zA-Z0-9.-]+\.installation(?:-recovery-[a-f0-9-]{36})?$/.test(
      identity.serviceLabel,
    )
  )
    throw new BootstrapRequestConflict("Maintenance launcher requires its enrolled user service");
  const base = path.join(identity.installationRoot, "maintenance-services", identity.target);
  if (
    identity.selectionPath !== path.join(base, "selection.json") ||
    identity.launcherPath !==
      path.join(account.home, "Library", "LaunchAgents", `${identity.serviceLabel}.plist`)
  )
    throw new BootstrapRequestConflict("Maintenance launcher paths differ from enrolled custody");
  for (const release of [plan.previous, plan.candidate]) {
    if (!release) continue;
    if (
      release.directory !==
        path.join(identity.installationRoot, "maintenance-runtimes", release.sourceCommit) ||
      (release.entrypoint.path !==
        path.join(
          release.directory,
          "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js",
        ) &&
        !isRecoveryAccessSlot(plan, release)) ||
      release.setup.path !== path.join(base, `${release.sourceCommit}.json`)
    )
      throw new BootstrapRequestConflict("Maintenance slot is outside its immutable runtime");
  }
  if (plan.previous?.sourceCommit === plan.candidate.sourceCommit)
    throw new BootstrapRequestConflict(
      "Maintenance replacement must preserve a distinct previous slot",
    );
  if (plan.recoveryRoute && !isRecoveryAccessSlot(plan, plan.candidate))
    throw new BootstrapRequestConflict("Recovery routing requires the standalone access launcher");
  return {
    plan,
    identitySha256: enrollmentNativeIdentityDigest(identity),
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

function isRecoveryAccessSlot(
  plan: MaintenanceLauncherPlan,
  release: MaintenanceLauncherPlan["candidate"],
) {
  return (
    plan.identity.target === "recovery-launcher" &&
    release.entrypoint.path ===
      path.join(
        release.directory,
        "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-access.js",
      )
  );
}

/** Only the read-only access listener uses continuous OS supervision. Effect
 * retries remain bounded by the existing durable lifecycle generation. */
export function maintenanceUserLauncher(
  plan: MaintenanceLauncherPlan,
  selected: "previous" | "candidate",
) {
  const release = plan[selected];
  if (!release || plan.identity.environment !== "host")
    throw new BootstrapRequestConflict("Maintenance launcher slot is unavailable");
  const recoveryAccess = isRecoveryAccessSlot(plan, release);
  const args = [release.node.path, release.entrypoint.path, release.setup.path];
  if (!recoveryAccess) args.push("maintenance-launcher");
  return {
    Label: plan.identity.serviceLabel,
    ProgramArguments: args,
    RunAtLoad: true,
    KeepAlive: recoveryAccess,
    ...(recoveryAccess ? { ThrottleInterval: 10 } : {}),
    ProcessType: "Background",
    Umask: 0o077,
    StandardErrorPath: path.join(plan.identity.stateDirectory, `${plan.identity.target}.stderr`),
  };
}

/** Native callers supply inspected account and mount inventory. Every slot is
 * verified before admission, including the compatible rollback runtime. */
export async function verifyMaintenanceLauncherArtifacts(input: {
  plan: unknown;
  account: { uid: number; home: string };
  writableMountRoots: readonly string[];
}) {
  const inspected = inspectMaintenanceLauncherPlan(input.plan, input.account);
  const { identity } = inspected.plan;
  await assertBootstrapPathsProtected(
    [
      identity.installationRoot,
      identity.stateDirectory,
      path.dirname(identity.launcherPath),
      path.dirname(identity.selectionPath!),
    ],
    input.writableMountRoots,
  );
  if (inspected.plan.recoveryRoute)
    await verifyMaintenanceRecoveryRouteArtifacts({
      route: inspected.plan.recoveryRoute,
      writableMountRoots: input.writableMountRoots,
    });
  let recoveryAddress: string | undefined;
  for (const release of [inspected.plan.previous, inspected.plan.candidate]) {
    if (!release) continue;
    for (const file of [release.node, release.entrypoint])
      await verifyBootstrapPreparedDependency(file, input.writableMountRoots);
    const setupBytes = await readBootstrapPreparedFile(release.setup, input.writableMountRoots);
    const setup = MaintenanceLauncherSetupSchema.parse(JSON.parse(setupBytes.toString("utf8")));
    if (setup.control?.recoveryAccess && !isRecoveryAccessSlot(inspected.plan, release))
      throw new BootstrapRequestConflict("Recovery access requires its standalone entry point");
    if (isRecoveryAccessSlot(inspected.plan, release)) {
      const access = setup.control?.recoveryAccess;
      if (
        !access ||
        !isDeepStrictEqual(
          {
            target: setup.target,
            installationRoot: setup.installationRoot,
            identitySha256: setup.identitySha256,
            sourceCommit: setup.sourceCommit,
            installationId: access.installationId,
          },
          {
            target: "recovery-launcher",
            installationRoot: identity.installationRoot,
            identitySha256: inspected.identitySha256,
            sourceCommit: release.sourceCommit,
            installationId: identity.installationId,
          },
        )
      )
        throw new BootstrapRequestConflict(
          "Recovery access setup differs from the reviewed native identity",
        );
      const address = JSON.stringify([
        access.origin,
        access.listenPort,
        setup.enrollmentStateDirectory,
      ]);
      if (recoveryAddress !== undefined && address !== recoveryAddress)
        throw new BootstrapRequestConflict(
          "Compatible recovery slots must preserve the bookmarked address and lifecycle directory",
        );
      recoveryAddress = address;
      await assertBootstrapPathsProtected(
        [access.ownerConfigurationFile, setup.enrollmentStateDirectory],
        input.writableMountRoots,
      );
      const owner = MaintenanceOwnerConfigurationSchema.parse(
        readPrivateBootstrapConfiguration(access.ownerConfigurationFile, input.account.uid),
      );
      if (
        owner.public.installationId !== identity.installationId ||
        owner.stateDir !== setup.enrollmentStateDirectory ||
        owner.public.origin === access.origin
      )
        throw new BootstrapRequestConflict(
          "Recovery access owner configuration differs from the reviewed installation",
        );
    }
    if ((await digestBootstrapArtifact(release.directory)) !== release.artifactSha256)
      throw new BootstrapRequestConflict("Maintenance launcher runtime changed");
  }
  return inspected;
}

/** Preparation is tied to the complete reviewed plan and protected candidate
 * setup. It does not register a listener, change Serve, or consume authority. */
export async function prepareMaintenanceLauncherRouting(
  input: Parameters<typeof verifyMaintenanceLauncherArtifacts>[0] & {
    backend: unknown;
    currentServe: unknown;
  },
) {
  const inspected = await verifyMaintenanceLauncherArtifacts(input);
  const route = inspected.plan.recoveryRoute;
  if (!route) throw new BootstrapRequestConflict("Recovery route preparation is absent");
  const setupBytes = await readBootstrapPreparedFile(
    inspected.plan.candidate.setup,
    input.writableMountRoots,
  );
  const setup = MaintenanceLauncherSetupSchema.parse(JSON.parse(setupBytes.toString("utf8")));
  const access = setup.control?.recoveryAccess;
  if (!access) throw new BootstrapRequestConflict("Recovery access configuration is absent");
  const previousServe = await verifyMaintenanceRecoveryRouteArtifacts({
    route,
    writableMountRoots: input.writableMountRoots,
  });
  return {
    planSha256: inspected.planSha256,
    ...inspectMaintenanceRecoveryRouting({ ...input, previousServe, access }),
  };
}

/** Read-only native startup proof. A new login may have a new boot identity;
 * require a stable current lifetime rather than comparing with a prior boot.
 * This proves the loaded process, not health, selection authority or permission
 * to execute an effect. Those checks remain separate admission requirements. */
export async function verifyMaintenanceLauncherProcess(input: {
  plan: MaintenanceLauncherPlan;
  account: { uid: number; home: string };
  selected: "previous" | "candidate";
  pid: number;
  reader: BootstrapServiceReader;
}) {
  const { plan } = inspectMaintenanceLauncherPlan(input.plan, input.account);
  if (plan.identity.environment !== "host")
    throw new BootstrapRequestConflict("Maintenance launcher requires native Host identity");
  const selectedSlot = plan[input.selected];
  if (!selectedSlot) throw new BootstrapRequestConflict("Maintenance launcher slot is unavailable");
  const service = `${plan.identity.serviceDomain}/${plan.identity.serviceLabel}`;
  const expectedArguments = createHash("sha256")
    .update(JSON.stringify(maintenanceUserLauncher(plan, input.selected).ProgramArguments))
    .digest("hex");
  const observe = async () => {
    const loaded = loadedCoordinatorPid(service, await input.reader.readService(service));
    const observed = ProcessObservationSchema.parse(await input.reader.inspectProcess(loaded));
    if (
      loaded !== input.pid ||
      observed.pid !== input.pid ||
      observed.parentPid !== 1 ||
      observed.uid !== input.account.uid ||
      observed.executable !== selectedSlot.node.path ||
      observed.argumentsSha256 !== expectedArguments
    )
      throw new BootstrapRequestConflict("Maintenance launcher native identity changed");
    return observed;
  };
  const first = await observe();
  const second = await observe();
  if (!isDeepStrictEqual(first, second))
    throw new BootstrapRequestConflict("Maintenance launcher lifetime changed during observation");
  return second;
}

/** Generate the exact reviewed user-service plist without shell interpolation.
 * Selection is a separate durable effect; rendering never registers a service. */
export function renderMaintenanceUserLauncher(
  plan: MaintenanceLauncherPlan,
  selected: "previous" | "candidate",
): Buffer {
  const launcher = maintenanceUserLauncher(plan, selected);
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&apos;";
      }
    });
  const string = (value: string) => `<string>${escape(value)}</string>`;
  const bytes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    "<key>Label</key>",
    string(launcher.Label),
    "<key>ProgramArguments</key><array>",
    ...launcher.ProgramArguments.map(string),
    "</array>",
    "<key>RunAtLoad</key><true/>",
    `<key>KeepAlive</key><${launcher.KeepAlive}/>`,
    ...(launcher.ThrottleInterval === undefined
      ? []
      : [`<key>ThrottleInterval</key><integer>${launcher.ThrottleInterval}</integer>`]),
    "<key>ProcessType</key>",
    string(launcher.ProcessType),
    `<key>Umask</key><integer>${launcher.Umask}</integer>`,
    "<key>StandardErrorPath</key>",
    string(launcher.StandardErrorPath),
    "</dict></plist>",
  ].join("\n");
  return Buffer.from(bytes);
}
