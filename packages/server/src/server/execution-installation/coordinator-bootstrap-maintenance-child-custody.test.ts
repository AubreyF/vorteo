import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createMaintenanceChildCustody } from "./coordinator-bootstrap-maintenance-child-custody.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test
  .skipIf(process.platform !== "darwin")
  .each(["valid", "other-pid", "other-parent", "other-uid", "other-birth", "changed-helper"])(
  "native recovery child custody: %s",
  async (mode) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "maintenance-child-")));
    roots.push(root);
    const helper = readFileSync(path.resolve("scripts/inspect-coordinator-process.py"));
    const helperPath = path.join(root, "inspector.py");
    writeFileSync(helperPath, helper, { mode: 0o600 });
    const expected = JSON.parse(
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
    );
    if (mode === "other-pid") expected.pid++;
    if (mode === "other-parent") expected.parentPid++;
    if (mode === "other-uid") expected.uid++;
    if (mode === "other-birth") expected.startIdentity += "-changed";
    const result = createMaintenanceChildCustody({
      expected,
      helperPath,
      helperSha256: createHash("sha256").update(helper).digest("hex"),
      writableMountRoots: [],
    });
    if (mode.startsWith("other-")) {
      await expect(result).rejects.toThrow();
      return;
    }
    const custody = await result;
    expect(custody.process).toEqual(expected);
    custody.assertCurrent();
    if (mode === "changed-helper") {
      writeFileSync(helperPath, "print('{}')");
      expect(custody.assertCurrent).toThrow();
    }
  },
);
