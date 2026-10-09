import type { NativeHelperInstallerExit } from "@getpaseo/protocol/native-helper-maintenance";
import path from "node:path";
import { inspectNativeHelperRecovery } from "./native-helper-recovery.js";
import { lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  NativeHelperPlan,
  NativeHelperJob,
} from "@getpaseo/protocol/native-helper-maintenance";
import { verifyNativeHelperState, verifyPrivateState } from "./native-helper-state.js";
import {
  verifyNativeHelperTooling,
  verifyNativeHelperApplication,
  NativeHelperArtifactError,
  type NativeHelperSignatureTools,
} from "./native-helper-artifact.js";
import {
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { runNativeHelperCommand } from "./native-helper-command.js";
import {
  NativeHelperIdentitySchema,
  inspectNativeHelperProcess,
  verifyNativeHelperReadiness,
  type NativeHelperIdentity,
} from "./native-helper-process.js";

interface HelperInstallationContext {
  home: string;
  installationId: string;
  writableMountRoots(): Promise<readonly string[]>;
}
interface HelperExecutionTools {
  command: typeof runNativeHelperCommand;
  inspectProcess: typeof inspectNativeHelperProcess;
  signatures?: NativeHelperSignatureTools;
}
const nativeTools: HelperExecutionTools = {
  command: runNativeHelperCommand,
  inspectProcess: inspectNativeHelperProcess,
};
const ExistingStatusSchema = z.object({
  ok: z.boolean(),
  code: z.string(),
  protocolVersion: z.literal(2),
  process: NativeHelperIdentitySchema.optional(),
});

/** Construct only from protected Host configuration, never from submission fields. */
export function createNativeHelperExecutor(
  context: HelperInstallationContext,
  tools: HelperExecutionTools = nativeTools,
) {
  async function admission() {
    return {
      home: context.home,
      installationId: context.installationId,
      writableMountRoots: await context.writableMountRoots(),
    };
  }
  async function validateHelperPlan(plan: NativeHelperPlan): Promise<void> {
    const settings = await admission();
    await verifyNativeHelperState(plan, settings);
    await verifyNativeHelperTooling(plan, settings.writableMountRoots);
    await verifyNativeHelperApplication(
      plan.candidate,
      settings.writableMountRoots,
      tools.signatures,
    );
    if (plan.previous)
      await verifyNativeHelperApplication(
        plan.previous,
        settings.writableMountRoots,
        tools.signatures,
      );
    await verifyNativeHelperState(plan, await admission());
  }
  async function readStatus(plan: NativeHelperPlan): Promise<unknown> {
    const output = await tools.command({
      plan,
      home: context.home,
      operation: "status",
      recordInstallerExit: () => {
        throw new NativeHelperArtifactError("Status cannot record installer exit");
      },
      recordInstaller: () => {
        throw new NativeHelperArtifactError("Status must not start an installer");
      },
    });
    return JSON.parse(output);
  }
  async function previousIdentity(
    plan: NativeHelperPlan,
  ): Promise<NativeHelperIdentity | undefined> {
    if (!plan.previous) return undefined;
    const reply = ExistingStatusSchema.parse(await readStatus(plan));
    if (!reply.ok) {
      if (reply.code === "helper_unavailable") return undefined;
      throw new NativeHelperArtifactError("Cannot verify the previous helper status");
    }
    // A legacy helper cannot satisfy the new post-install readiness check. Its
    // absence of process metadata must not prevent installing that capability.
    if (!reply.process) return undefined;
    return verifyNativeHelperReadiness({
      readStatus: () => readStatus(plan),
      inspectProcess: tools.inspectProcess,
      expectedExecutable: path.join(
        plan.destination.application,
        "Contents/MacOS/VorteoPermissionHelper",
      ),
      expectedUid: process.getuid!(),
    });
  }
  async function installHelper(
    job: NativeHelperJob,
    reportPhase: (stage: "installing" | "verifying") => void,
    recordInstaller: (pid: number) => void,
    recordInstallerExit: (exit: NativeHelperInstallerExit) => void,
    recordPrevious: (previous: NativeHelperIdentity | null) => void,
  ): Promise<string> {
    const digest = createHash("sha256").update(JSON.stringify(job.plan)).digest("hex");
    if (job.status !== "running" || job.stage !== "dispatch_pending" || digest !== job.planSha256)
      throw new NativeHelperArtifactError("Helper execution requires the exact dispatched request");
    await validateHelperPlan(job.plan);
    const previous = await previousIdentity(job.plan);
    recordPrevious(previous ?? null);
    await verifyNativeHelperState(job.plan, await admission());
    reportPhase("installing");
    await tools.command({
      plan: job.plan,
      home: context.home,
      operation: "install",
      recordInstaller,
      recordInstallerExit,
    });
    reportPhase("verifying");
    return verifyInstalledSelection(job.plan, previous);
  }
  async function verifyInstalledSelection(
    plan: NativeHelperPlan,
    previous?: NativeHelperIdentity,
  ): Promise<string> {
    const mounts = (await admission()).writableMountRoots;
    await verifyNativeHelperTooling(plan, mounts);
    await verifyNativeHelperApplication(
      { ...plan.candidate, directory: plan.destination.application },
      mounts,
      tools.signatures,
    );
    const configurationDigest = await verifySelectedState(plan, mounts);
    const identity = await verifyNativeHelperReadiness({
      readStatus: () => readStatus(plan),
      inspectProcess: tools.inspectProcess,
      expectedExecutable: path.join(
        plan.destination.application,
        "Contents/MacOS/VorteoPermissionHelper",
      ),
      expectedUid: process.getuid!(),
      previous,
    });
    if ((await verifySelectedState(plan, mounts)) !== configurationDigest)
      throw new NativeHelperArtifactError("Helper configuration changed during readiness");
    if (
      (await digestBootstrapArtifact(plan.destination.application)) !==
      plan.candidate.artifactSha256
    )
      throw new NativeHelperArtifactError("Installed helper changed during readiness");
    return `Helper installed and verified (PID ${identity.pid}). Browser permissions were not changed.`;
  }
  async function inspectRecoveredSelection(job: NativeHelperJob) {
    const snapshot = await inspectNativeHelperRecovery(job, await admission());
    if (
      job.installerExit?.code !== 0 ||
      job.installerExit.signal !== null ||
      snapshot.installerPidPresence.state !== "absent" ||
      snapshot.lock.state !== "absent" ||
      snapshot.staged.state !== "absent"
    )
      throw new NativeHelperArtifactError(
        "Installer completion requires further recovery inspection",
      );
    if (job.previousProcess === undefined || (job.plan.previous && job.previousProcess === null))
      throw new NativeHelperArtifactError(
        "Previous helper identity is unavailable for replacement verification",
      );
    const detail = await verifyInstalledSelection(job.plan, job.previousProcess ?? undefined);
    return { snapshot, detail, replacementVerified: true };
  }
  async function validateHelperRollback(
    job: NativeHelperJob,
    failed: NativeHelperJob,
  ): Promise<void> {
    const snapshot = await inspectNativeHelperRecovery(failed, await admission());
    if (
      !failed.installerExit ||
      snapshot.installerPidPresence.state !== "absent" ||
      snapshot.lock.state !== "absent" ||
      snapshot.staged.state !== "absent"
    )
      throw new NativeHelperArtifactError(
        "Interrupted installer must be reconciled before rollback",
      );
    await validateHelperPlan(job.plan);
  }
  async function verifyHelperRecovery(job: NativeHelperJob): Promise<string> {
    const result = await inspectRecoveredSelection(job);
    return "Installation previously failed; the selected helper is now verified. " + result.detail;
  }
  return {
    validateHelperPlan,
    installHelper,
    inspectRecoveredSelection,
    verifyHelperRecovery,
    validateHelperRollback,
  };
}

async function verifySelectedState(
  plan: NativeHelperPlan,
  mounts: readonly string[],
): Promise<string> {
  const runtime = plan.destination.runtime;
  const configPath = path.join(runtime, "config.json");
  const configStat = await lstat(configPath);
  const runtimeStat = await lstat(runtime);
  if (
    (configStat.mode & 0o777) !== 0o600 ||
    (runtimeStat.mode & 0o777) !== 0o700 ||
    !runtimeStat.isDirectory()
  )
    throw new NativeHelperArtifactError("Installed helper private state has unsafe permissions");
  const configurationBytes = await readProtectedDocument(configPath);
  const configuration = z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      helperRequirement: z.literal(plan.candidate.helperRequirement),
      clientRequirement: z.literal(plan.candidate.clientRequirement),
    })
    .safeParse(privateJson(configurationBytes));
  if (!configuration.success)
    throw new NativeHelperArtifactError("Invalid private helper configuration");
  if (plan.expectedState.configurationSha256)
    await verifyPrivateState(configPath, plan.expectedState.configurationSha256, mounts);
  await verifyPrivateState(
    path.join(runtime, "browser-policy.json"),
    plan.expectedState.policySha256,
    mounts,
  );
  await readBootstrapPreparedFile(
    { path: path.join(runtime, "host.mjs"), sha256: plan.tooling.dispatcher.sha256 },
    mounts,
  );
  await readBootstrapPreparedFile(
    { path: path.join(runtime, "invoke.mjs"), sha256: plan.tooling.invocationClient.sha256 },
    mounts,
  );
  for (const retained of [plan.previous, plan.retainedRollback]) {
    if (retained && (await digestBootstrapArtifact(retained.directory)) !== retained.artifactSha256)
      throw new NativeHelperArtifactError("Retained helper rollback changed after installation");
  }
  if (
    plan.previous &&
    (await digestBootstrapArtifact(plan.destination.application + ".previous")) !==
      plan.previous.artifactSha256
  )
    throw new NativeHelperArtifactError("Installer did not retain the previous selected helper");
  const receipt = z.object({
    preview: z.literal(false),
    app: z.literal(plan.destination.application),
  });
  if (
    !receipt.safeParse(
      privateJson(await readProtectedDocument(path.join(runtime, "installation.json"))),
    ).success
  )
    throw new NativeHelperArtifactError("Invalid private helper installation receipt");
  return createHash("sha256").update(configurationBytes).digest("hex");
}

function privateJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NativeHelperArtifactError("Invalid private helper document");
  }
}
