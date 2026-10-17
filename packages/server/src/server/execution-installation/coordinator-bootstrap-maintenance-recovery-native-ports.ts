import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawnSync } from "node:child_process";
import { request } from "node:http";
import { isDeepStrictEqual, promisify } from "node:util";
import { z } from "zod";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapPreparedDependency,
} from "./coordinator-bootstrap-artifact.js";
import {
  retainServiceFiles,
  createMaintenanceServiceInspectionPorts,
} from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
} from "./coordinator-bootstrap-host.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { verifyMaintenanceLauncherProcess } from "./coordinator-bootstrap-maintenance-launcher.js";
import { assertMaintenanceServiceAbsent } from "./coordinator-bootstrap-maintenance-absence.js";
import { assertMaintenanceRuntimeProcessesAbsent } from "./coordinator-bootstrap-maintenance-process-inventory.js";
import {
  inspectRecoveryRegistrationContext,
  runRecoveryRegistrationCommand,
  type RecoveryRegistrationInput,
  type RecoveryRegistrationPorts,
} from "./coordinator-bootstrap-maintenance-recovery-registration.js";
import {
  inspectMaintenanceRecoveryRouting,
  verifyMaintenanceRecoveryRouteArtifacts,
} from "./coordinator-bootstrap-maintenance-recovery-routing.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import { withReservedMaintenanceLauncherEffect } from "./coordinator-bootstrap-maintenance-launcher-state.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import { MaintenanceLauncherIntentSchema } from "./coordinator-bootstrap-maintenance-selection.js";
import { readMaintenanceLauncherStartup } from "./coordinator-bootstrap-maintenance-startup.js";
import { inspectSelectedMaintenanceRecoveryAccess } from "./coordinator-bootstrap-maintenance-executor-evidence.js";
import {
  maintenanceRecoveryDocument,
  maintenanceRecoveryScript,
} from "./coordinator-bootstrap-maintenance-recovery-page.js";

const backendIdentity = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }),
});
// The macOS bundle must stay in CLI mode even without a terminal environment.
const nativeEnvironment = { PATH: "/usr/bin:/bin", TAILSCALE_BE_CLI: "1" };
type NativeProcess = z.infer<typeof BootstrapProcessIdentitySchema>;
interface NativeInspector {
  helperPath: string;
  helperSha256: string;
  writableMountRoots: readonly string[];
}

