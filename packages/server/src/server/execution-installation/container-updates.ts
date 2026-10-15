import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SourceUpdateSchema, type RestartJob } from "@getpaseo/protocol/execution-installation";
import { writeLifecycleReceipt } from "./lifecycle-journal.js";
import { connectInstallationDaemon } from "./daemon.js";
import type { InstallationConfig, ContainerSourceUpdates } from "./config.js";
import type { RestartExecutor } from "./restarts.js";

const execute = promisify(execFile);
const SelectionSchema = z.object({
  release: z.string().startsWith("/"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
});

interface ContainerCommand {
  settings: ContainerSourceUpdates;
  operation: Record<string, unknown>;
  archive?: Buffer;
  signal?: AbortSignal;
}

/** Docker remains a Host-only capability. No command, container or credential comes from an upload. */
async function containerCommand({
  settings,
  operation,
  archive,
  signal,
}: ContainerCommand): Promise<unknown> {
  const helper = readFileSync(
    path.join(settings.toolingDirectory, "installation-container-runtime.mjs"),
    "utf8",
  );
  // A full immutable ID fails closed when the configured container is replaced.
  const args = [
    "exec",
    "-i",
    "--user",
    settings.user,
    settings.containerId,
    settings.node,
    "--input-type=module",
    "--eval",
    helper,
    JSON.stringify({
      ...operation,
      settings: {
        releaseRoot: settings.releaseRoot,
        currentReleaseLink: settings.currentReleaseLink,
        home: settings.home,
        node: settings.node,
      },
    }),
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      settings.docker,
      args,
      { timeout: operation.action === "prepare" ? 60 * 60_000 : 150_000, maxBuffer: 8192, signal },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
    child.stdin?.on("error", () => {
      /* The process callback owns failed uploads. */
    });
    child.stdin?.end(archive);
  });
  return JSON.parse(stdout);
}

export async function inspectContainerSource(settings: ContainerSourceUpdates): Promise<void> {
  const selected = SelectionSchema.parse(
    await containerCommand({ settings, operation: { action: "inspect" } }),
  );
  const expected = z
    .object({ sourceCommit: z.string() })
    .parse(JSON.parse(readFileSync(settings.receiptFile, "utf8")));
  if (selected.sourceCommit !== expected.sourceCommit)
    throw new Error("Dev release differs from the protected installation receipt");
}

interface ContainerInstallation {
  config: InstallationConfig;
  job: RestartJob;
  bundleFile: string;
  restart: RestartExecutor["restart"];
}

export async function prepareContainerSource({
  config,
  job,
  bundleFile,
}: Omit<ContainerInstallation, "restart">): Promise<void> {
  const settings = config.containerSourceUpdates;
  if (!settings || job.target !== "container-daemon")
    throw new Error("Dev source updates are not configured");
  const update = SourceUpdateSchema.parse(job.update);
  const installed = SelectionSchema.parse(
    await containerCommand({ settings, operation: { action: "inspect" } }),
  );
  if (installed.sourceCommit !== update.baseCommit)
    throw new Error("Installed Dev source changed; request a new approval");
  const bundle = readFileSync(bundleFile);
  if (
    bundle.length !== update.bytes ||
    createHash("sha256").update(bundle).digest("hex") !== update.sha256
  )
    throw new Error("Approved Dev bundle changed; no build or activation performed");
  const work = path.join(config.stateDir, "container-source-updates", job.id);
  mkdirSync(work, { mode: 0o700 });
  const git = async (args: string[]) =>
    (
      await execute("git", args, {
        cwd: settings.sourceRepository,
        timeout: 120_000,
        maxBuffer: 8192,
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/dev/null",
        },
      })
    ).stdout.trim();
  await git(["bundle", "verify", bundleFile]);
  const approvedRef = `refs/vorteo-container-updates/${job.id}`;
  await git([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    bundleFile,
    `${settings.integrationRef}:${approvedRef}`,
  ]);
  if ((await git(["rev-parse", approvedRef])) !== update.sourceCommit)
    throw new Error("Bundle ref differs from approved Dev source");
  await git(["merge-base", "--is-ancestor", update.baseCommit, update.sourceCommit]);
  const archiveFile = path.join(work, "source.tar");
  await git(["archive", "--format=tar", `--output=${archiveFile}`, update.sourceCommit]);
  if (statSync(archiveFile).size > 512 * 1024 * 1024)
    throw new Error("Dev source archive exceeds the build limit");
  const archive = readFileSync(archiveFile);
  const prepared = SelectionSchema.extend({
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).parse(
    await containerCommand({
      settings,
      archive,
      operation: {
        action: "prepare",
        jobId: job.id,
        previous: installed.release,
        update,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      },
    }),
  );
  if (prepared.sourceCommit !== update.sourceCommit)
    throw new Error("Prepared Dev source differs from approval");
  writeLifecycleReceipt(path.join(work, "prepared.json"), {
    release: prepared.release,
    previous: installed.release,
    update,
    artifactSha256: prepared.artifactSha256,
  });
}

