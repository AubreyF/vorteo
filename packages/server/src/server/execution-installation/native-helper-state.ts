import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { NativeHelperPlan } from "@getpaseo/protocol/native-helper-maintenance";
import {
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";
import { NativeHelperArtifactError } from "./native-helper-artifact.js";

export interface HelperStateAdmission {
  home: string;
  installationId: string;
  writableMountRoots: readonly string[];
}

async function statIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

/** Check existing parents even when the final installation path does not exist.
 * Mount inventory and home come from Host configuration, never from the request. */
export async function verifyDestination(
  file: string,
  admission: HelperStateAdmission,
): Promise<void> {
  if (path.resolve(file) !== file || !file.startsWith(admission.home + path.sep))
    throw new NativeHelperArtifactError("Helper destination must use its canonical Host path");
  for (const mount of admission.writableMountRoots) {
    if (overlaps(file, await realpath(mount)))
      throw new NativeHelperArtifactError("Helper destination overlaps a writable container mount");
  }
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await statIfPresent(current);
    if (stat) {
      if (
        (await realpath(current)) !== current ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0
      )
        throw new NativeHelperArtifactError("Helper destination has an unsafe Host parent");
      if (current !== file && !stat.isDirectory())
        throw new NativeHelperArtifactError("Helper destination parent must be a directory");
    }
    if (current === admission.home) break;
  }
}

export async function verifyPrivateState(
  file: string,
  digest: string | null,
  mounts: readonly string[],
): Promise<void> {
  const stat = await statIfPresent(file);
  if (digest === null) {
    if (stat)
      throw new NativeHelperArtifactError("Helper private state appeared after preparation");
    return;
  }
  if (!stat || !stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new NativeHelperArtifactError(
      "Helper private state is missing or has unsafe permissions",
    );
  await readBootstrapPreparedFile({ path: file, sha256: digest }, mounts);
  const after = await lstat(file);
  if ((after.mode & 0o777) !== 0o600)
    throw new NativeHelperArtifactError("Helper private state permissions changed");
}

async function verifyRetainedBundle(
  selected: string,
  retained: NativeHelperPlan["retainedRollback"],
  plan: NativeHelperPlan,
  admission: HelperStateAdmission,
): Promise<void> {
  const present = await statIfPresent(selected);
  if (!retained) {
    if (present)
      throw new NativeHelperArtifactError("Unrecorded helper release requires preservation");
    return;
  }
  if (!present) throw new NativeHelperArtifactError("Previous helper selection disappeared");
  const mutablePaths = [
    plan.destination.application,
    plan.destination.runtime,
    plan.destination.application + ".previous",
    plan.destination.application + ".staged",
  ];
  if (mutablePaths.some((file) => overlaps(file, retained.directory)))
    throw new NativeHelperArtifactError(
      "Helper rollback must be retained outside mutable installation paths",
    );
  await verifyDestination(retained.directory, admission);
  if (
    (await digestBootstrapArtifact(retained.directory)) !== retained.artifactSha256 ||
    (await digestBootstrapArtifact(selected)) !== retained.artifactSha256
  )
    throw new NativeHelperArtifactError("Helper selection or retained rollback changed");
}

/** Read-only base check, repeated before dispatch. No state values leave admission. */
export async function verifyNativeHelperState(
  plan: NativeHelperPlan,
  admission: HelperStateAdmission,
): Promise<void> {
  if (plan.installationId !== admission.installationId)
    throw new NativeHelperArtifactError("Helper plan belongs to another installation");
  if (
    plan.operation === "native-helper-rollback" &&
    (!plan.previous ||
      !plan.retainedRollback ||
      plan.candidate.directory !== plan.retainedRollback.directory ||
      plan.candidate.artifactSha256 !== plan.retainedRollback.artifactSha256)
  )
    throw new NativeHelperArtifactError(
      "Rollback requires the exact independently retained previous release",
    );
  const application = path.join(admission.home, "Applications/Vorteo Permission Helper.app");
  const runtime = path.join(admission.home, ".local/share/vorteo-macos-helper");
  if (plan.destination.application !== application || plan.destination.runtime !== runtime)
    throw new NativeHelperArtifactError("Helper plan must use fixed installation destinations");
  const mutablePaths = [application, runtime, application + ".previous", application + ".staged"];
  for (const prepared of [plan.candidate.directory, plan.tooling.directory]) {
    if (mutablePaths.some((file) => overlaps(file, prepared)))
      throw new NativeHelperArtifactError(
        "Prepared helper artifacts overlap mutable installation paths",
      );
  }
  await verifyDestination(application, admission);
  await verifyDestination(runtime, admission);
  const runtimeStat = await statIfPresent(runtime);
  if (runtimeStat && (!runtimeStat.isDirectory() || (runtimeStat.mode & 0o777) !== 0o700))
    throw new NativeHelperArtifactError("Helper runtime requires a private directory");
  for (const suffix of [".staged", ".install-lock"]) {
    if (await statIfPresent(application + suffix))
      throw new NativeHelperArtifactError(
        "Previous helper installation needs inspection before new work",
      );
  }
  const state = plan.expectedState;
  await verifyPrivateState(
    path.join(runtime, "config.json"),
    state.configurationSha256,
    admission.writableMountRoots,
  );
  await verifyPrivateState(
    path.join(runtime, "browser-policy.json"),
    state.policySha256,
    admission.writableMountRoots,
  );
  await verifyPrivateState(
    path.join(runtime, "installation.json"),
    state.installationReceiptSha256,
    admission.writableMountRoots,
  );
  if (Boolean(plan.previous) !== Boolean(state.configurationSha256))
    throw new NativeHelperArtifactError("Helper selection and private configuration disagree");
  await verifyRetainedBundle(application, plan.previous, plan, admission);
  await verifyRetainedBundle(application + ".previous", plan.retainedRollback, plan, admission);
}
