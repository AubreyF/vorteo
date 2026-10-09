import { afterEach, expect, test } from "vitest";
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NativeHelperPlanSchema } from "@getpaseo/protocol/native-helper-maintenance";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import { verifyNativeHelperState } from "./native-helper-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "helper-state-")));
  roots.push(home);
  const installationId = "00000000-0000-4000-8000-000000000001";
  const digest = "a".repeat(64);
  const file = { path: path.join(home, "tooling/tool"), sha256: digest };
  const plan = NativeHelperPlanSchema.parse({
    version: 1,
    operation: "native-helper-install",
    installationId,
    candidate: {
      sourceCommit: "b".repeat(40),
      directory: path.join(home, "candidate.app"),
      artifactSha256: digest,
      signingMode: "local",
      helperRequirement: "fixture",
      clientRequirement: "fixture",
    },
    previous: null,
    retainedRollback: null,
    tooling: {
      sourceCommit: "b".repeat(40),
      directory: path.join(home, "tooling"),
      artifactSha256: digest,
      node: file,
      installer: file,
      dispatcher: file,
      invocationClient: file,
    },
    destination: {
      application: path.join(home, "Applications/Vorteo Permission Helper.app"),
      runtime: path.join(home, ".local/share/vorteo-macos-helper"),
    },
    expectedState: {
      configurationSha256: null,
      policySha256: null,
      installationReceiptSha256: null,
    },
  });
  const admission = { home, installationId, writableMountRoots: [] as string[] };
  async function stateFile(name: string, content: string) {
    await mkdir(plan.destination.runtime, { recursive: true, mode: 0o700 });
    await writeFile(path.join(plan.destination.runtime, name), content, { mode: 0o600 });
    return createHash("sha256").update(content).digest("hex");
  }
  async function installed() {
    await mkdir(plan.destination.application, { recursive: true, mode: 0o700 });
    await writeFile(path.join(plan.destination.application, "bundle"), "old bytes", {
      mode: 0o600,
    });
    const retained = path.join(home, "retained-current.app");
    await cp(plan.destination.application, retained, { recursive: true });
    plan.previous = {
      ...plan.candidate,
      directory: retained,
      artifactSha256: await digestBootstrapArtifact(retained),
    };
    plan.expectedState.configurationSha256 = await stateFile(
      "config.json",
      '{"fixture":"private"}',
    );
  }
  return { plan, admission, stateFile, installed };
}

test("initial helper state verification creates no installation paths", async () => {
  const f = await fixture();
  await expect(verifyNativeHelperState(f.plan, f.admission)).resolves.toBeUndefined();
  await expect(realpath(f.plan.destination.application)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(realpath(f.plan.destination.runtime)).rejects.toMatchObject({ code: "ENOENT" });
});

test("helper base checks preserve private files and reject changed policy bytes", async () => {
  const f = await fixture();
  await f.installed();
  f.plan.expectedState.policySha256 = await f.stateFile(
    "browser-policy.json",
    '{"fixture":"policy"}',
  );
  await expect(verifyNativeHelperState(f.plan, f.admission)).resolves.toBeUndefined();
  await f.stateFile("browser-policy.json", '{"fixture":"changed"}');
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("digest changed");
});

test("helper state refuses unrecorded releases and requires independently retained rollback", async () => {
  const f = await fixture();
  await f.installed();
  const slot = f.plan.destination.application + ".previous";
  await cp(f.plan.destination.application, slot, { recursive: true });
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow(
    "requires preservation",
  );
  const retained = path.join(f.admission.home, "retained-older.app");
  await cp(slot, retained, { recursive: true });
  f.plan.retainedRollback = {
    directory: retained,
    artifactSha256: await digestBootstrapArtifact(retained),
  };
  await expect(verifyNativeHelperState(f.plan, f.admission)).resolves.toBeUndefined();
  await writeFile(path.join(slot, "bundle"), "different release");
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("rollback changed");
});

test("helper base checks refuse locks, staging and mutable rollback locations without deleting them", async () => {
  const f = await fixture();
  await f.installed();
  for (const suffix of [".staged", ".install-lock"]) {
    const residue = f.plan.destination.application + suffix;
    await mkdir(residue);
    await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("needs inspection");
    expect(await realpath(residue)).toBe(residue);
    await rm(residue, { recursive: true });
  }
  f.plan.previous = { ...f.plan.candidate, directory: f.plan.destination.application };
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("outside mutable");
});

test("helper destinations refuse changed installation identity, redirection and writable guest paths", async () => {
  const f = await fixture();
  await expect(
    verifyNativeHelperState(f.plan, { ...f.admission, installationId: "different" }),
  ).rejects.toThrow("another installation");
  await expect(
    verifyNativeHelperState(f.plan, { ...f.admission, writableMountRoots: [f.admission.home] }),
  ).rejects.toThrow("container mount");
  const redirected = path.join(f.admission.home, "redirected");
  await mkdir(redirected);
  await symlink(redirected, path.join(f.admission.home, "Applications"));
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("unsafe Host parent");
});

test("helper private state refuses permissive files and unexpected state appearance", async () => {
  const f = await fixture();
  await f.stateFile("config.json", "{}");
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow(
    "appeared after preparation",
  );
  await f.installed();
  await chmod(path.join(f.plan.destination.runtime, "config.json"), 0o644);
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("unsafe permissions");
});

test("rollback admission requires the exact retained previous slot and preserves private state", async () => {
  const f = await fixture();
  f.plan.operation = "native-helper-rollback";
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow(
    "exact independently retained",
  );
  await f.installed();
  const slot = f.plan.destination.application + ".previous";
  await cp(f.plan.destination.application, slot, { recursive: true });
  await writeFile(path.join(slot, "bundle"), "older selected release");
  const retained = path.join(f.admission.home, "retained-rollback.app");
  await cp(slot, retained, { recursive: true });
  f.plan.retainedRollback = {
    directory: retained,
    artifactSha256: await digestBootstrapArtifact(retained),
  };
  f.plan.candidate = { ...f.plan.candidate, ...f.plan.retainedRollback };
  await expect(verifyNativeHelperState(f.plan, f.admission)).resolves.toBeUndefined();
  await writeFile(path.join(slot, "bundle"), "unreviewed previous release");
  await expect(verifyNativeHelperState(f.plan, f.admission)).rejects.toThrow("rollback changed");
});
