import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type {
  ArtifactChange,
  ArtifactScan,
  ObservedMetadata,
} from "./coordinator-bootstrap-artifact-scan.js";

// Release seals (design B). A sealed release is immutable on disk (`uchg`), and
// its seal records every entry's metadata identity after flagging and a full byte
// pass. Approval then sweeps metadata instead of re-reading bytes. The v1
// artifact digest is unchanged and remains the only wire identity.
//
// Seal records sit beside the release, outside its tree, so both the coordinator
// that seals and any Host that verifies find them from the release path alone.
// A seal is honoured only when the preparation's admission receipt, which the
// reviewed job evidence digests, binds the same seal digests. Rewriting the seal
// files alone therefore cannot authorize a changed tree. A missing, unbound or
// unusable seal means byte verification, never acceptance.
//
// Residual: sealing refuses descriptors already open for writing, but cannot see
// writable shared memory mappings of other processes, nor processes of other
// accounts, which cannot write these owner-only trees without root.

const SEAL_SCHEME = "vorteo-release-seal-v2";
const CHFLAGS = "/usr/bin/chflags";
const MAX_SEAL_HEADER_BYTES = 64 * 1024;
const MAX_SEAL_OBSERVED_BYTES = 512 * 1024 * 1024;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SealHeaderSchema = z.strictObject({
  version: z.literal(2),
  scheme: z.literal(SEAL_SCHEME),
  directory: z.string().startsWith("/"),
  artifactSha256: DigestSchema,
  manifestSha256: DigestSchema,
  observedSha256: DigestSchema,
  sealedAt: z.iso.datetime(),
});

const LSOF = "/usr/sbin/lsof";
const MAX_SEAL_MANIFEST_BYTES = 512 * 1024 * 1024;

/** What an admission receipt records so approval can trust exactly this seal. */
export const ReleaseSealBindingSchema = z.strictObject({
  observedSha256: DigestSchema,
  manifestSha256: DigestSchema,
});
export type ReleaseSealBinding = z.infer<typeof ReleaseSealBindingSchema>;
const SealAdmissionSchema = z.object({
  candidateArtifactSha256: DigestSchema,
  candidateSeal: ReleaseSealBindingSchema,
});

/** A prepared release sits directly in its preparation directory, beside the
 * admission receipt that binds its seal. */
export function releaseAdmissionReceipt(directory: string): string {
  return path.join(path.dirname(directory), "admission.json");
}

const run = promisify(execFile);

/** Default off. Seal creation and sweep-first verification both require it. */
export function releaseSealsEnabled(): boolean {
  return process.env.VORTEO_RELEASE_SEALS === "enabled";
}

export interface ReleaseSealFiles {
  header: string;
  observed: string;
  manifest: string;
}

export function releaseSealFiles(directory: string): ReleaseSealFiles {
  return {
    header: `${directory}.release-seal.json`,
    observed: `${directory}.release-seal.observed`,
    manifest: `${directory}.release-manifest`,
  };
}

