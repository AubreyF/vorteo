import { spawn } from "node:child_process";
import { fstatSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  readBootstrapPreparedFile,
  assertBootstrapPathsProtected,
} from "./coordinator-bootstrap-artifact.js";

/** The runner receives this descriptor from the fixed ownership launcher, never
 * from a review request. The verifier runs captured, digest-checked bytes. */
export async function requireBootstrapOwnership(input: {
  descriptor: number;
  lockFile: string;
  verifier: { path: string; sha256: string };
  writableMountRoots: readonly string[];
}): Promise<void> {
  if (
    process.platform !== "darwin" ||
    !process.getuid ||
    !Number.isSafeInteger(input.descriptor) ||
    input.descriptor < 3
  )
    throw new BootstrapRequestConflict("Native bootstrap ownership descriptor required");
  if (
    path.basename(input.lockFile) !== "coordinator-bootstrap-execution.lock" ||
    realpathSync(input.lockFile) !== input.lockFile
  )
    throw new BootstrapRequestConflict("Bootstrap ownership path changed");
  await assertBootstrapPathsProtected([input.lockFile], input.writableMountRoots);
  const source = await readBootstrapPreparedFile(input.verifier, input.writableMountRoots);
  const before = fstatSync(input.descriptor);
  const current = lstatSync(input.lockFile);
  if (
    !before.isFile() ||
    before.uid !== process.getuid() ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.dev !== current.dev ||
    before.ino !== current.ino
  )
    throw new BootstrapRequestConflict("Bootstrap ownership descriptor changed");
  await new Promise<void>((resolve, reject) => {
    const fail = () =>
      reject(new BootstrapRequestConflict("Bootstrap kernel ownership verification failed"));
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-B", "-c", source.toString("utf8"), input.lockFile],
      {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "ignore", "ignore", input.descriptor],
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else fail();
    });
  });
  const after = fstatSync(input.descriptor);
  const selected = lstatSync(input.lockFile);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.dev !== selected.dev ||
    before.ino !== selected.ino
  )
    throw new BootstrapRequestConflict("Bootstrap ownership changed during verification");
}
