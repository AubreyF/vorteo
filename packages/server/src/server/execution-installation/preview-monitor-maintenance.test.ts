import { mkdtemp, writeFile, rm, realpath, symlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { verifyPreviewMonitorPreparation } from "./preview-monitor-maintenance.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "preview-monitor-plan-")));
  directories.push(directory);
  const candidateBytes = Buffer.from("#!/usr/bin/env node\n// reviewed candidate\n");
  const previousBytes = Buffer.from("#!/usr/bin/env node\n// retained previous\n");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const candidate = {
    path: path.join(directory, "candidate.mjs"),
    sha256: digest(candidateBytes),
  };
  const previous = {
    path: path.join(directory, "previous.mjs"),
    sha256: digest(previousBytes),
  };
  await writeFile(candidate.path, candidateBytes, { mode: 0o600 });
  await writeFile(previous.path, previousBytes, { mode: 0o600 });
  const plan = {
    version: 1,
    operation: "preview-monitor-replace",
    installationId: "c0b4f130-ad18-4c3a-a490-3a507aff9a48",
    sourceCommit: "a".repeat(40),
    containerId: "b".repeat(64),
    destination: "/home/paseo/.local/bin/paseo-preview",
    ancestrySha256: "e".repeat(64),
    candidate,
    previous,
    expected: { sha256: previous.sha256, uid: 0, gid: 0, mode: 0o755 },
  };
  const admission = {
    installationId: plan.installationId,
    containerId: plan.containerId,
    containerHome: "/home/paseo",
    writableMountRoots: [] as string[],
    observed: {
      containerId: plan.containerId,
      destination: plan.destination,
      canonicalPath: plan.destination,
      sha256: previous.sha256,
      uid: 0,
      gid: 0,
      mode: 0o755,
      regularFile: true,
      links: 1,
      ancestrySha256: plan.ancestrySha256,
    },
  };
  return { plan, admission, candidateBytes, previousBytes };
}

it("returns only the sealed candidate and retained rollback bytes without executing them", async () => {
  const { plan, admission, candidateBytes, previousBytes } = await fixture();
  const prepared = await verifyPreviewMonitorPreparation(plan, admission);
  expect(prepared.candidate).toEqual(candidateBytes);
  expect(prepared.previous).toEqual(previousBytes);
  expect(prepared.plan).toEqual(plan);
  expect(prepared.planSha256).toMatch(/^[a-f0-9]{64}$/);
});

it.each([
  ["different installation", { installationId: "d0b4f130-ad18-4c3a-a490-3a507aff9a48" }],
  ["different container", { containerId: "c".repeat(64) }],
  ["arbitrary executable", { destination: "/home/paseo/.local/bin/another-program" }],
  ["aliased destination", { destination: "/home/paseo/.local/bin/../bin/paseo-preview" }],
  ["automatic approval", { approved: true }],
  ["restart disguised as monitor preparation", { operation: "container-daemon" }],
])("rejects %s in submitted plans", async (_label, changes) => {
  const { plan, admission } = await fixture();
  await expect(
    verifyPreviewMonitorPreparation({ ...plan, ...changes }, admission),
  ).rejects.toThrow();
});

it.each([
  ["container replaced", { containerId: "c".repeat(64) }],
  ["different target", { destination: "/home/paseo/.local/bin/other" }],
  ["symlink target", { canonicalPath: "/home/paseo/other" }],
  ["non-file target", { regularFile: false }],
  ["hard link target", { links: 2 }],
  ["changed installed bytes", { sha256: "c".repeat(64) }],
  ["changed ancestry", { ancestrySha256: "f".repeat(64) }],
  ["changed owner", { uid: 1000 }],
  ["changed group", { gid: 1000 }],
  ["writable executable", { mode: 0o777 }],
])("rejects %s from trusted target inspection", async (_label, changes) => {
  const { plan, admission } = await fixture();
  admission.observed = { ...admission.observed, ...changes };
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow();
});

it("requires independently retained rollback matching the current installed bytes", async () => {
  const { plan, admission } = await fixture();
  plan.previous.sha256 = plan.candidate.sha256;
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow(/rollback/);
});

it("rejects an unchanged candidate", async () => {
  const { plan, admission } = await fixture();
  plan.candidate = { ...plan.previous };
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow(/distinct/);
});

it.each(["candidate", "previous"] as const)("rejects replaced %s bytes", async (selection) => {
  const { plan, admission } = await fixture();
  await writeFile(plan[selection].path, "substituted bytes");
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow(/digest changed/);
});

it("rejects prepared code inside guest writable mounts", async () => {
  const { plan, admission } = await fixture();
  admission.writableMountRoots = [path.dirname(plan.candidate.path)];
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow(
    /writable container mount/,
  );
});

it.each(["symlink", "hardlink", "writable"])("rejects %s candidate artifacts", async (kind) => {
  const { plan, admission } = await fixture();
  const alias = plan.candidate.path + ".alias";
  if (kind === "symlink") {
    await symlink(plan.candidate.path, alias);
    plan.candidate.path = alias;
  } else if (kind === "hardlink") {
    await link(plan.candidate.path, alias);
  } else {
    await chmod(plan.candidate.path, 0o666);
  }
  await expect(verifyPreviewMonitorPreparation(plan, admission)).rejects.toThrow();
});

it("changes the plan digest when reviewed source changes", async () => {
  const { plan, admission } = await fixture();
  const before = await verifyPreviewMonitorPreparation(plan, admission);
  plan.sourceCommit = "f".repeat(40);
  const after = await verifyPreviewMonitorPreparation(plan, admission);
  expect(before.planSha256).not.toEqual(after.planSha256);
});
