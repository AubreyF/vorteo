import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";

/** The one-generation runner has already verified its module and exact argv.
 * Bind that lifetime to a synchronous native assertion for lock-held admission
 * and runtime inventory. This never exempts an arbitrary caller-selected PID. */
export async function createMaintenanceChildCustody(input: {
  expected: unknown;
  helperPath: string;
  helperSha256: string;
  writableMountRoots: readonly string[];
}) {
  const expected = BootstrapProcessIdentitySchema.parse(input.expected);
  if (
    expected.pid !== process.pid ||
    expected.parentPid !== process.ppid ||
    expected.uid !== process.getuid?.() ||
    expected.executable !== realpathSync(process.execPath)
  )
    throw new BootstrapRequestConflict("Recovery child custody requires this native lifetime");
  const assertFiles = retainServiceFiles([input.helperPath, expected.executable]);
  const helper = await readBootstrapPreparedFile(
    { path: input.helperPath, sha256: input.helperSha256 },
    input.writableMountRoots,
  );
  const assertCurrent = () => {
    assertFiles();
    const actual = BootstrapProcessIdentitySchema.parse(
      JSON.parse(
        execFileSync(
          "/usr/bin/python3",
          ["-I", "-B", "-c", helper.toString("utf8"), String(process.pid)],
          {
            env: { PATH: "/usr/bin:/bin" },
            timeout: 2000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
          },
        ),
      ),
    );
    if (!isDeepStrictEqual(actual, expected))
      throw new BootstrapRequestConflict("Recovery child native lifetime changed");
    assertFiles();
  };
  assertCurrent();
  return { process: expected, assertCurrent };
}
