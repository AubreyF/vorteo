import { inspectStandingSourceProvenance } from "./maintenance/source-provenance.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
  verifyBootstrapPreparedDependency,
} from "./coordinator-bootstrap-artifact.js";
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
  lstatSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  SourceUpdateSchema,
  DevRepairCaptureSchema,
  type DevRepairCapture,
  type SourceUpdate,
  type RestartJob,
  type SourceContribution,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";
import { RestartRequestError, type RestartExecutor } from "./restarts.js";

import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { writeLifecycleReceipt } from "./lifecycle-journal.js";
import {
  installContainerSource,
  prepareContainerSource,
  verifyPreparedContainerSource,
} from "./container-updates.js";
import { prepareSourceBatch } from "./source-batches.js";
import { prepareDevRepairBundle } from "./dev-source-repair.js";
import { isDeepStrictEqual } from "node:util";
import type { StandingInterruption } from "@getpaseo/protocol/maintenance-interruption";

export {
  DevRepairCaptureSchema,
  type DevRepairCapture,
} from "@getpaseo/protocol/execution-installation";

const execute = promisify(execFile);
const ReceiptSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });
const AdmissionSchema = z.object({
  previous: z.string(),
  sourceSha256: z.string(),
  webReceipt: z.string(),
  webIndex: z.string(),
  exportedArtifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  // Old manual preparations remain readable; standing execution requires this evidence.
  candidateArtifactSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const CANDIDATE_DIGEST_LIMITS = { maxFiles: 250_000, maxBytes: 8 * 1024 ** 3, timeoutMs: 120_000 };
const PreparedSchema = z.object({ release: z.string(), exported: z.string() });

function receiptDigest(buffers: Buffer[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(buffers.map((bytes) => createHash("sha256").update(bytes).digest("hex"))),
    )
    .digest("hex");
}

interface PublishedInterruption {
  exported: string;
  destination: string;
  sourceCommit: string;
  writableMountRoots: readonly string[];
}
interface InstalledInterruption {
  job: RestartJob;
  expected: NonNullable<StandingInterruption["candidate"]>;
  writableMountRoots: readonly string[];
}

function publicationFileIdentity(file: string) {
  const canonical = realpathSync(file);
  const stat = lstatSync(canonical, { bigint: true });
  return {
    canonical,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    uid: stat.uid,
    nlink: stat.nlink,
    mtime: stat.mtimeNs,
    ctime: stat.ctimeNs,
  };
}

async function verifyPublishedInterruption(input: PublishedInterruption) {
  const deadline = Date.now() + 30_000;
  const destination = realpathSync(input.destination);
  const manifestFile = path.join(input.exported, ".build-manifest.json");
  const receiptFile = path.join(destination, "release.json");
  const paths = [manifestFile, receiptFile];
  const identities = new Map<string, ReturnType<typeof publicationFileIdentity>>();
  for (const file of paths) identities.set(file, publicationFileIdentity(file));
  const manifest = z
    .object({
      version: z.literal(1),
      buildId: z.string().min(1),
      sourceCommit: z.literal(input.sourceCommit),
      files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
      deployment: z.object({ destination: z.literal(destination) }),
    })
    .parse(JSON.parse((await readProtectedDocument(manifestFile)).toString("utf8")));
  const receipt = z
    .object({
      sourceCommit: z.literal(input.sourceCommit),
      buildId: z.literal(manifest.buildId),
      sha256: z.literal(manifest.files["index.html"]),
    })
    .parse(JSON.parse((await readProtectedDocument(realpathSync(receiptFile))).toString("utf8")));
  if (!receipt.sha256 || Object.keys(manifest.files).length > 250_000)
    throw new Error("Publication manifest is missing its index or exceeds verification limits");
  let bytes = 0n;
  for (const [name, sha256] of Object.entries(manifest.files)) {
    if (name === "metadata.json") continue; // The publisher deliberately omits build metadata.
    if (name.includes("\\") || name.split("/").some((part) => !part || part.startsWith(".")))
      throw new Error("Publication manifest contains an unsupported asset path");
    const file = path.join(destination, name);
    const before = publicationFileIdentity(file);
    bytes += before.size;
    if (
      !before.canonical.startsWith(destination + path.sep) ||
      bytes > 8n * 1024n ** 3n ||
      Date.now() >= deadline
    )
      throw new Error("Publication verification exceeded its protected path or scan limits");
    await verifyBootstrapPreparedDependency(
      { path: before.canonical, sha256 },
      input.writableMountRoots,
    );
    identities.set(file, before);
  }
  const assertCurrent = () => {
    if (Date.now() >= deadline) throw new Error("Publication verification deadline elapsed");
    for (const [file, before] of identities)
      if (!isDeepStrictEqual(publicationFileIdentity(file), before))
        throw new Error("Published interface changed during interruption observation");
  };
  assertCurrent();
  return assertCurrent;
}

/** Only the protected coordinator turns an approved bundle into executable code. */
export class InstallationSourceUpdates {
  private readonly directory: string;
  private readonly candidateEvidence = new Map<
    string,
    {
      sourceSha256: string;
      artifactSha256: string;
      release: string;
      verifiedAt: number;
      files: string[];
      receiptSha256: string;
    }
  >();
  constructor(
    private readonly config: InstallationConfig,
    private readonly target: RestartJob["target"] = "host",
    private readonly assertRegistrationReadiness?: (target: RestartJob["target"]) => void,
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

  captureDevRepair(contributions: SourceContribution[]): DevRepairCapture {
    if (this.target !== "container-daemon")
      throw new RestartRequestError("Owner source repair is limited to Dev");
    const hostReleaseDirectory = realpathSync(this.hostSettings().currentReleaseLink);
    const host = ReceiptSchema.parse(
      JSON.parse(
        readFileSync(path.join(hostReleaseDirectory, ".installation-source.json"), "utf8"),
      ),
    );
    const dev = this.source();
    const active = contributions.filter((item) => item.status !== "superseded");
    return DevRepairCaptureSchema.parse({
      hostReleaseDirectory,
      baseCommit: dev.baseCommit,
      sourceCommit: host.sourceCommit,
      integrationRef: dev.integrationRef,
      contributionCommits: active.map((item) => item.update.sourceCommit),
    });
  }

  async prepareDevRepair(capture: DevRepairCapture, contributions: SourceContribution[]) {
    const snapshot = DevRepairCaptureSchema.parse(capture);
    const assertCurrent = () => {
      if (!isDeepStrictEqual(this.captureDevRepair(contributions), snapshot))
        throw new RestartRequestError(
          "Dev repair source changed. Capture and review a new repair.",
        );
    };
    assertCurrent();
    const prepared = await prepareDevRepairBundle({
      baseCommit: snapshot.baseCommit,
      sourceCommit: snapshot.sourceCommit,
      integrationRef: snapshot.integrationRef,
      contributionCommits: snapshot.contributionCommits,
      repository: this.hostSettings().sourceRepository,
      directory: this.directory,
    });
    assertCurrent();
    // Staging bytes grants no approval. The queue must compare the captured
    // request revision before attaching this contribution to a pending batch.
    this.stage(prepared.update, prepared.bundle, true);
    return prepared.update;
  }

  async inspectStandingSource(job: RestartJob, writableMountRoots: readonly string[]) {
    const source = this.source();
    if (!job.update) return { repository: null, assertCurrent: () => undefined };
    const update = SourceUpdateSchema.parse(job.update);
    if (source.baseCommit !== update.baseCommit || job.sourceBatch?.webCommit !== source.webCommit)
      throw new Error("Installed source changed before standing approval");
    const protectedPaths = [this.directory, this.settings().sourceRepository];
    if (this.target === "host") protectedPaths.push(this.hostSettings().releaseRoot);
    await assertBootstrapPathsProtected(protectedPaths, writableMountRoots);
    const proof = await inspectStandingSourceProvenance({
      repository: this.settings().sourceRepository,
      bundleFile: this.bundlePath(update),
      update,
      writableMountRoots,
    });
    return {
      repository: proof.repository,
      assertCurrent: () => {
        proof.assertCurrent();
        if (!isDeepStrictEqual(this.source(), source))
          throw new Error("Installed source changed after standing validation");
      },
    };
  }

  assertStandingPrepared(job: RestartJob): void {
    if (!job.update) return;
    const evidence = this.candidateEvidence.get(job.id);
    if (
      !evidence ||
      evidence.sourceSha256 !== job.update.sha256 ||
      Date.now() - evidence.verifiedAt > 30_000
    )
      throw new Error("Fresh built candidate evidence is unavailable");
    if (
      job.standingDecision?.activationStep &&
      evidence.artifactSha256 !== job.standingDecision.activationStep.candidateArtifactSha256
    )
      throw new Error("Built candidate differs from the reviewed activation step");
    if (receiptDigest(evidence.files.map((file) => readFileSync(file))) !== evidence.receiptSha256)
      throw new Error("Prepared candidate descriptors changed after verification");
  }

  standingCandidate(job: RestartJob) {
    this.assertStandingPrepared(job);
    const evidence = this.candidateEvidence.get(job.id);
    if (!job.update || !evidence) throw new Error("Verified candidate is unavailable");
    return {
      sourceCommit: job.update.sourceCommit,
      artifactSha256: evidence.artifactSha256,
      release: evidence.release,
    };
  }

  /** Observation only. Never retries installation or publication after a lost reply. */
  async verifyInstalledInterruption({ job, expected, writableMountRoots }: InstalledInterruption) {
    if (this.target !== "host" || job.target !== "host" || !job.update)
      throw new Error("Installed interruption source verification is unavailable for this target");
    const verified = await this.verifiedHostPreparation(job);
    if (
      expected.release !== verified.prepared.release ||
      expected.sourceCommit !== job.update.sourceCommit ||
      expected.artifactSha256 !== verified.admission.candidateArtifactSha256
    )
      throw new Error("Installed candidate differs from the retained interruption");
    const settings = this.hostSettings();
    const activationFile = path.join(settings.releaseRoot, job.id, "activation.json");
    await assertBootstrapPathsProtected(
      [activationFile, verified.prepared.release, settings.webDirectory],
      writableMountRoots,
    );
    const activation = z
      .object({ candidate: z.string(), update: SourceUpdateSchema, status: z.literal("succeeded") })
      .parse(JSON.parse((await readProtectedDocument(activationFile)).toString("utf8")));
    if (
      activation.candidate !== expected.release ||
      !isDeepStrictEqual(activation.update, job.update) ||
      realpathSync(settings.currentReleaseLink) !== expected.release
    )
      throw new Error("Retained activation or selected source differs from the reviewed candidate");
    const assertPublication = await verifyPublishedInterruption({
      exported: verified.prepared.exported,
      destination: settings.webDirectory,
      sourceCommit: expected.sourceCommit,
      writableMountRoots,
    });
    const files = [...verified.files, activationFile];
    const selectedReceipts = receiptDigest(files.map((file) => readFileSync(file)));
    return () => {
      if (
        realpathSync(settings.currentReleaseLink) !== expected.release ||
        receiptDigest(files.map((file) => readFileSync(file))) !== selectedReceipts
      )
        throw new Error("Installed interruption receipts changed during observation");
      assertPublication();
    };
  }

  async prepareInstallation(job: RestartJob): Promise<void> {
    const update = SourceUpdateSchema.parse(job.update);
    if (job.target !== this.target) throw new Error("Source update target changed");
    if (this.target === "container-daemon")
      return prepareContainerSource({
        config: this.config,
        job,
        bundleFile: this.bundlePath(update),
        assertRegistrationReadiness: this.assertRegistrationReadiness,
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
    writeLifecycleReceipt(path.join(work, "admission.json"), {
      previous,
      sourceSha256: update.sha256,
      candidateArtifactSha256: await digestBootstrapArtifact(
        prepared.release,
        CANDIDATE_DIGEST_LIMITS,
      ),
      exportedArtifactSha256: await digestBootstrapArtifact(
        prepared.exported,
        CANDIDATE_DIGEST_LIMITS,
      ),
      webReceipt: createHash("sha256").update(webReceipt).digest("hex"),
      webIndex: createHash("sha256").update(webIndex).digest("hex"),
    });
  }

  /** Recompute the built runtime digest before a hold and again before selection.
   * A source bundle digest alone does not bind the resulting executable bytes. */
  async verifyPreparedInstallation(
    job: RestartJob,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (job.target !== this.target) throw new Error("Source update target changed");
    this.candidateEvidence.delete(job.id);
    if (this.target !== "host") {
      const { operation, receiptSha256 } = await verifyPreparedContainerSource(
        this.config,
        job,
        options.signal,
      );
      if (operation.artifactSha256)
        this.candidateEvidence.set(job.id, {
          sourceSha256: operation.update.sha256,
          artifactSha256: operation.artifactSha256,
          release: operation.release,
          verifiedAt: Date.now(),
          files: [
            path.join(this.config.stateDir, "container-source-updates", job.id, "prepared.json"),
          ],
          receiptSha256,
        });
      return;
    }
    const verified = await this.verifiedHostPreparation(job, options.signal);
    if (verified.admission.candidateArtifactSha256)
      this.candidateEvidence.set(job.id, {
        sourceSha256: verified.admission.sourceSha256,
        artifactSha256: verified.admission.candidateArtifactSha256,
        release: verified.prepared.release,
        verifiedAt: Date.now(),
        files: verified.files,
        receiptSha256: verified.receiptSha256,
      });
  }

  private async verifiedHostPreparation(job: RestartJob, signal?: AbortSignal) {
    const update = SourceUpdateSchema.parse(job.update);
    const work = path.join(this.hostSettings().releaseRoot, job.id);
    const files = [path.join(work, "prepared.json"), path.join(work, "admission.json")];
    const buffers = files.map((file) => readFileSync(file));
    const prepared = PreparedSchema.parse(JSON.parse(buffers[0].toString("utf8")));
    for (const directory of [prepared.release, prepared.exported]) {
      if (!realpathSync(directory).startsWith(realpathSync(work) + path.sep))
        throw new Error("Prepared artifact escaped its release directory");
    }
    const admission = AdmissionSchema.parse(JSON.parse(buffers[1].toString("utf8")));
    const receiptSha256 = receiptDigest(buffers);
    const receipt = ReceiptSchema.parse(
      JSON.parse(readFileSync(path.join(prepared.release, ".installation-source.json"), "utf8")),
    );
    if (admission.sourceSha256 !== update.sha256 || receipt.sourceCommit !== update.sourceCommit)
      throw new Error("Prepared candidate belongs to different approved source");
    if (
      job.standingDecision?.activationStep &&
      job.standingDecision.activationStep.candidateArtifactSha256 !==
        admission.candidateArtifactSha256
    )
      throw new Error("Built candidate differs from the exact activation step");
    if (!admission.candidateArtifactSha256 || !admission.exportedArtifactSha256) {
      if (job.standingDecision)
        throw new Error("Standing source update requires built candidate evidence");
      return { prepared, admission, files, receiptSha256 };
    }
    if (
      (await digestBootstrapArtifact(prepared.release, { ...CANDIDATE_DIGEST_LIMITS, signal })) !==
        admission.candidateArtifactSha256 ||
      (await digestBootstrapArtifact(prepared.exported, { ...CANDIDATE_DIGEST_LIMITS, signal })) !==
        admission.exportedArtifactSha256
    )
      throw new Error("Prepared candidate content changed. No hold or replacement authorized.");
    return { prepared, admission, files, receiptSha256 };
  }

  async install(
    job: RestartJob,
    restart: RestartExecutor["restart"],
    beforeSelection?: () => Promise<void>,
  ): Promise<string> {
    if (job.target !== this.target) throw new Error("Source update target changed");
    const activationDirectory =
      this.target === "container-daemon"
        ? path.join(this.config.stateDir, "container-source-updates", job.id)
        : path.join(this.hostSettings().releaseRoot, job.id);
    if (existsSync(path.join(activationDirectory, "activation.json")))
      throw new Error(
        "Activation was already attempted. Inspect its retained receipt before recovery.",
      );
    if (job.updatePreparation !== "prepared") await this.prepareInstallation(job);
    const update = SourceUpdateSchema.parse(job.update);
    if (this.target === "container-daemon")
      return installContainerSource({
        config: this.config,
        job,
        bundleFile: this.bundlePath(update),
        assertRegistrationReadiness: this.assertRegistrationReadiness,
        restart,
        beforeSelection,
      });
    const settings = this.hostSettings();
    const work = path.join(settings.releaseRoot, job.id);
    const activationFile = path.join(work, "activation.json");
    if (existsSync(activationFile))
      throw new Error(
        "Activation was already attempted. Inspect its retained receipt before recovery.",
      );
    const { prepared, admission } = await this.verifiedHostPreparation(job);
    const previous = admission.previous;
    const validation = this.config.host.startupValidation;
    if (!validation) throw new Error("Host startup validation is required for source updates");
    const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    if (
      admission.sourceSha256 !== update.sha256 ||
      realpathSync(settings.currentReleaseLink) !== previous ||
      this.source().baseCommit !== update.baseCommit ||
      digest(path.join(settings.webDirectory, "release.json")) !== admission.webReceipt ||
      digest(path.join(settings.webDirectory, "index.html")) !== admission.webIndex
    )
      throw new Error("Installed source changed after preparation. No candidate was activated.");
    for (const directory of [prepared.release, prepared.exported]) {
      if (!realpathSync(directory).startsWith(realpathSync(work) + path.sep))
        throw new Error("Prepared artifact escaped its release directory");
    }
    await beforeSelection?.();
    writeLifecycleReceipt(activationFile, {
      previous,
      candidate: prepared.release,
      update,
      status: "activating",
    });
    this.selectRelease(prepared.release);
    try {
      await restart("host");
    } catch (error) {
      // A failed reply is not proof that the supervisor refused dispatch. Moving
      // the selector now can race a replacement already starting this candidate.
      // The durable activation intent fences replay and retains both reviewed slots.
      throw new Error(
        "Host restart outcome is unverified. Candidate selection and activation intent retained; reconcile native readiness before recovery. No restart or selection rollback was repeated.",
        { cause: error },
      );
    }
    const ready = {
      previous,
      candidate: prepared.release,
      exported: prepared.exported,
      update,
      status: "daemon-ready",
    };
    try {
      writeLifecycleReceipt(activationFile, ready);
    } catch (error) {
      throw new Error(
        `Host daemon updated to ${update.sourceCommit}, but its readiness receipt could not be saved. Inspect ${work}; do not replay the update.`,
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
      try {
        writeLifecycleReceipt(activationFile, { ...ready, status: "interface-failed" });
      } catch (storageError) {
        throw new Error(
          `Host daemon updated to ${update.sourceCommit}, but interface publication failed and its result receipt could not be saved. Inspect ${work}; do not replay the update.`,
          { cause: storageError },
        );
      }
      throw new Error(
        `Host daemon updated to ${update.sourceCommit}, but interface publication failed. Inspect ${work}; do not replay the update.`,
        { cause: error },
      );
    }
    writeLifecycleReceipt(activationFile, {
      previous,
      candidate: prepared.release,
      update,
      status: "succeeded",
    });
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
