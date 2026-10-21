import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BootstrapRequestConflict } from "../coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
} from "../coordinator-bootstrap-artifact.js";
import {
  retainMaintenancePublishedFile,
  retainMaintenancePublishedLink,
} from "../coordinator-bootstrap-maintenance-file-selection.js";
import { retainServiceFiles } from "../coordinator-bootstrap-maintenance-service-inspection.js";
import { readBoundedMaintenanceInspection } from "../coordinator-bootstrap-maintenance-service-native.js";
import { verifyRetainedProcessExited } from "../coordinator-bootstrap-service.js";
import { readInitialHostRetainedClaim } from "./host-supervisor-execution.js";
import { initialHostPublicationRecords } from "./host-supervisor-migration.js";
import {
  classifyInitialHostPublication,
  type HostRecoveryFileImage,
  type HostRecoverySelectorImage,
} from "./host-supervisor-recovery.js";

type RetainedClaim = ReturnType<typeof readInitialHostRetainedClaim>;
interface RecoveryInspectionInput {
  retained: RetainedClaim;
  signal: AbortSignal;
  reader: Parameters<typeof verifyRetainedProcessExited>[0];
  writableMountRoots: readonly string[];
  assertAnchorCurrent(): void;
  timeoutMs?: number;
}

let pendingRead: Promise<unknown> | undefined;

export function initialHostObservationPending() {
  return pendingRead !== undefined;
}

/** Anchor construction and candidate collection share this owner with partial
 * inspection. A deadline can discard a result without releasing its raw read. */
export function readInitialHostObservation<T>(read: () => Promise<T>): Promise<T> {
  if (pendingRead)
    return Promise.reject(
      new BootstrapRequestConflict("Host recovery inspection is still in progress"),
    );
  const pending = Promise.resolve().then(read);
  pendingRead = pending;
  const clear = () => {
    if (pendingRead === pending) pendingRead = undefined;
  };
  pending.then(clear, clear);
  return pending;
}

/** Partial publication is collected only after the exact effect child exited.
 * This proves a retained file image, never target absence or rollback authority. */
export async function inspectInitialHostRecoveryPublication(input: RecoveryInspectionInput) {
  const { retained, signal, reader } = input;
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new BootstrapRequestConflict("Host recovery inspection deadline is invalid");
  const context = structuredClone(retained.context);
  const roots = [...input.writableMountRoots];
  const anchor = input.assertAnchorCurrent;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (anchor() !== undefined || retained.assertCurrent() !== undefined)
      throw new BootstrapRequestConflict("Host recovery custody must be synchronous");
    if (!isDeepStrictEqual(context, retained.context))
      throw new BootstrapRequestConflict("Host recovery retained claim changed");
    signal.throwIfAborted();
  };
  const bound = { context, assertCurrent };
  return readBoundedMaintenanceInspection(
    (deadline) =>
      readInitialHostObservation(async () => {
        const collecting = AbortSignal.any([signal, deadline]);
        collecting.throwIfAborted();
        assertCurrent();
        await verifyRetainedProcessExited(reader, context.claim.executor);
        assertCurrent();
        collecting.throwIfAborted();
        return await collectPublication(bound, roots, signal, collecting);
      }),
    { timeoutMs, detail: "Host recovery publication inspection timed out" },
  );
}

async function collectPublication(
  retained: RetainedClaim,
  writableMountRoots: readonly string[],
  signal: AbortSignal,
  collecting: AbortSignal,
) {
  const { context } = retained;
  const directory = path.dirname(context.file);
  const records = initialHostPublicationRecords({
    ...context,
    enrollmentStateDirectory: directory,
  });
  const planFile = path.join(
    context.plan.precondition.identity.installationRoot,
    "initial-host-migrations",
    "plans",
    `${context.planSha256}.json`,
  );
  const paths = [
    planFile,
    context.intentFile,
    context.file,
    records.launcher.path,
    records.phase.file,
    records.launcherAttempt.file,
    records.selectorAttempt.file,
  ];
  // Capture every name before the first awaited file read. Missing names retain
  // their protected parent chain and may never become a substitute file.
  const captures = paths.map(retainFile);
  const selector = retainSelector(records.selector.path);
  await assertBootstrapPathsProtected(
    [
      ...paths.map((file) => path.dirname(file)),
      path.dirname(records.selector.path),
      ...(selector.image.state === "present" ? [selector.image.resolvedTarget] : []),
    ],
    writableMountRoots,
  );
  retained.assertCurrent();
  const images: HostRecoveryFileImage[] = [];
  for (const capture of captures) {
    collecting.throwIfAborted();
    images.push(await capture.read());
  }
  const [plan, intent, claim, launcher, phase, launcherAttempt, selectorAttempt] = images;
  const publication = classifyInitialHostPublication({
    enrollmentStateDirectory: directory,
    plan,
    intent,
    claim,
    launcher,
    phase,
    launcherAttempt,
    selectorAttempt,
    selector: selector.image,
  });
  const assertCurrent = () => {
    signal.throwIfAborted();
    retained.assertCurrent();
    for (const capture of captures) capture.assertCurrent();
    selector.assertCurrent();
    signal.throwIfAborted();
  };
  assertCurrent();
  collecting.throwIfAborted();
  return { publication, assertCurrent };
}

function missing(file: string) {
  try {
    lstatSync(file);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

function retainParent(file: string) {
  const directory = path.dirname(file);
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o022) !== 0)
    throw new BootstrapRequestConflict("Host recovery parent is not protected");
  return retainServiceFiles([directory]);
}

function retainFile(file: string) {
  const parent = retainParent(file);
  const absent = missing(file);
  const lifetime = absent ? parent : retainServiceFiles([file]);
  let contents: (() => void) | undefined;
  const assertCurrent = () => {
    parent();
    lifetime();
    if (missing(file) !== absent)
      throw new BootstrapRequestConflict("Host recovery file presence changed");
    contents?.();
    lifetime();
    parent();
  };
  return {
    async read(): Promise<HostRecoveryFileImage> {
      assertCurrent();
      if (absent) return { path: file, state: "absent" };
      const bytes = await readProtectedDocument(file);
      assertCurrent();
      contents = retainMaintenancePublishedFile(file, bytes);
      assertCurrent();
      return { path: file, state: "present", bytes };
    },
    assertCurrent,
  };
}

function retainSelector(file: string) {
  const parent = retainParent(file);
  if (missing(file)) {
    return {
      image: { path: file, state: "absent" } satisfies HostRecoverySelectorImage,
      assertCurrent() {
        parent();
        if (!missing(file)) throw new BootstrapRequestConflict("Host recovery selector appeared");
        parent();
      },
    };
  }
  const stat = lstatSync(file);
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.nlink !== 1)
    throw new BootstrapRequestConflict("Host recovery selector is not an owned symbolic link");
  const text = readlinkSync(file);
  const resolvedTarget = realpathSync(file);
  const assertLink = retainMaintenancePublishedLink(file, resolvedTarget);
  const assertTarget = retainParent(path.join(resolvedTarget, ".initial-host-recovery-probe"));
  const assertCurrent = () => {
    parent();
    assertLink();
    assertTarget();
    if (readlinkSync(file) !== text)
      throw new BootstrapRequestConflict("Host recovery selector text changed");
    assertLink();
    parent();
  };
  assertCurrent();
  return {
    image: {
      path: file,
      state: "present",
      text,
      resolvedTarget,
    } satisfies HostRecoverySelectorImage,
    assertCurrent,
  };
}