const PreparedContainerSchema = z.object({
  release: z.string(),
  previous: z.string(),
  update: SourceUpdateSchema,
  artifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export async function verifyPreparedContainerSource(
  config: InstallationConfig,
  job: RestartJob,
  signal?: AbortSignal,
) {
  const settings = config.containerSourceUpdates;
  if (!settings || job.target !== "container-daemon")
    throw new Error("Dev source updates are not configured");
  const work = path.join(config.stateDir, "container-source-updates", job.id);
  const operation = PreparedContainerSchema.parse(
    JSON.parse(readFileSync(path.join(work, "prepared.json"), "utf8")),
  );
  if (JSON.stringify(operation.update) !== JSON.stringify(SourceUpdateSchema.parse(job.update)))
    throw new Error("Prepared Dev candidate belongs to different approved source");
  if (!operation.artifactSha256) {
    if (job.standingDecision)
      throw new Error("Standing Dev updates require built candidate evidence");
    return operation;
  }
  if (
    job.standingDecision?.activationStep &&
    job.standingDecision.activationStep.candidateArtifactSha256 !== operation.artifactSha256
  )
    throw new Error("Built Dev candidate differs from exact activation step");
  const observed = SelectionSchema.extend({ artifactSha256: z.string() }).parse(
    await containerCommand({
      settings,
      signal,
      operation: { ...operation, action: "verify-candidate" },
    }),
  );
  if (
    observed.release !== operation.release ||
    observed.sourceCommit !== operation.update.sourceCommit ||
    observed.artifactSha256 !== operation.artifactSha256
  )
    throw new Error("Native Dev candidate verification differs from preparation");
  return operation;
}

export async function installContainerSource({
  config,
  job,
  restart,
}: ContainerInstallation): Promise<string> {
  const settings = config.containerSourceUpdates;
  if (!settings || job.target !== "container-daemon")
    throw new Error("Dev source updates are not configured");
  const update = SourceUpdateSchema.parse(job.update);
  const work = path.join(config.stateDir, "container-source-updates", job.id);
  const operation = await verifyPreparedContainerSource(config, job);
  const installed = SelectionSchema.parse(
    await containerCommand({ settings, operation: { action: "inspect" } }),
  );
  if (
    installed.release !== operation.previous ||
    installed.sourceCommit !== update.baseCommit ||
    JSON.stringify(operation.update) !== JSON.stringify(update)
  )
    throw new Error("Dev source changed after preparation. No candidate was activated.");
  const prepared = { release: operation.release };

  const receipt = path.join(work, "activation.json");
  if (existsSync(receipt))
    throw new Error(
      "Dev activation was already attempted. Inspect its retained receipt before recovery.",
    );
  writeLifecycleReceipt(receipt, { ...operation, status: "activating" });
  await containerCommand({ settings, operation: { ...operation, action: "activate" } });
  try {
    await restart("container-daemon");
    const client = await connectInstallationDaemon(config, "container");
    try {
      const status = await client.getDaemonStatus({ timeout: 30_000 });
      await containerCommand({
        settings,
        operation: { ...operation, action: "verify", pid: status.pid },
      });
    } finally {
      await client.close();
    }
  } catch (error) {
    let restorationError: unknown;
    try {
      await containerCommand({ settings, operation: { ...operation, action: "restore" } });
    } catch (restoreError) {
      restorationError = restoreError;
    }
    if (restorationError) {
      const failure = new Error(
        `Dev update readiness failed and release selection could not be restored. Inspect ${receipt}; no restart was replayed.`,
        { cause: error },
      );
      throw Object.assign(failure, { restorationError });
    }
    throw new Error(
      `Dev update readiness failed. Previous release selected at ${installed.release}; inspect the running daemon before requesting recovery. No restart was replayed.`,
      { cause: error },
    );
  }
  // This protected receipt supplies the next upload's base. It is not guest-authored metadata.
  try {
    writeLifecycleReceipt(settings.receiptFile, {
      sourceCommit: update.sourceCommit,
      release: prepared.release,
      sha256: update.sha256,
    });
    writeLifecycleReceipt(receipt, { ...operation, status: "succeeded" });
  } catch (error) {
    throw new Error(
      `Dev is running approved source ${update.sourceCommit}, but its installation receipt could not be recorded. Reconcile ${receipt} before another update; no restart was replayed.`,
      { cause: error },
    );
  }
  return `Installed Dev source ${update.sourceCommit}. Replacement identity, readiness and worker executable verified. Previous release retained at ${installed.release}.`;
}
