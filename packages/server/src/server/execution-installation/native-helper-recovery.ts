import path from "node:path";
import { inspectInstallerPresence } from "./native-helper-installer-process.js";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { NativeHelperJob } from "@getpaseo/protocol/native-helper-maintenance";
import { NativeHelperArtifactError } from "./native-helper-artifact.js";
import {
  digestBootstrapArtifact,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { verifyDestination, type HelperStateAdmission } from "./native-helper-state.js";

export interface RecoveryFile {
  state: "absent" | "present" | "unreadable";
  sha256?: string;
}

/** Observation only. Neither an absent lock nor matching bytes authorizes replay
 * or proves that a previously dispatched installer has stopped. */
export async function inspectNativeHelperRecovery(
  job: NativeHelperJob,
  admission: HelperStateAdmission,
) {
  const digest = createHash("sha256").update(JSON.stringify(job.plan)).digest("hex");
  const application = path.join(admission.home, "Applications/Vorteo Permission Helper.app");
  const runtime = path.join(admission.home, ".local/share/vorteo-macos-helper");
  if (
    job.stage !== "recovery_required" ||
    job.planSha256 !== digest ||
    job.plan.installationId !== admission.installationId ||
    job.plan.destination.application !== application ||
    job.plan.destination.runtime !== runtime
  )
    throw new NativeHelperArtifactError(
      "Recovery inspection requires the exact interrupted helper request",
    );

  async function observe(file: string, kind: "bundle" | "private" | "lock"): Promise<RecoveryFile> {
    try {
      await verifyDestination(file, admission);
    } catch {
      return { state: "unreadable" };
    }
    try {
      const stat = await lstat(file);
      if (kind === "lock") return { state: "present" };
      if (kind === "bundle")
        return { state: "present", sha256: await digestBootstrapArtifact(file) };
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) return { state: "unreadable" };
      const bytes = await readProtectedDocument(file);
      return { state: "present", sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { state: "absent" };
      // Private filesystem failures are deliberately reduced to a state, not
      // exposed as paths, document contents or permission-repair instructions.
      return { state: "unreadable" };
    }
  }
  return {
    requestId: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
    installerPid: job.installerPid ?? null,
    installerExit: job.installerExit ?? null,
    installerState: "unverified" as const,
    installerPidPresence: job.installerPid
      ? await inspectInstallerPresence(job.installerPid)
      : { state: "unverified" as const },
    observedAt: new Date().toISOString(),
    application: await observe(application, "bundle"),
    previous: await observe(application + ".previous", "bundle"),
    staged: await observe(application + ".staged", "bundle"),
    lock: await observe(application + ".install-lock", "lock"),
    configuration: await observe(path.join(runtime, "config.json"), "private"),
    policy: await observe(path.join(runtime, "browser-policy.json"), "private"),
    receipt: await observe(path.join(runtime, "installation.json"), "private"),
  };
}
