import { spawn } from "node:child_process";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { BootstrapExecutorOperations } from "./coordinator-bootstrap-executor.js";

/**
 * Where an ordinary renewal executor digests its whole runtime tree. Every other
 * fence keeps the cheap setup, pinned-file, journal and lock checks and skips the
 * tree. Admission digests before any effect; the other boundaries each guard the
 * effect named, and the digest is the last await before it.
 *  - freeze: SIGSTOP of the running coordinator, the first native effect
 *  - unload: bootout, after which the old writer cannot resume
 *  - start: launchctl bootstrap, which executes this runtime as the candidate
 *  - release: the succeeded transition that hands the installation to it
 */
export const RUNTIME_CUSTODY_BOUNDARIES = [
  "admission",
  "freeze",
  "unload",
  "start",
  "release",
] as const;
export type RuntimeCustodyBoundary = (typeof RUNTIME_CUSTODY_BOUNDARIES)[number];
export type RequireRuntimeCustody = (boundary: RuntimeCustodyBoundary) => Promise<void>;

/** The runtime tree and the digest admission accepted for it. Never re-derived. */
export interface RuntimeCustody {
  runtimeDirectory: string;
  runtimeSha256: string;
}

/** Each boundary compares a fresh full digest with the admitted value and fails closed. */
export function createRuntimeCustody(input: {
  custody: RuntimeCustody;
  digest(directory: string): Promise<string>;
}): RequireRuntimeCustody {
  const custody: Readonly<RuntimeCustody> = Object.freeze({ ...input.custody });
  return async (boundary) => {
    if ((await input.digest(custody.runtimeDirectory)) !== custody.runtimeSha256)
      throw new BootstrapRequestConflict(
        `Coordinator runtime changed after admission; refused before ${boundary}`,
      );
  };
}

/** The release boundary: after every check releaseReplacement makes, the digest is
 * the last await before the executor records succeeded. Apply before timing wrappers. */
export function guardReleaseWithRuntimeCustody(
  operations: BootstrapExecutorOperations,
  requireRuntimeCustody: RequireRuntimeCustody,
): void {
  const release = operations.releaseReplacement;
  operations.releaseReplacement = async (request) => {
    await release.call(operations, request);
    await requireRuntimeCustody("release");
  };
}

/** Digest in a fresh bounded reader, as retained renewal verification does: it holds
 * no lock or effect authority, and its timeout terminates even a stalled wait. */
export async function digestRuntimeInChild(node: string, directory: string): Promise<string> {
  const artifact = new URL("./coordinator-bootstrap-artifact.js", import.meta.url).href;
  const source = `
import { readFileSync } from "node:fs";
import { digestBootstrapArtifact } from ${JSON.stringify(artifact)};
const directory = readFileSync(0, "utf8");
process.stdout.write("runtime:" + (await digestBootstrapArtifact(directory)) + "\\n");
`;
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const fail = () =>
      reject(new BootstrapRequestConflict("Bounded runtime verification did not complete"));
    const child = spawn(node, ["--input-type=module", "--eval", source], {
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    child.stdin.on("error", () => {});
    child.stdout.on("data", (bytes: Buffer) => {
      output = (output + bytes.toString("utf8")).slice(0, 128);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      const digest = /^runtime:([a-f0-9]{64})\n$/.exec(output)?.[1];
      if (code === 0 && signal === null && digest) resolve(digest);
      else fail();
    });
    child.stdin.end(directory);
  });
}
