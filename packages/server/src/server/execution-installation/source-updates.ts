import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  realpathSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  SourceUpdateSchema,
  type SourceUpdate,
  type RestartJob,
  type SourceContribution,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";
import { RestartRequestError, type RestartExecutor } from "./restarts.js";

import { installContainerSource } from "./container-updates.js";
import { prepareSourceBatch } from "./source-batches.js";

const execute = promisify(execFile);
const ReceiptSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });
const PreparedSchema = z.object({ release: z.string(), exported: z.string() });

/** Only the protected coordinator turns an approved bundle into executable code. */
export class InstallationSourceUpdates {
  private readonly directory: string;
  constructor(
    private readonly config: InstallationConfig,
    private readonly target: RestartJob["target"] = "host",
  ) {
    this.directory = path.join(
      config.stateDir,
      target === "host" ? "source-updates" : "container-source-updates",
    );
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  source() {
    const settings = this.settings();
    if (this.target === "container-daemon") {
      const container = this.config.containerSourceUpdates;
      if (!container) throw new Error("Dev source updates require installation setup");
      const receipt = ReceiptSchema.parse(JSON.parse(readFileSync(container.receiptFile, "utf8")));
      return {
        baseCommit: receipt.sourceCommit,
        webCommit: receipt.sourceCommit,
        integrationRef: settings.integrationRef,
        sourceBatches: true,
        maxBytes: 128 * 1024 * 1024,
      };
    }
    const receipt = ReceiptSchema.parse(
      JSON.parse(
        readFileSync(
          path.join(this.hostSettings().currentReleaseLink, ".installation-source.json"),
          "utf8",
        ),
      ),
    );
    const web = ReceiptSchema.parse(
      JSON.parse(readFileSync(path.join(this.hostSettings().webDirectory, "release.json"), "utf8")),
    );
    return {
      webCommit: web.sourceCommit,
      baseCommit: receipt.sourceCommit,
      integrationRef: settings.integrationRef,
      sourceBatches: true,
      maxBytes: 128 * 1024 * 1024,
    };
  }

  stage(input: SourceUpdate, bundle: Buffer, batching = false): void {
    const update = SourceUpdateSchema.parse(input);
    if (!batching && this.source().baseCommit !== update.baseCommit)
      throw new RestartRequestError("Installed source changed. Prepare a new update.");
    if (
      bundle.length !== update.bytes ||
      createHash("sha256").update(bundle).digest("hex") !== update.sha256
    )
      throw new RestartRequestError("Source bundle does not match its digest and size");
    const file = this.bundlePath(update);
    if (existsSync(file)) {
      if (!readFileSync(file).equals(bundle))
        throw new RestartRequestError("Stored bundle is corrupt");
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bundle, { mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    const directory = openSync(this.directory, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  prepare(contributions: SourceContribution[]) {
    return prepareSourceBatch({
      directory: this.directory,
      repository: this.settings().sourceRepository,
      integrationRef: this.settings().integrationRef,
      baseCommit: this.source().baseCommit,
      webCommit: this.source().webCommit,
      contributions,
      stage: (update, bundle) => this.stage(update, bundle, true),
    });
  }

  async install(job: RestartJob, restart: RestartExecutor["restart"]): Promise<string> {
    const update = SourceUpdateSchema.parse(job.update);
    if (job.target !== this.target) throw new Error("Source update target changed");
    if (this.target === "container-daemon")
      return installContainerSource({
        config: this.config,
        job,
        bundleFile: this.bundlePath(update),
        restart,
      });
    const settings = this.hostSettings();
    if (job.target !== "host" || this.source().baseCommit !== update.baseCommit)
      throw new Error("Installed source changed. No update was installed; request a new approval.");
    if (job.sourceBatch && job.sourceBatch.webCommit !== this.source().webCommit)
      throw new Error(
        "Published source changed. Review a newly prepared batch before installation.",
      );
    const previous = realpathSync(settings.currentReleaseLink);
    const webReceipt = readFileSync(path.join(settings.webDirectory, "release.json"));
    const webIndex = readFileSync(path.join(settings.webDirectory, "index.html"));
    const bundle = readFileSync(this.bundlePath(update));
    if (
      bundle.length !== update.bytes ||
      createHash("sha256").update(bundle).digest("hex") !== update.sha256
    )
      throw new Error("Approved source bundle changed. No update was installed.");
    const work = path.join(settings.releaseRoot, job.id);
    mkdirSync(work, { mode: 0o700 });
    const requestFile = path.join(work, "request.json");
    const resultFile = path.join(work, "prepared.json");
    writeFileSync(
      requestFile,
      JSON.stringify({ ...settings, update, bundle: this.bundlePath(update), work, resultFile }),
      { mode: 0o600, flag: "wx" },
    );
    const validation = this.config.host.startupValidation;
    if (!validation) throw new Error("Host startup validation is required for source updates");
    await execute(
      validation.node,
      [path.join(settings.toolingDirectory, "prepare-installation-update.mjs"), requestFile],
      { timeout: 60 * 60_000, maxBuffer: 8192 },
    );
    const prepared = PreparedSchema.parse(JSON.parse(readFileSync(resultFile, "utf8")));
    for (const directory of [prepared.release, prepared.exported]) {
      if (!realpathSync(directory).startsWith(realpathSync(work) + path.sep))
        throw new Error("Prepared artifact escaped its release directory");
    }
    // Validate the candidate before changing the launcher or the public interface.
    await execute(
      validation.node,
      [path.join(prepared.release, "packages/server/dist/scripts/supervisor-entrypoint.js")],
      {
        env: { ...process.env, PASEO_HOME: validation.home, PASEO_VALIDATE_STARTUP: "1" },
        timeout: 15_000,
        maxBuffer: 8192,
      },
    );
    const selectionChanged = realpathSync(settings.currentReleaseLink) !== previous;
    const receiptChanged = !readFileSync(path.join(settings.webDirectory, "release.json")).equals(
      webReceipt,
    );
    const interfaceChanged = !readFileSync(path.join(settings.webDirectory, "index.html")).equals(
      webIndex,
    );
    if (selectionChanged || receiptChanged || interfaceChanged)
      throw new Error(
        "Installed release changed during the build. No candidate was activated; request a new update.",
      );
    writeFileSync(
      path.join(work, "activation.json"),
      JSON.stringify({ previous, candidate: prepared.release, update, status: "activating" }),
      { mode: 0o600, flag: "wx" },
    );
    this.selectRelease(prepared.release);
    try {
      await restart("host");
    } catch (error) {
      // Restore selection without replaying a disruptive restart. Runtime state remains ambiguous.
      this.selectRelease(previous);
      throw new Error(
        `Update readiness failed. Previous launcher restored at ${previous}; inspect the running daemon before another restart.`,
        { cause: error },
      );
    }
    try {
      await execute(
        validation.node,
        [
          path.join(settings.toolingDirectory, "publish-instance-web.mjs"),
          prepared.exported,
          settings.webDirectory,
        ],
        { timeout: 5 * 60_000, maxBuffer: 8192 },
      );
    } catch (error) {
      throw new Error(
        `Host daemon updated to ${update.sourceCommit}, but interface publication failed. Inspect ${work}; do not replay the update.`,
        { cause: error },
      );
    }
    writeFileSync(
      path.join(work, "activation.json"),
      JSON.stringify({ previous, candidate: prepared.release, update, status: "succeeded" }),
      { mode: 0o600 },
    );
    return `Installed source ${update.sourceCommit}. Host replacement identity and readiness verified; interface published. Previous release retained at ${previous}.`;
  }

  private selectRelease(release: string) {
    const link = this.settings().currentReleaseLink;
    const temporary = `${link}.${randomUUID()}.next`;
    symlinkSync(release, temporary);
    renameSync(temporary, link);
  }
  private bundlePath(update: SourceUpdate) {
    return path.join(this.directory, `${update.sha256}.bundle`);
  }
  private settings() {
    if (this.target === "container-daemon") {
      if (!this.config.containerSourceUpdates)
        throw new Error("Dev source updates require installation setup");
      return this.config.containerSourceUpdates;
    }
    return this.hostSettings();
  }
  private hostSettings() {
    if (!this.config.sourceUpdates)
      throw new Error("Source updates require Host installation setup");
    return this.config.sourceUpdates;
  }
}
