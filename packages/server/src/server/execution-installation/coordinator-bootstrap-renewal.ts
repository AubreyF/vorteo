import { createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapPlan,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  assertRecoveredBootstrapBase,
  bootstrapRecoveryRelease,
  BootstrapRequestConflict,
  coordinatorPlanDigest,
  isCompletedBootstrap,
} from "./coordinator-bootstrap.js";
import {
  BootstrapAdmissionSetupSchema,
  inspectBootstrapWritableMountRoots,
  readBootstrapHostBinding,
  readPrivateBootstrapConfiguration,
  verifyBootstrapConfiguration,
} from "./coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";
import {
  createNativeBootstrapServiceReader,
  loadedCoordinatorPid,
  readBootstrapLauncher,
  verifyLoadedBootstrapService,
  type BootstrapServiceReader,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import {
  BootstrapExecutorRecordSchema,
  ProcessObservationSchema,
} from "./coordinator-bootstrap-process.js";
import { InstallationConfigSchema, type InstallationConfig } from "./config.js";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import { connectInstallationDaemon } from "./daemon.js";
import type { BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";

const FileSchema = z.strictObject({
  path: z.string().startsWith("/"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ReferenceSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
  generation: z.string().uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const BootstrapRenewalSchema = z.strictObject({
  version: z.literal(1),
  originalSetup: FileSchema,
  originalAdmission: FileSchema,
  terminal: ReferenceSchema,
  unpromotedFailure: ReferenceSchema.optional(),
  claimedRecovery: z
    .strictObject({
      recovery: ReferenceSchema,
      original: ReferenceSchema,
      fence: FileSchema,
      birth: FileSchema,
      setup: FileSchema,
    })
    .optional(),
  configuration: FileSchema,
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  source: FileSchema,
  hostProcess: ProcessObservationSchema,
  request: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.string().uuid(),
      planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
export type BootstrapRenewal = z.infer<typeof BootstrapRenewalSchema>;
type RunnerSetup = z.infer<typeof BootstrapRunnerSetupSchema>;
type Release = CoordinatorBootstrapPlan["candidate"];
const runnerRelative =
  "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-runner.js";
const workerRelative = "packages/server/dist/server/server/daemon-worker.js";
const coordinatorRelative = "packages/server/dist/server/server/execution-installation/main.js";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function executableIdentity(release: Release) {
  const { configuration: _configuration, launcher: _launcher, ...identity } = release;
  return identity;
}

function terminalRelease(request: CoordinatorBootstrapRequest) {
  if (request.execution?.stage === "succeeded") return request.plan.candidate;
  if (request.execution?.stage === "rolled_back") return bootstrapRecoveryRelease(request.plan);
  return request.plan.previous;
}

/** Sidecar predecessors remain unpromoted after their successor reaches main.
 * Order only exact recovery dependencies; never infer ancestry from timestamps. */
export function orderBootstrapHistory(
  records: CoordinatorBootstrapRequest[],
): CoordinatorBootstrapRequest[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length)
    throw new BootstrapRequestConflict("Duplicate bootstrap renewal request");
  const ordered: CoordinatorBootstrapRequest[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (record: CoordinatorBootstrapRequest) => {
    if (visited.has(record.id)) return;
    if (visiting.has(record.id))
      throw new BootstrapRequestConflict("Cyclic bootstrap renewal history");
    visiting.add(record.id);
    if (record.execution && record.plan.recoveredFrom) {
      const previous = assertRecoveredBootstrapBase(record.plan, records);
      if (previous) visit(previous);
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
  };
  for (const record of records) visit(record);
  return ordered;
}

/** Journal order and exact recovery references define the terminal chain.
 * Wall clocks, receipt filenames and the most recent successful entry do not. */
export function terminalBootstrapRelease(
  input: unknown,
  identity: { installationId: string; stateDirectory: string; service: string },
) {
  const records = orderBootstrapHistory(z.array(CoordinatorBootstrapRequestSchema).parse(input));
  const ids = new Set<string>();
  const generations = new Set<string>();
  let terminal: CoordinatorBootstrapRequest | undefined;
  let selected: Release | undefined;
  for (const request of records) {
    if (ids.has(request.id))
      throw new BootstrapRequestConflict("Duplicate bootstrap renewal request");
    ids.add(request.id);
    if (
      request.plan.installationId !== identity.installationId ||
      request.plan.service !== identity.service ||
      !isDeepStrictEqual(request.plan.state, {
        directory: identity.stateDirectory,
        restartJournal: path.join(identity.stateDirectory, "restart-jobs.json"),
        ownerSessions: path.join(identity.stateDirectory, "owner-sessions.json"),
      }) ||
      request.planSha256 !== coordinatorPlanDigest(request.plan)
    )
      throw new BootstrapRequestConflict("Bootstrap renewal history does not match installation");
    if (!request.execution) continue;
    if (request.status !== "approved" || generations.has(request.execution.generation))
      throw new BootstrapRequestConflict("Bootstrap renewal generation is ambiguous");
    generations.add(request.execution.generation);
    if (terminal && !isCompletedBootstrap(terminal)) {
      if (assertRecoveredBootstrapBase(request.plan, records) !== terminal)
        throw new BootstrapRequestConflict("Bootstrap renewal requires terminal recovery evidence");
    } else {
      if (
        request.plan.recoveredFrom &&
        assertRecoveredBootstrapBase(request.plan, records) !== terminal
      )
        throw new BootstrapRequestConflict(
          "Bootstrap renewal recovery does not extend its terminal chain",
        );
      if (
        selected &&
        !isDeepStrictEqual(executableIdentity(selected), executableIdentity(request.plan.previous))
      )
        throw new BootstrapRequestConflict("Bootstrap renewal release chain is ambiguous");
    }
    terminal = request;
    selected = terminalRelease(request);
  }
  if (!terminal) return undefined;
  if (!isCompletedBootstrap(terminal))
    throw new BootstrapRequestConflict(
      "Coordinator renewal is unavailable until its bootstrap recovery is terminal",
    );
  return { request: terminal, release: selected! };
}

/** Observe a protected canonical file, then digest-check the same bytes through
 * the normal prepared-file verifier. No receipt-selected path gains authority. */
async function observeFile(file: string, roots: readonly string[]) {
  await assertBootstrapPathsProtected([file], roots);
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.size > 1024n * 1024n)
    throw new BootstrapRequestConflict("Renewal document must be a bounded regular file");
  const identity = { path: file, sha256: sha(await readFile(file)) };
  await readBootstrapPreparedFile(identity, roots);
  const after = await lstat(file, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.ctimeNs !== after.ctimeNs ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new BootstrapRequestConflict("Renewal document changed during observation");
  return identity;
}

function reference(request: CoordinatorBootstrapRequest) {
  if (!request.execution)
    throw new BootstrapRequestConflict("Renewal terminal generation is missing");
  return {
    id: request.id,
    revision: request.revision,
    generation: request.execution.generation,
    planSha256: request.planSha256,
  };
}

function readCompatibleJournal(directory: string) {
  try {
    parseLifecycleJournal(
      readPrivateBootstrapConfiguration(
        path.join(directory, "restart-jobs.json"),
        process.getuid!(),
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new BootstrapRequestConflict(
      "Coordinator maintenance is unavailable: this Host cannot read the complete retained lifecycle history. Install a compatible Host reader; do not replay or rewrite the journal.",
    );
  }
}

export interface BootstrapRenewalPorts {
  reader: BootstrapServiceReader &
    Partial<Pick<NativeBootstrapServiceReader, "verifyProcessExited">>;
  hostPid(config: InstallationConfig): Promise<number>;
  writableMountRoots?(): Promise<string[]>;
}

async function nativePorts(
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: readonly string[],
): Promise<BootstrapRenewalPorts> {
  return {
    reader: await createNativeBootstrapServiceReader({ ...admission, writableMountRoots: roots }),
    async hostPid(config) {
      const client = await connectInstallationDaemon(config, "host");
      try {
        return (await client.getDaemonStatus({ timeout: 30_000 })).pid;
      } finally {
        await client.close();
      }
    },
  };
}

export function verifyRenewalHostProcess(input: {
  observed: unknown;
  pid: number;
  node: string;
  root: string;
  uid: number;
}) {
  const observed = ProcessObservationSchema.parse(input.observed);
  if (
    observed.pid !== input.pid ||
    observed.uid !== input.uid ||
    observed.parentPid <= 1 ||
    observed.executable !== input.node ||
    observed.argumentsSha256 !==
      sha(JSON.stringify([input.node, path.join(input.root, workerRelative)]))
  )
    throw new BootstrapRequestConflict(
      "Running Host does not match the selected immutable renewal release",
    );
  return observed;
}

type RenewalInput = Parameters<typeof deriveBootstrapRenewal>[0];
type RenewalAuthority = NonNullable<Awaited<ReturnType<typeof readRenewalAuthority>>>;

async function readRenewalAuthority(input: RenewalInput) {
  const uid = process.getuid!();
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setup.admissionSetupFile, uid),
  );
  const roots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  const anchor = readBootstrapHostBinding(admission.configurationFile, input.setup.daemonId);
  readCompatibleJournal(anchor.stateDirectory);
  const records = new FileBootstrapRequestJournal(anchor.stateDirectory).read();
  if (input.dispatchedRequest) {
    const own = records.find((item) => item.id === input.dispatchedRequest!.id);
    if (!own || own.status !== "approved" || own.planSha256 !== input.dispatchedRequest.planSha256)
      throw new BootstrapRequestConflict("Renewal dispatch approval changed");
  }
  const history = await readRenewalHistory(
    records.filter((item) => item.id !== input.dispatchedRequest?.id),
    {
      installationId: anchor.binding.installationId,
      service: anchor.binding.service,
      stateDirectory: anchor.stateDirectory,
    },
    roots,
  );
  const terminal = history.terminal;
  if (!terminal) return undefined;
  const selected = terminal.release;
  await verifyBootstrapReleaseArtifacts(selected, roots);
  const launcher = z
    .object({ Label: z.string(), ProgramArguments: z.tuple([z.string(), z.string(), z.string()]) })
    .parse(
      await readBootstrapLauncher(
        { path: admission.launcherFile, sha256: selected.launcher.sha256 },
        roots,
      ),
    );
  if (
    launcher.Label !== anchor.binding.service.split("/").at(-1) ||
    launcher.ProgramArguments[0] !== selected.node.path ||
    launcher.ProgramArguments[1] !== selected.entrypoint.path
  )
    throw new BootstrapRequestConflict(
      "Selected coordinator launcher does not match terminal renewal evidence",
    );
  const configurationFile = launcher.ProgramArguments[2];
  await readBootstrapPreparedFile(
    { path: configurationFile, sha256: selected.configuration.sha256 },
    roots,
  );
  const binding = readBootstrapHostBinding(configurationFile, input.setup.daemonId);
  if (
    binding.stateDirectory !== anchor.stateDirectory ||
    !isDeepStrictEqual(binding.binding, anchor.binding)
  )
    throw new BootstrapRequestConflict("Renewal changes the installation or owner binding");
  const config = InstallationConfigSchema.parse(
    readPrivateBootstrapConfiguration(configurationFile, uid),
  );
  verifyAdmissionDocker(config, admission);
  return {
    uid,
    admission,
    roots,
    anchor,
    terminal,
    selected,
    configurationFile,
    config,
    claimed: history.claimed,
    unpromotedFailure: history.unpromotedFailure,
  };
}

function verifyAdmissionDocker(
  config: InstallationConfig,
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>,
) {
  for (const binding of [config.nativeHelper, config.previewMonitor]) {
    if (
      binding &&
      (binding.docker !== admission.docker ||
        binding.socket !== admission.socket ||
        binding.containerId !== admission.containerId)
    )
      throw new BootstrapRequestConflict(
        "Current installation Docker identity differs from its protected admission anchor",
      );
  }
  const source = config.containerSourceUpdates;
  if (
    source &&
    (source.docker !== admission.docker || source.containerId !== admission.containerId)
  )
    throw new BootstrapRequestConflict(
      "Current source-update Docker identity differs from its protected admission anchor",
    );
}

async function readSelectedHost(
  config: InstallationConfig,
  moduleFile: string,
  configurationFile: string,
  roots: readonly string[],
) {
  const settings = config.sourceUpdates;
  const validation = config.host.startupValidation;
  if (!settings || !validation)
    throw new BootstrapRequestConflict("Renewal requires managed Host release selection");
  const root = await realpath(settings.currentReleaseLink);
  const releaseRoot = await realpath(settings.releaseRoot);
  if (
    !root.startsWith(releaseRoot + path.sep) ||
    validation.entrypoint !==
      path.join(
        settings.currentReleaseLink,
        "packages/server/dist/scripts/supervisor-entrypoint.js",
      )
  )
    throw new BootstrapRequestConflict(
      "Selected Host renewal release escaped its protected managed root",
    );
  const moduleRelative = path.relative(root, moduleFile);
  if (
    ![
      runnerRelative,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-launch.js",
      // Recovery initialization and admission reconstruct the same selected Host authority.
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-claimed-launch.js",
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-claimed-host.js",
    ].includes(moduleRelative) ||
    (await realpath(moduleFile)) !== moduleFile
  )
    throw new BootstrapRequestConflict("This Host is stale relative to selected renewal source");
  const node = await realpath(validation.node);
  if (node !== validation.node)
    throw new BootstrapRequestConflict("Renewal Node must have a canonical executable path");
  await assertBootstrapPathsProtected(
    [root, configurationFile, settings.currentReleaseLink, releaseRoot],
    roots,
  );
  return { root, node, settings };
}

async function verifyTerminalProcess(authority: RenewalAuthority, ports: BootstrapRenewalPorts) {
  const { uid, anchor, terminal, selected, configurationFile } = authority;
  const coordinatorPid = loadedCoordinatorPid(
    anchor.binding.service,
    await ports.reader.readService(anchor.binding.service),
  );
  const coordinator = ProcessObservationSchema.parse(
    await ports.reader.inspectProcess(coordinatorPid),
  );
  await verifyLoadedBootstrapService({
    plan: { ...terminal.request.plan, previous: selected, expectedProcess: coordinator },
    configurationFile,
    hostUid: uid,
    reader: ports.reader,
  });
  const record = BootstrapExecutorRecordSchema.parse(
    readPrivateBootstrapConfiguration(
      path.join(
        anchor.stateDirectory,
        `coordinator-executor-${terminal.request.execution!.generation}.json`,
      ),
      uid,
    ),
  );
  if (
    record.id !== terminal.request.id ||
    record.generation !== terminal.request.execution!.generation ||
    record.planSha256 !== terminal.request.planSha256 ||
    record.process?.pid !== record.pid ||
    record.process.uid !== uid ||
    record.process.executable !== selected.node.path ||
    record.auditToken?.[1] !== uid ||
    record.auditToken[5] !== record.pid
  )
    throw new BootstrapRequestConflict(
      "Terminal coordinator renewal executor receipt is incomplete",
    );
  await ports.reader.inspectProcess(record.pid).then(
    () => {
      throw new BootstrapRequestConflict("Terminal coordinator updater is still live");
    },
    async () => {
      // Native exit proof is mandatory; a failed identity observation is not exit.
      const native = ports.reader as BootstrapServiceReader & {
        verifyProcessExited?(pid: number): Promise<void>;
      };
      if (!native.verifyProcessExited)
        throw new BootstrapRequestConflict("Renewal executor exit proof is unavailable");
      await native.verifyProcessExited(record.pid);
    },
  );
  if (terminal.request.execution!.stage !== "resumed") {
    const transfer = z
      .strictObject({
        version: z.literal(1),
        requestId: z.string().uuid(),
        generation: z.string().uuid(),
        planSha256: z.string().regex(/^[a-f0-9]{64}$/),
        restartJournal: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        ownerSessions: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .parse(
        readPrivateBootstrapConfiguration(
          path.join(
            anchor.stateDirectory,
            `coordinator-transfer-${terminal.request.execution!.generation}.json`,
          ),
          uid,
        ),
      );
    if (
      transfer.requestId !== terminal.request.id ||
      transfer.generation !== terminal.request.execution!.generation ||
      transfer.planSha256 !== terminal.request.planSha256
    )
      throw new BootstrapRequestConflict("Terminal coordinator preservation receipt changed");
  }
}

async function readRenewalHistory(
  records: CoordinatorBootstrapRequest[],
  identity: { installationId: string; stateDirectory: string; service: string },
  roots: readonly string[],
) {
  const { readClaimedSuccessorEvidence } =
    await import("./coordinator-bootstrap-claimed-successor.js");
  records = orderBootstrapHistory(records);
  const latest = records.findLast((record) => record.execution);
  const { FileClaimedRecoveryReviewJournal } =
    await import("./coordinator-bootstrap-claimed-journal.js");
  const recoveryReviews = new FileClaimedRecoveryReviewJournal(
    identity.stateDirectory,
  ).readReviews();
  const hasReview = recoveryReviews.some((review) => review.plan.original.id === latest?.id);
  let unpromotedFailure: CoordinatorBootstrapRequest | undefined;
  let retained = records;
  if (latest?.execution?.stage === "recovery_required" && !hasReview) {
    new FileBootstrapRequestJournal(identity.stateDirectory).verifyUnpromotedFailure(latest);
    unpromotedFailure = latest;
    retained = records.filter((record) => record.id !== latest.id);
  }
  const claimed = await readClaimedSuccessorEvidence({ records: retained, identity, roots });
  const terminal = claimed?.terminal ?? terminalBootstrapRelease(retained, identity);
  if (unpromotedFailure) {
    if (!terminal)
      throw new BootstrapRequestConflict("Unpromoted failure has no retained authority");
    const expected = claimed?.recoveredFrom;
    if (expected && !isDeepStrictEqual(unpromotedFailure.plan.recoveredFrom, expected))
      throw new BootstrapRequestConflict("Unpromoted failure recovery ancestry changed");
    const previous = unpromotedFailure.plan.previous;
    const selected = terminal.release;
    if (!isDeepStrictEqual(executableIdentity(previous), executableIdentity(selected)))
      throw new BootstrapRequestConflict("Unpromoted failure previous release changed");
    assertRecoveredBootstrapBase(unpromotedFailure.plan, retained);
  }
  return { terminal, claimed, unpromotedFailure };
}

async function verifyStableRenewal(
  input: RenewalInput,
  authority: RenewalAuthority,
  setup: RunnerSetup,
  pid: number,
  ports: BootstrapRenewalPorts,
  settings: NonNullable<InstallationConfig["sourceUpdates"]>,
) {
  const { uid, admission, roots, anchor, selected, config } = authority;
  const root = setup.runtimeDirectory;
  const renewal = setup.renewal!;
  const hostProcess = renewal.hostProcess;
  if (
    !isDeepStrictEqual(hostProcess, await ports.reader.inspectProcess(pid)) ||
    (input.hostPid === undefined && pid !== (await ports.hostPid(config))) ||
    root !== (await realpath(settings.currentReleaseLink))
  )
    throw new BootstrapRequestConflict("Host renewal identity changed during reconstruction");
  if (
    !isDeepStrictEqual(input.setup, readPrivateBootstrapConfiguration(input.setupFile, uid)) ||
    !isDeepStrictEqual(
      admission,
      BootstrapAdmissionSetupSchema.parse(
        readPrivateBootstrapConfiguration(input.setup.admissionSetupFile, uid),
      ),
    )
  )
    throw new BootstrapRequestConflict("Renewal anchor changed during reconstruction");
  const finalRoots = await (input.ports?.writableMountRoots?.() ??
    inspectBootstrapWritableMountRoots(admission));
  if (!isDeepStrictEqual(roots, finalRoots))
    throw new BootstrapRequestConflict("Renewal writable mounts changed during reconstruction");
  await readBootstrapLauncher(
    { path: admission.launcherFile, sha256: selected.launcher.sha256 },
    finalRoots,
  );
  await readBootstrapPreparedFile(renewal.configuration, finalRoots);
  const finalHistory = await readRenewalHistory(
    new FileBootstrapRequestJournal(anchor.stateDirectory)
      .read()
      .filter((item) => item.id !== input.dispatchedRequest?.id),
    {
      installationId: anchor.binding.installationId,
      service: anchor.binding.service,
      stateDirectory: anchor.stateDirectory,
    },
    finalRoots,
  );
  if (
    !finalHistory.terminal ||
    !isDeepStrictEqual(reference(finalHistory.terminal.request), renewal.terminal) ||
    !isDeepStrictEqual(finalHistory.claimed?.witness, renewal.claimedRecovery) ||
    !isDeepStrictEqual(
      finalHistory.unpromotedFailure && reference(finalHistory.unpromotedFailure),
      renewal.unpromotedFailure,
    )
  )
    throw new BootstrapRequestConflict("Renewal terminal history changed during reconstruction");
}

/** Reconstruct only from the fixed private anchor, terminal history and actual
 * selected Host. Initial admission supplies its own PID before the listener opens. */
export async function deriveBootstrapRenewal(input: {
  setupFile: string;
  setup: RunnerSetup;
  moduleFile: string;
  hostPid?: number;
  ports?: BootstrapRenewalPorts;
  dispatchedRequest?: { id: string; planSha256: string };
}): Promise<RunnerSetup | undefined> {
  const authority = await readRenewalAuthority(input);
  if (!authority) return undefined;
  const { uid, admission, roots, terminal, selected, configurationFile, config } = authority;
  const { root, node, settings } = await readSelectedHost(
    config,
    input.moduleFile,
    configurationFile,
    roots,
  );
  const ports = input.ports ?? (await nativePorts(admission, roots));
  await verifyTerminalProcess(authority, ports);
  if (authority.unpromotedFailure) {
    await verifyLoadedBootstrapService({
      plan: authority.unpromotedFailure.plan,
      configurationFile,
      hostUid: uid,
      reader: ports.reader,
    });
  }
  if (authority.claimed) {
    const { verifyClaimedSuccessorExit } =
      await import("./coordinator-bootstrap-claimed-successor.js");
    await verifyClaimedSuccessorExit(authority.claimed, ports.reader);
    const retained = authority.claimed.setup.renewal;
    if (
      retained.originalSetup.path !== input.setupFile ||
      retained.originalAdmission.path !== input.setup.admissionSetupFile
    )
      throw new BootstrapRequestConflict("Claimed recovery belongs to another renewal anchor");
    await readBootstrapPreparedFile(retained.originalSetup, roots);
    await readBootstrapPreparedFile(retained.originalAdmission, roots);
  }
  const pid = input.hostPid ?? (await ports.hostPid(config));
  const hostProcess = verifyRenewalHostProcess({
    observed: await ports.reader.inspectProcess(pid),
    pid,
    node,
    root,
    uid,
  });
  const source = await observeFile(path.join(root, ".installation-source.json"), roots);
  const receipt = z
    .object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(JSON.parse((await readBootstrapPreparedFile(source, roots)).toString("utf8")));
  const renewal = BootstrapRenewalSchema.parse({
    version: 1,
    originalSetup: await observeFile(input.setupFile, roots),
    originalAdmission: await observeFile(input.setup.admissionSetupFile, roots),
    terminal: reference(terminal.request),
    ...(authority.claimed ? { claimedRecovery: authority.claimed.witness } : {}),
    ...(authority.unpromotedFailure
      ? { unpromotedFailure: reference(authority.unpromotedFailure) }
      : {}),
    configuration: { path: configurationFile, sha256: selected.configuration.sha256 },
    sourceCommit: receipt.sourceCommit,
    source,
    hostProcess,
  });
  const setup: RunnerSetup = {
    ...input.setup,
    node: await observeExecutable(node, roots),
    runtimeDirectory: root,
    runtimeSha256: await digestBootstrapArtifact(root),
    entrypoint: await observeFile(path.join(root, runnerRelative), roots),
    ownerLauncher: await observeFile(path.join(root, "scripts/run-coordinator-owner.py"), roots),
    ownershipVerifier: await observeFile(
      path.join(root, "scripts/verify-coordinator-owner.py"),
      roots,
    ),
    renewal,
  };
  await verifyStableRenewal(input, authority, setup, pid, ports, settings);
  return setup;
}

async function observeExecutable(file: string, roots: readonly string[]) {
  // Node exceeds the bounded document limit. Artifact traversal verifies ownership
  // and mount protection; its executable digest is separately bound here.
  await assertBootstrapPathsProtected([file], roots);
  const before = await lstat(file, { bigint: true });
  if (
    (await realpath(file)) !== file ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.uid !== BigInt(process.getuid!()) ||
    (before.mode & 0o122n) !== 0o100n
  )
    throw new BootstrapRequestConflict("Renewal Node must be an owned protected executable");
  const identity = { path: file, sha256: sha(await readFile(file)) };
  const after = await lstat(file, { bigint: true });
  if (
    before.ino !== after.ino ||
    before.ctimeNs !== after.ctimeNs ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new BootstrapRequestConflict("Renewal Node changed during verification");
  return identity;
}

/** Renewed runners retain the selected Host reader and validate declared configuration
 * changes through the maintenance validator. Compatible rollback retains the old configuration. */
export async function verifyRenewalPlan(setup: RunnerSetup, plan: CoordinatorBootstrapPlan) {
  if (setup.maintenance) {
    const { verifyMaintenanceRunnerPlan } =
      await import("./coordinator-bootstrap-maintenance-runtime.js");
    await verifyMaintenanceRunnerPlan(setup, plan);
    return;
  }
  if (!setup.renewal) return;
  const renewal = setup.renewal;
  if (
    renewal.unpromotedFailure &&
    !isDeepStrictEqual(plan.recoveredFrom, renewal.unpromotedFailure)
  )
    throw new BootstrapRequestConflict("Renewal must reference the exact unpromoted failure");
  if (
    !renewal.unpromotedFailure &&
    renewal.claimedRecovery &&
    !isDeepStrictEqual(plan.recoveredFrom, renewal.claimedRecovery.original)
  )
    throw new BootstrapRequestConflict("Renewal must reference the exact recovered claim");
  if (plan.automaticRecovery !== "restore-compatible" || !plan.compatibleRecovery)
    throw new BootstrapRequestConflict("Renewal requires an exact compatible recovery reader");
  for (const release of [plan.candidate, plan.compatibleRecovery]) {
    if (
      release.directory !== setup.runtimeDirectory ||
      release.sourceCommit !== renewal.sourceCommit ||
      release.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(release.node, setup.node) ||
      release.entrypoint.path !== path.join(setup.runtimeDirectory, coordinatorRelative)
    )
      throw new BootstrapRequestConflict(
        "Renewal candidate and recovery must use the selected Host reader",
      );
  }

  if (
    plan.nativeHelperConfiguration !== undefined ||
    plan.previewMonitorConfiguration !== undefined ||
    plan.hostRequestsAfter !== null
  )
    throw new BootstrapRequestConflict(
      "Runner renewal cannot change policy, helper or monitor configuration",
    );
  verifyBootstrapConfiguration({
    plan,
    configurationFile: renewal.configuration.path,
    daemonId: setup.daemonId,
  });
}

/** Verify a completed repair's retained runtime without granting current dispatch authority. */
export async function verifyHistoricalRenewal(setup: RunnerSetup) {
  await verifyRenewalEvidence({ setup, watchdog: true, historical: true });
}

/** Watchdogs reconstruct from their retained canonical runtime and exact request,
 * never from a later Host selection. Original setup/admission remain untouched. */
export async function verifyRetainedRenewal(
  setup: RunnerSetup,
  request?: CoordinatorBootstrapRequest,
  watchdog = false,
) {
  await verifyRenewalEvidence({ setup, request, watchdog, historical: false });
}

async function verifyRenewalEvidence(input: {
  setup: RunnerSetup;
  request?: CoordinatorBootstrapRequest;
  watchdog: boolean;
  historical: boolean;
}) {
  const { setup, request, watchdog, historical } = input;
  if (setup.maintenance) {
    const { verifyMaintenanceRetainedRuntime } =
      await import("./coordinator-bootstrap-maintenance-runtime.js");
    await verifyMaintenanceRetainedRuntime(input);
    return;
  }
  const renewal = setup.renewal;
  if (!renewal) return;
  const uid = process.getuid!();
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
  );
  const roots = await inspectBootstrapWritableMountRoots(admission);
  for (const file of [
    renewal.originalSetup,
    renewal.originalAdmission,
    renewal.configuration,
    setup.entrypoint,
    setup.ownerLauncher,
    setup.ownershipVerifier,
  ])
    await readBootstrapPreparedFile(file, roots);
  if (
    renewal.originalAdmission.path !== setup.admissionSetupFile ||
    (await observeExecutable(setup.node.path, roots)).sha256 !== setup.node.sha256 ||
    (!watchdog && (await digestBootstrapArtifact(setup.runtimeDirectory)) !== setup.runtimeSha256)
  )
    throw new BootstrapRequestConflict("Retained renewal runtime changed");
  const source = z
    .object({ sourceCommit: z.string() })
    .parse(JSON.parse((await readBootstrapPreparedFile(renewal.source, roots)).toString("utf8")));
  if (
    source.sourceCommit !== renewal.sourceCommit ||
    renewal.source.path !== path.join(setup.runtimeDirectory, ".installation-source.json")
  )
    throw new BootstrapRequestConflict("Retained renewal source receipt changed");
  const original = z
    .object({ daemonId: z.string(), admissionSetupFile: z.string() })
    .parse(readPrivateBootstrapConfiguration(renewal.originalSetup.path, uid));
  if (
    original.daemonId !== setup.daemonId ||
    original.admissionSetupFile !== setup.admissionSetupFile
  )
    throw new BootstrapRequestConflict("Retained renewal anchor identity changed");
  const anchor = readBootstrapHostBinding(admission.configurationFile, setup.daemonId);
  readCompatibleJournal(anchor.stateDirectory);
  if (
    request &&
    (!renewal.request ||
      renewal.request.id !== request.id ||
      renewal.request.planSha256 !== request.planSha256)
  )
    throw new BootstrapRequestConflict("Retained renewal belongs to a different exact approval");
  const completeRecords = new FileBootstrapRequestJournal(anchor.stateDirectory).read();
  const retainedRecords = historical
    ? historicalRenewalRecords(completeRecords, renewal)
    : completeRecords;
  const records = retainedRecords.filter((item) => item.id !== renewal.request?.id);
  const history = await readRenewalHistory(
    records,
    {
      installationId: anchor.binding.installationId,
      stateDirectory: anchor.stateDirectory,
      service: anchor.binding.service,
    },
    roots,
  );
  const terminal = await verifyRetainedRecoveryHistory(history, renewal, admission, roots, request);
  await verifyRetainedAuthority(setup, terminal.release, roots);
}

/** Historical provenance ends at its pinned authority, never at a newer claim.
 * Current executor and watchdog admission must use the complete journal. */
function historicalRenewalRecords(
  records: CoordinatorBootstrapRequest[],
  renewal: BootstrapRenewal,
) {
  const boundary =
    renewal.unpromotedFailure ?? renewal.claimedRecovery?.original ?? renewal.terminal;
  const matches = records.filter((record) => record.id === boundary.id);
  if (
    matches.length !== 1 ||
    !matches[0].execution ||
    !isDeepStrictEqual(reference(matches[0]), boundary)
  )
    throw new BootstrapRequestConflict("Historical renewal boundary changed");
  return records.slice(0, records.indexOf(matches[0]) + 1);
}

async function verifyRetainedAuthority(
  setup: RunnerSetup,
  release: Release,
  roots: readonly string[],
) {
  const renewal = setup.renewal!;
  const uid = process.getuid!();
  const launcher = z
    .object({ ProgramArguments: z.tuple([z.string(), z.string(), z.string()]) })
    .parse(await readBootstrapLauncher(release.launcher, roots));
  if (
    launcher.ProgramArguments[2] !== renewal.configuration.path ||
    release.configuration.sha256 !== renewal.configuration.sha256 ||
    setup.entrypoint.path !== path.join(setup.runtimeDirectory, runnerRelative) ||
    setup.ownerLauncher.path !==
      path.join(setup.runtimeDirectory, "scripts/run-coordinator-owner.py") ||
    setup.ownershipVerifier.path !==
      path.join(setup.runtimeDirectory, "scripts/verify-coordinator-owner.py")
  )
    throw new BootstrapRequestConflict(
      "Retained renewal context does not reconstruct its terminal authority",
    );
  verifyRenewalHostProcess({
    observed: renewal.hostProcess,
    pid: renewal.hostProcess.pid,
    node: setup.node.path,
    root: setup.runtimeDirectory,
    uid,
  });
}

/** Create once, fsync, and reconcile an uncertain response by byte identity.
 * This is a new execution snapshot, not a rebind of the installed setup. */
export function persistRenewalSetup(
  directory: string,
  setup: RunnerSetup,
  request: CoordinatorBootstrapRequest,
) {
  if (!setup.renewal)
    throw new BootstrapRequestConflict("Renewal snapshot requires verified context");
  if (
    readBootstrapHostBinding(setup.renewal.configuration.path, setup.daemonId).stateDirectory !==
      directory ||
    request.status !== "approved" ||
    request.execution
  )
    throw new BootstrapRequestConflict(
      "Renewal snapshot requires an exact undispatched installation approval",
    );
  const file = path.join(directory, `coordinator-renewal-${request.id}-${request.revision}.json`);
  const snapshot = {
    ...setup,
    renewal: {
      ...setup.renewal,
      request: { id: request.id, revision: request.revision, planSha256: request.planSha256 },
    },
  };
  const bytes = JSON.stringify(snapshot);
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    if (!isDeepStrictEqual(readPrivateBootstrapConfiguration(file, process.getuid!()), snapshot))
      throw new BootstrapRequestConflict(
        "Existing renewal snapshot differs; do not replay dispatch",
      );
    const existing = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!readFileSync(existing).equals(Buffer.from(bytes)))
        throw new BootstrapRequestConflict(
          "Existing renewal snapshot bytes changed; do not replay dispatch",
        );
      fsyncSync(existing);
    } finally {
      closeSync(existing);
    }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    return file;
  }
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return file;
}

export const RenewalGenerationSchema = z.strictObject({
  version: z.literal(1),
  snapshot: FileSchema,
  approval: z.strictObject({
    id: z.string().uuid(),
    revision: z.string().uuid(),
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  generation: z.string().uuid(),
});

export async function retainRenewalGeneration(input: {
  setup: RunnerSetup;
  setupFile: string;
  request: CoordinatorBootstrapRequest;
  watchdog: boolean;
}) {
  const approval = input.setup.renewal?.request;
  if (!approval) throw new BootstrapRequestConflict("Renewal approval snapshot is missing");
  const request = input.request;
  if (
    !request.execution ||
    request.id !== approval.id ||
    request.planSha256 !== approval.planSha256
  )
    throw new BootstrapRequestConflict("Renewal generation differs from its approval");
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(input.setup.admissionSetupFile, process.getuid!()),
  );
  const snapshot = await observeFile(
    input.setupFile,
    await inspectBootstrapWritableMountRoots(admission),
  );
  const expected = RenewalGenerationSchema.parse({
    version: 1,
    snapshot,
    approval,
    generation: request.execution.generation,
  });
  const file = path.join(
    request.plan.state.directory,
    `coordinator-renewal-generation-${request.execution.generation}.json`,
  );
  if (!input.watchdog) {
    const descriptor = openSync(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, JSON.stringify(expected));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const parent = openSync(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  if (
    !isDeepStrictEqual(
      RenewalGenerationSchema.parse(readPrivateBootstrapConfiguration(file, process.getuid!())),
      expected,
    )
  )
    throw new BootstrapRequestConflict("Renewal snapshot substitution or generation mismatch");
}

async function verifyRetainedRecoveryHistory(
  history: Awaited<ReturnType<typeof readRenewalHistory>>,
  renewal: BootstrapRenewal,
  admission: z.infer<typeof BootstrapAdmissionSetupSchema>,
  roots: readonly string[],
  request?: CoordinatorBootstrapRequest,
) {
  const terminal = history.terminal;
  if (
    !terminal ||
    !isDeepStrictEqual(reference(terminal.request), renewal.terminal) ||
    !isDeepStrictEqual(history.claimed?.witness, renewal.claimedRecovery) ||
    !isDeepStrictEqual(
      history.unpromotedFailure && reference(history.unpromotedFailure),
      renewal.unpromotedFailure,
    )
  )
    throw new BootstrapRequestConflict("Retained renewal terminal history changed");
  if (history.claimed) {
    const { verifyClaimedSuccessorExit } =
      await import("./coordinator-bootstrap-claimed-successor.js");
    const reader = await createNativeBootstrapServiceReader({
      ...admission,
      writableMountRoots: roots,
    });
    await verifyClaimedSuccessorExit(history.claimed, reader);
    if (
      request &&
      !renewal.unpromotedFailure &&
      !isDeepStrictEqual(request.plan.recoveredFrom, history.claimed.recoveredFrom)
    )
      throw new BootstrapRequestConflict(
        "Retained successor does not reference the recovered claim",
      );
  }
  if (
    request &&
    renewal.unpromotedFailure &&
    !isDeepStrictEqual(request.plan.recoveredFrom, renewal.unpromotedFailure)
  )
    throw new BootstrapRequestConflict(
      "Retained successor does not reference the unpromoted failure",
    );
  return terminal;
}
