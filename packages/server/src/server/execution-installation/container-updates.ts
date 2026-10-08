import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { SourceUpdateSchema, type RestartJob } from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";
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
}

/** Docker remains a Host-only capability. No command, container or credential comes from an upload. */
async function containerCommand({
  settings,
  operation,
  archive,
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
      { timeout: operation.action === "prepare" ? 60 * 60_000 : 15_000, maxBuffer: 8192 },
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

export async function installContainerSource({
  config,
  job,
  bundleFile,
  restart,
}: ContainerInstallation): Promise<string> {
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
  const prepared = SelectionSchema.parse(
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
  const operation = { release: prepared.release, previous: installed.release, update };
  const receipt = path.join(work, "activation.json");
  writeFileSync(receipt, JSON.stringify({ ...operation, status: "activating" }), {
    mode: 0o600,
    flag: "wx",
  });
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
    writePrivateFileAtomicSync(
      settings.receiptFile,
      JSON.stringify({
        sourceCommit: update.sourceCommit,
        release: prepared.release,
        sha256: update.sha256,
      }),
    );
    writePrivateFileAtomicSync(receipt, JSON.stringify({ ...operation, status: "succeeded" }));
  } catch (error) {
    throw new Error(
      `Dev is running approved source ${update.sourceCommit}, but its installation receipt could not be recorded. Reconcile ${receipt} before another update; no restart was replayed.`,
      { cause: error },
    );
  }
  return `Installed Dev source ${update.sourceCommit}. Replacement identity, readiness and worker executable verified. Previous release retained at ${installed.release}.`;
}