export interface ReleaseSeal {
  artifactSha256: string;
  observed: ObservedMetadata;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function setReleaseImmutable(files: readonly string[], immutable: boolean) {
  if (files.length === 0) return;
  // Only macOS can set these flags (sealing refuses elsewhere), so off macOS there is
  // nothing to clear. Without this, removal fails where /usr/bin/chflags is absent.
  if (!immutable && process.platform !== "darwin") return;
  await run(CHFLAGS, ["-R", immutable ? "uchg" : "nouchg", ...files]);
}

/** Records a seal from a scan taken after the tree was flagged immutable. The
 * manifest is the exact digested stream, so its SHA-256 is the artifact digest. */
export async function writeReleaseSeal(
  directory: string,
  scan: ArtifactScan,
): Promise<ReleaseSealBinding> {
  if (scan.manifest === null) throw new Error("Release seal requires the scan manifest");
  const files = releaseSealFiles(directory);
  assertReleaseUnsealed(directory);
  const manifestSha256 = sha256(scan.manifest);
  if (manifestSha256 !== scan.sha256) throw new Error("Release manifest does not match its digest");
  // Paths never contain NUL and are never empty, so a double NUL separates them.
  const observed = `${scan.observed.paths}\0\0${scan.observed.identities}`;
  writePrivateFileAtomicSync(files.manifest, scan.manifest);
  writePrivateFileAtomicSync(files.observed, observed);
  const header: z.infer<typeof SealHeaderSchema> = {
    version: 2,
    scheme: SEAL_SCHEME,
    directory,
    artifactSha256: scan.sha256,
    manifestSha256,
    observedSha256: sha256(observed),
    sealedAt: new Date().toISOString(),
  };
  // The header is written last: a seal without it is ignored, never trusted.
  writePrivateFileAtomicSync(files.header, JSON.stringify(header) + "\n");
  await setReleaseImmutable([files.manifest, files.observed, files.header], true);
  return { observedSha256: header.observedSha256, manifestSha256 };
}

export function assertSealingSupported(): void {
  if (process.platform !== "darwin")
    throw new BootstrapRequestConflict("Release seals require macOS immutable file flags");
}

/** Flags block new writable opens, not descriptors opened earlier; refuse while
 * any process of this account still holds one inside the tree. */
export async function assertNoOpenReleaseWriters(directory: string): Promise<void> {
  let listing: string;
  try {
    const uid = String(process.getuid?.());
    ({ stdout: listing } = await run(LSOF, ["-n", "-P", "-w", "-u", uid, "-F", "pan"], {
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    // lsof exits 1 when some descriptor cannot be described; its listing stands.
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : null;
    if (typeof stdout !== "string" || stdout.length === 0)
      throw new BootstrapRequestConflict("Release sealing could not list open files");
    listing = stdout;
  }
  const writers = new Set<string>();
  let pid = "";
  let mode = "";
  for (const line of listing.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = value;
    else if (line.startsWith("f")) mode = "";
    else if (line.startsWith("a")) mode = value;
    else if (line.startsWith("n") && (mode === "w" || mode === "u")) {
      if (value === directory || value.startsWith(directory + path.sep)) writers.add(pid);
    }
  }
  if (writers.size > 0)
    throw new BootstrapRequestConflict(
      `Release files are open for writing by process ${[...writers].join(", ")}. ` +
        "Stop those processes, then prepare the release again.",
    );
}

export function assertReleaseUnsealed(directory: string): void {
  if (Object.values(releaseSealFiles(directory)).some((file) => existsSync(file)))
    throw new BootstrapRequestConflict("Release is already sealed");
}

/** Removes a release whether or not it is sealed. Any retention or cleanup of
 * prepared releases must use this; a plain recursive delete fails with EPERM.
 * Manual equivalent: `chflags -R nouchg <release> <release>.release-*` first. */
export async function removeBootstrapRelease(directory: string): Promise<void> {
  if (existsSync(directory)) await setReleaseImmutable([directory], false);
  await unsealBootstrapRelease(directory);
  await rm(directory, { recursive: true, force: true });
}

/** Clears the immutable flags and removes the seal. Required before anything
 * deletes, repairs or rebuilds a sealed release in place. */
export async function unsealBootstrapRelease(directory: string): Promise<void> {
  const files = Object.values(releaseSealFiles(directory)).filter((file) => existsSync(file));
  await setReleaseImmutable([directory, ...files], false);
  for (const file of files) await rm(file, { force: true });
}

/** Same custody as other prepared documents: canonical, owned, private, single
 * link and bounded. Null when absent or when custody fails, so bytes decide. */
async function readSealFile(file: string, limit: number): Promise<Buffer | null> {
  if (!existsSync(file) || (await realpath(file)) !== file) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    const owned = process.getuid !== undefined && stat.uid === BigInt(process.getuid());
    const regular = stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(limit);
    if (!owned || !regular || (stat.mode & 0o022n) !== 0n) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseSealDocument<T extends z.ZodType>(schema: T, bytes: Buffer) {
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Null means verify bytes: no seal, or one that does not describe this path. */
export async function readReleaseSeal(directory: string): Promise<ReleaseSeal | null> {
  const files = releaseSealFiles(directory);
  const headerBytes = await readSealFile(files.header, MAX_SEAL_HEADER_BYTES);
  const header = headerBytes && parseSealDocument(SealHeaderSchema, headerBytes);
  if (!header || header.directory !== directory) return null;
  const admissionBytes = await readSealFile(
    releaseAdmissionReceipt(directory),
    MAX_SEAL_HEADER_BYTES,
  );
  const admission = admissionBytes && parseSealDocument(SealAdmissionSchema, admissionBytes);
  const bound =
    admission?.candidateArtifactSha256 === header.artifactSha256 &&
    admission.candidateSeal.observedSha256 === header.observedSha256 &&
    admission.candidateSeal.manifestSha256 === header.manifestSha256;
  if (!bound) return null;
  // The manifest is the digested stream itself, so it must hash to the digest.
  const manifest = await readSealFile(files.manifest, MAX_SEAL_MANIFEST_BYTES);
  const manifestSha256 = manifest && sha256(manifest);
  if (manifestSha256 !== header.manifestSha256 || manifestSha256 !== header.artifactSha256)
    return null;
  const observedBytes = await readSealFile(files.observed, MAX_SEAL_OBSERVED_BYTES);
  if (!observedBytes || sha256(observedBytes) !== header.observedSha256) return null;
  const text = observedBytes.toString("utf8");
  const separator = text.indexOf("\0\0");
  if (separator <= 0) return null;
  return {
    artifactSha256: header.artifactSha256,
    observed: { paths: text.slice(0, separator), identities: text.slice(separator + 2) },
  };
}

/** Owner-facing refusal for a sealed tree that no longer matches its seal. */
export function sealedChangeMessage(directory: string, change: ArtifactChange): string {
  const relative = path.relative(directory, change.path) || ".";
  return (
    `Installed release was modified after it was sealed: ${relative} (${change.kind}). ` +
    "A release must never be a dependency source or tool cache root. Relink any worktree " +
    "that points into it, then prepare a fresh release."
  );
}
