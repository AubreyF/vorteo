import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeHelperPlanSchema } from "@getpaseo/protocol/native-helper-maintenance";
import { runNativeHelperCommand } from "./native-helper-command.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(source: string) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "helper-command-")));
  roots.push(home);
  const installer = path.join(home, "install.mjs");
  await writeFile(installer, source);
  await mkdir(path.join(home, "runtime"));
  await writeFile(path.join(home, "runtime/invoke.mjs"), source);
  const digest = "a".repeat(64),
    file = { path: installer, sha256: digest };
  const plan = NativeHelperPlanSchema.parse({
    version: 1,
    operation: "native-helper-install",
    installationId: "00000000-0000-4000-8000-000000000001",
    candidate: {
      sourceCommit: "b".repeat(40),
      directory: path.join(home, "candidate with spaces.app"),
      artifactSha256: digest,
      signingMode: "local",
      helperRequirement: "fixture",
      clientRequirement: "fixture",
    },
    previous: null,
    retainedRollback: null,
    tooling: {
      sourceCommit: "b".repeat(40),
      directory: home,
      artifactSha256: digest,
      node: { path: process.execPath, sha256: digest },
      installer: file,
      dispatcher: file,
      invocationClient: file,
    },
    destination: {
      application: path.join(home, "Helper.app"),
      runtime: path.join(home, "runtime"),
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  });
  const installerPids: number[] = [];
  const exits: unknown[] = [];
  return {
    home,
    plan,
    installerPids,
    exits,
    recordInstallerExit: (exit: unknown) => {
      exits.push(exit);
    },
    recordInstaller: (pid: number) => {
      installerPids.push(pid);
    },
  };
}
test("helper command uses exact arguments and an isolated environment with no shell", async () => {
  const f = await fixture(
    "console.log(JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()}));",
  );
  const installed = JSON.parse(await runNativeHelperCommand({ ...f, operation: "install" }));
  expect(installed.args).toEqual(["install", f.plan.candidate.directory, "--local-signing"]);
  expect(f.exits).toEqual([{ code: 0, signal: null }]);
  expect(installed.cwd).toBe(f.home);
  expect(f.installerPids).toHaveLength(1);
  expect(f.installerPids[0]).toBeGreaterThan(0);
  expect(installed.env.HOME).toBe(f.home);
  expect(installed.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  expect(installed.env.NODE_OPTIONS).toBeUndefined();
  expect(installed.env.VORTEO_INSTALLATION_CLIENT_CONFIG).toBeUndefined();
  const status = JSON.parse(await runNativeHelperCommand({ ...f, operation: "status" }));
  expect(status.args).toEqual(["status"]);
});
test("helper command failure never returns a success or diagnostic payload", async () => {
  const f = await fixture('console.log("private fixture sentinel");process.exitCode=1;');
  await expect(runNativeHelperCommand({ ...f, operation: "install" })).rejects.toThrow(
    "outcome is unresolved",
  );
});
test("timed out helper execution is not repeated or automatically killed", async () => {
  const f = await fixture(
    'import {appendFileSync} from "node:fs";appendFileSync("events","started\\n");setTimeout(()=>{appendFileSync("events","finished\\n");},100);',
  );
  await expect(
    runNativeHelperCommand({ ...f, operation: "install", timeoutMs: 50 }),
  ).rejects.toThrow("unresolved");
  // Wait for the owned fixture to finish itself, never terminate an installed helper.
  await expect
    .poll(async () => readFile(path.join(f.home, "events"), "utf8"))
    .toBe("started\nfinished\n");
  await expect.poll(() => f.exits).toEqual([{ code: 0, signal: null }]);
});

test("reviewed rollback invokes only the fixed rollback operation", async () => {
  const f = await fixture("console.log(JSON.stringify(process.argv.slice(2)));");
  f.plan.operation = "native-helper-rollback";
  const output = await runNativeHelperCommand({ ...f, operation: "install" });
  expect(JSON.parse(output)).toEqual(["rollback", "--local-signing"]);
  expect(f.exits).toEqual([{ code: 0, signal: null }]);
});