function readNativeCommand(executable: string, args: readonly string[]) {
  const result = spawnSync(executable, [...args], {
    env: nativeEnvironment,
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr.trim())
    throw new BootstrapRequestConflict("Native recovery inspection is incomplete");
  return result.stdout;
}

/** Ask the kernel whether the exact loopback address can be bound. An empty
 * process listing cannot distinguish an available port from incomplete inspection.
 * This probe closes immediately; startup must still prove the selected listener. */
export function assertNativeRecoveryPortAvailable(port: number): void {
  z.number().int().min(1024).max(65535).parse(port);
  try {
    const result = readNativeCommand("/usr/bin/python3", [
      "-I",
      "-B",
      "-c",
      "import socket,sys\nwith socket.socket(socket.AF_INET,socket.SOCK_STREAM) as listener:\n listener.bind(('127.0.0.1',int(sys.argv[1])))\nprint('available')",
      String(port),
    ]);
    if (result !== "available\n")
      throw new BootstrapRequestConflict("Unexpected recovery port probe result");
  } catch (error) {
    if (!(error instanceof BootstrapRequestConflict)) throw error;
    throw new BootstrapRequestConflict("Recovery loopback port is unavailable or unverified");
  }
}

/** The protected helper reads kernel birth, boot, owner, executable and argv.
 * This is observation only; a caller-selected PID grants no effect authority. */
export async function retainNativeRecoveryProcess(
  input: NativeInspector & { process: NativeProcess },
) {
  const expected = BootstrapProcessIdentitySchema.parse(input.process);
  if (process.platform !== "darwin" || expected.uid !== process.getuid?.())
    throw new BootstrapRequestConflict("Recovery listener requires native owner custody");
  const assertFiles = retainServiceFiles([input.helperPath, expected.executable]);
  const helper = await readBootstrapPreparedFile(
    { path: input.helperPath, sha256: input.helperSha256 },
    input.writableMountRoots,
  );
  const assertCurrent = () => {
    assertFiles();
    const actual = BootstrapProcessIdentitySchema.parse(
      JSON.parse(
        readNativeCommand("/usr/bin/python3", [
          "-I",
          "-B",
          "-c",
          helper.toString("utf8"),
          String(expected.pid),
        ]),
      ),
    );
    if (!isDeepStrictEqual(actual, expected))
      throw new BootstrapRequestConflict("Recovery listener native lifetime changed");
    assertFiles();
  };
  assertCurrent();
  return { process: expected, assertCurrent };
}

/** Require this lifetime's loopback socket, not merely an HTTP response from
 * the same port. Unknown native fields and inspection failures are refusals. */
export function assertNativeRecoveryListener(process: NativeProcess, port: number) {
  z.number().int().min(1024).max(65535).parse(port);
  const fields = readNativeCommand("/usr/sbin/lsof", [
    "-nP",
    "-a",
    "-p",
    String(process.pid),
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-Fpn",
  ])
    .trim()
    .split("\n");
  let pids = 0;
  let sockets = 0;
  for (const field of fields) {
    if (field === `p${process.pid}`) pids++;
    else if (/^f[0-9]+$/.test(field)) continue;
    else if (field === `n127.0.0.1:${port}`) sockets++;
    else throw new BootstrapRequestConflict("Recovery socket is not the exact loopback listener");
  }
  if (pids !== 1 || sockets !== 1)
    throw new BootstrapRequestConflict("Recovery listener socket ownership is ambiguous");
}

function readRecoveryAsset(input: {
  origin: string;
  port: number;
  asset: string;
  signal: AbortSignal;
}): Promise<string> {
  // Native fetch rewrites Host to the loopback address. The protected listener
  // requires the reviewed HTTPS host even on this direct local connection.
  return new Promise((resolve, reject) => {
    const probe = request(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: input.asset,
        method: "GET",
        headers: { Host: new URL(input.origin).host, "Cache-Control": "no-store" },
        signal: input.signal,
      },
      (response) => {
        response.once("error", reject);
        const mediaType = response.headers["content-type"];
        const expectedType =
          input.asset === "/" ? /^text\/html(?:;|$)/i : /^(text|application)\/javascript(?:;|$)/i;
        if (
          response.statusCode !== 200 ||
          typeof mediaType !== "string" ||
          !expectedType.test(mediaType)
        ) {
          response.destroy(
            new BootstrapRequestConflict("Recovery page assets are unavailable or unusable"),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: unknown) => {
          if (!Buffer.isBuffer(chunk)) {
            response.destroy(
              new BootstrapRequestConflict("Recovery page asset is not a byte response"),
            );
            return;
          }
          size += chunk.length;
          if (size > 16 * 1024) {
            response.destroy(
              new BootstrapRequestConflict("Recovery page asset exceeds its inspection bound"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    probe.once("error", reject);
    probe.end();
  });
}

export async function inspectNativeRecoveryListener(
  input: NativeInspector & {
    process: NativeProcess;
    origin: string;
    listenPort: number;
  },
) {
  const custody = await retainNativeRecoveryProcess(input);
  assertNativeRecoveryListener(custody.process, input.listenPort);
  const signal = AbortSignal.timeout(5000);
  const [document, script] = await Promise.all([
    readRecoveryAsset({ origin: input.origin, port: input.listenPort, asset: "/", signal }),
    readRecoveryAsset({
      origin: input.origin,
      port: input.listenPort,
      asset: "/recovery.js",
      signal,
    }),
  ]);
  if (document !== maintenanceRecoveryDocument || script !== maintenanceRecoveryScript)
    throw new BootstrapRequestConflict("Recovery listener does not serve its independent page");
  const observedAt = Date.now();
  const assertCurrent = () => {
    if (Date.now() - observedAt >= 5000)
      throw new BootstrapRequestConflict("Recovery listener observation expired");
    custody.assertCurrent();
    assertNativeRecoveryListener(custody.process, input.listenPort);
  };
  assertCurrent();
  return { assertCurrent };
}

/** Lazy authenticated review preparation uses this proof. Opening the page
 * never calls it, so damaged maintenance history cannot prevent rendering. */
export async function inspectNativeRecoveryReviewParent(input: {
  setupFile: string;
  account: { uid: number; home: string };
  stateDirectory: string;
}) {
  const startup = await readMaintenanceLauncherStartup(input);
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (await readBootstrapPreparedFile(startup.setup.nativeAdmission, [])).toString("utf8"),
    ),
  );
  const writableMountRoots = await inspectBootstrapWritableMountRoots(admission);
  const ports = await createMaintenanceServiceInspectionPorts({ ...admission, writableMountRoots });
  const current = await inspectSelectedMaintenanceRecoveryAccess({
    ...input,
    writableMountRoots,
    ports,
  });
  const expectedModule = path.join(
    current.startup.selected.directory,
    "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-native-ports.js",
  );
  if (current.process.pid !== process.pid || fileURLToPath(import.meta.url) !== expectedModule)
    throw new BootstrapRequestConflict("Recovery review is outside its selected native listener");
  const listener = await inspectNativeRecoveryListener({
    ...admission,
    writableMountRoots,
    process: current.process,
    origin: current.access.origin,
    listenPort: current.access.listenPort,
  });
  const assertCurrent = () => {
    current.assertCurrent();
    listener.assertCurrent();
  };
  assertCurrent();
  return { ...current, writableMountRoots, assertCurrent };
}

/** Preserve the full Serve document, but do not bind peer presence or traffic
 * counters. Those do not identify this machine or authorize route mutation. */
export async function inspectNativeRecoveryRouting(input: {
  tailscale: { path: string; sha256: string };
  writableMountRoots: readonly string[];
}) {
  await verifyBootstrapPreparedDependency(
    input.tailscale,
    input.writableMountRoots,
    "host-or-root",
  );
  const assertFiles = retainServiceFiles([input.tailscale.path]);
  const read = async (args: string[]) => {
    const value = await promisify(execFile)(input.tailscale.path, args, {
      env: nativeEnvironment,
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    if (value.stderr.trim())
      throw new BootstrapRequestConflict("Private routing inspection is incomplete");
    return JSON.parse(value.stdout);
  };
  const [status, serve] = await Promise.all([
    read(["status", "--json"]),
    read(["serve", "status", "--json"]),
  ]);
  const backend = backendIdentity.parse(status);
  const assertCurrent = () => {
    assertFiles();
    const currentBackend = backendIdentity.parse(
      JSON.parse(readNativeCommand(input.tailscale.path, ["status", "--json"])),
    );
    const currentServe: unknown = JSON.parse(
      readNativeCommand(input.tailscale.path, ["serve", "status", "--json"]),
    );
    if (!isDeepStrictEqual(backend, currentBackend) || !isDeepStrictEqual(serve, currentServe))
      throw new BootstrapRequestConflict("Private routing changed during native inspection");
    assertFiles();
  };
  assertCurrent();
  return { backend, serve, assertCurrent };
}

interface RegistrationExecutorCustody {
  process: NativeProcess;
  assertCurrent(): void;
}

/** Construct only for the native one-generation activation. Observation remains
 * possible after revocation; effects independently re-read the original intent
 * and current grant. This does not add a consumer or enable a capability. */
export async function createNativeRecoveryRegistrationPorts(
  input: RecoveryRegistrationInput,
  executors: readonly RegistrationExecutorCustody[],
): Promise<RecoveryRegistrationPorts> {
  if (process.platform !== "darwin" || input.account.uid !== process.getuid?.())
    throw new BootstrapRequestConflict(
      "Recovery registration requires the configured native owner",
    );
  const context = await inspectRecoveryRegistrationContext(input);
  requireRegistrationHistory(input, context.planSha256, context.identitySha256);
  const relativeNode = path.relative(
    context.plan.candidate.directory,
    context.plan.candidate.node.path,
  );
  if (!relativeNode || relativeNode.startsWith("..") || path.isAbsolute(relativeNode))
    throw new BootstrapRequestConflict(
      "Recovery registration requires an immutable private Node runtime",
    );
  const admission = BootstrapAdmissionSetupSchema.parse(
    JSON.parse(
      (
        await readBootstrapPreparedFile(context.setup.nativeAdmission, input.writableMountRoots)
      ).toString("utf8"),
    ),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  if (!isDeepStrictEqual([...roots].sort(), [...input.writableMountRoots].sort()))
    throw new BootstrapRequestConflict("Recovery registration writable mounts changed");
  if (
    executors.length > 2 ||
    executors.some((item) => ![process.pid, process.ppid].includes(item.process.pid))
  )
    throw new BootstrapRequestConflict("Runtime exclusions require the actual activation lineage");
  const custodies = await Promise.all(
    executors.map(async (item) => {
      const custody = await retainNativeRecoveryProcess({
        ...admission,
        writableMountRoots: roots,
        process: item.process,
      });
      return {
        process: custody.process,
        assertCurrent() {
          custody.assertCurrent();
          if (item.assertCurrent() !== undefined)
            throw new BootstrapRequestConflict("Activation lineage custody changed");
        },
      };
    }),
  );
  const reader = await createNativeBootstrapServiceReader({
    ...admission,
    writableMountRoots: roots,
  });
  const previousServe = await verifyMaintenanceRecoveryRouteArtifacts({
    route: context.route,
    writableMountRoots: roots,
  });
  let routing: Awaited<ReturnType<typeof inspectNativeRecoveryRouting>> | undefined;
  let listener: Awaited<ReturnType<typeof inspectNativeRecoveryListener>> | undefined;
  const assertAbsent = (service: string, listenPort: number) => {
    context.assertCurrent();
    if (service !== context.service || listenPort !== context.access.listenPort)
      throw new BootstrapRequestConflict("Recovery absence targets another service");
    assertMaintenanceServiceAbsent(service);
    assertNativeRecoveryPortAvailable(listenPort);
    assertMaintenanceRuntimeProcessesAbsent({
      uid: input.account.uid,
      executables: [context.plan.candidate.node.path],
      allowedProcesses: custodies,
    });
  };
  return {
    reader,
    assertAbsent,
    async readRouting(executable) {
      if (executable !== context.route.tailscale.path)
        throw new BootstrapRequestConflict("Recovery routing executable changed");
      routing = await inspectNativeRecoveryRouting({
        tailscale: context.route.tailscale,
        writableMountRoots: roots,
      });
      return routing;
    },
    async inspectListener(observed) {
      if (
        observed.origin !== context.access.origin ||
        observed.listenPort !== context.access.listenPort
      )
        throw new BootstrapRequestConflict("Recovery listener address changed");
      const actual = await verifyMaintenanceLauncherProcess({
        ...input,
        selected: "candidate",
        pid: observed.process.pid,
        reader,
      });
      if (!isDeepStrictEqual(actual, observed.process))
        throw new BootstrapRequestConflict(
          "Recovery listener process differs from native registration",
        );
      listener = await inspectNativeRecoveryListener({
        ...observed,
        ...admission,
        writableMountRoots: roots,
      });
      return listener;
    },
    async run(executable, args, assertWithinDeadline) {
      assertWithinDeadline();
      const bootstrap = executable === "/bin/launchctl";
      const expected = bootstrap
        ? ["bootstrap", context.identity.serviceDomain, context.identity.launcherPath]
        : [
            "serve",
            "--bg",
            `--https=${new URL(context.access.origin).port || "443"}`,
            `http://127.0.0.1:${context.access.listenPort}`,
          ];
      if (
        (!bootstrap && executable !== context.route.tailscale.path) ||
        !isDeepStrictEqual(args, expected)
      )
        throw new BootstrapRequestConflict(
          "Recovery native command differs from the exact activation",
        );
      const file = path.join(
        input.enrollmentStateDirectory,
        `maintenance-launcher-${input.stepId}-${input.generation}.json`,
      );
      const intent = MaintenanceLauncherIntentSchema.parse(
        readPrivateBootstrapConfiguration(file, input.account.uid),
      );
      const assertSelection = retainServiceFiles([
        file,
        context.identity.launcherPath,
        context.selectionPath,
      ]);
      const selected = await readMaintenanceLauncherStartup({
        setupFile: context.plan.candidate.setup.path,
        account: input.account,
      });
      if (
        selected.selection.version !== 1 ||
        selected.selection.intentId !== intent.id ||
        selected.planSha256 !== context.planSha256 ||
        selected.selection.slot !== "candidate"
      )
        throw new BootstrapRequestConflict(
          "Native recovery command has no exact retained selection",
        );
      withReservedMaintenanceLauncherEffect(
        {
          ...input,
          assertCurrent() {
            assertWithinDeadline();
            context.assertCurrent();
            assertSelection();
            if (input.assertCurrent() !== undefined || !routing)
              throw new BootstrapRequestConflict("Native recovery command custody is unavailable");
            routing.assertCurrent();
            inspectMaintenanceRecoveryRouting({
              access: context.access,
              previousServe,
              currentServe: routing.serve,
              backend: routing.backend,
            });
            for (const custody of custodies) custody.assertCurrent();
            if (bootstrap) assertAbsent(context.service, context.access.listenPort);
            else {
              if (!listener)
                throw new BootstrapRequestConflict("Recovery listener native proof is unavailable");
              listener.assertCurrent();
            }
          },
        },
        { file, intent },
        () => undefined,
      );
      await runRecoveryRegistrationCommand(executable, args, assertWithinDeadline);
    },
  };
}

function requireRegistrationHistory(
  input: RecoveryRegistrationInput,
  planSha256: string,
  identitySha256: string,
) {
  const state = new FileEnrollmentJournal(input.enrollmentStateDirectory).read();
  if (state.status !== "enrolled")
    throw new BootstrapRequestConflict("Recovery activation is not enrolled");
  const step = state.grant.manifest.steps.find((item) => item.id === input.stepId);
  const progress = state.activation.steps.find((item) => item.id === input.stepId);
  const target = state.grant.manifest.targets.find((item) => item.target === "recovery-launcher");
  if (
    state.grant.id !== input.grantId ||
    state.grant.manifest.installationId !== input.plan.identity.installationId ||
    step?.planSha256 !== planSha256 ||
    target?.identitySha256 !== identitySha256 ||
    !progress ||
    progress.status === "pending" ||
    progress.generation !== input.generation ||
    progress.grantRevision !== input.grantRevision
  )
    throw new BootstrapRequestConflict(
      "Native recovery construction differs from the retained activation",
    );
}
