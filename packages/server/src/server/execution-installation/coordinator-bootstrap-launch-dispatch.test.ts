import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import {
  digestBootstrapArtifact,
  withBootstrapArtifactReuse,
} from "./coordinator-bootstrap-artifact.js";
import { createDispatchingBootstrapReview } from "./coordinator-bootstrap-launch.js";

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: vi.fn(function (...args: ConstructorParameters<typeof actual.Worker>) {
      return new actual.Worker(...args);
    }),
  };
});

// Runtime launch evidence is covered by the runner suites; this file isolates
// which tree proofs an owner decision may carry into dispatch.
vi.mock("./coordinator-bootstrap-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./coordinator-bootstrap-runner.js")>()),
  verifyBootstrapExecutionRuntime: vi.fn(async () => {}),
}));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function treeScans(directory: string): number {
  return vi
    .mocked(Worker)
    .mock.calls.filter(
      ([, options]) =>
        options?.workerData?.role === "vorteo-artifact-scan" &&
        options.workerData.directory === directory,
    ).length;
}

async function dispatchFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bootstrap-dispatch-")));
  roots.push(root);
  const release = path.join(root, "release");
  await mkdir(release, { mode: 0o700 });
  await writeFile(path.join(release, "entry.js"), "export {};", { mode: 0o600 });
  await writeFile(
    path.join(release, ".installation-source.json"),
    JSON.stringify({ sourceCommit: "a".repeat(40) }),
    { mode: 0o600 },
  );
  const pinned = async (name: string, text: string, mode = 0o600) => {
    await writeFile(path.join(root, name), text, { mode });
    return { path: path.join(root, name), sha256: sha(text) };
  };
  const candidate = {
    sourceCommit: "a".repeat(40),
    directory: release,
    artifactSha256: await digestBootstrapArtifact(release),
    node: await pinned("node", "fixture executable", 0o700),
    entrypoint: { path: path.join(release, "entry.js"), sha256: sha("export {};") },
    configuration: await pinned("coordinator.json", "{}"),
    launcher: await pinned("launcher.plist", "fixture launcher"),
  };
  // A mismatched owner launcher stops dispatch after its candidate verification
  // and before any process launch.
  const ownerLauncher = { ...(await pinned("owner.py", "owner")), sha256: "0".repeat(64) };
  const request = {
    id: randomUUID(),
    revision: randomUUID(),
    planSha256: "b".repeat(64),
    status: "approved",
    plan: { candidate },
  };
  const decide = vi.fn(async () => request);
  const requests = { list: () => [request], decide };
  const review = createDispatchingBootstrapReview({
    setup: {
      admissionSetupFile: path.join(root, "admission.json"),
      daemonId: "host-id",
      node: candidate.node,
      entrypoint: candidate.entrypoint,
      ownerLauncher,
      ownershipVerifier: ownerLauncher,
      runtimeDirectory: release,
      runtimeSha256: candidate.artifactSha256,
    },
    setupFile: path.join(root, "setup.json"),
    requests: requests as unknown as Parameters<
      typeof createDispatchingBootstrapReview
    >[0]["requests"],
    verifySetup: async () => [],
  });
  const approval = {
    id: request.id,
    revision: request.revision,
    planSha256: request.planSha256,
    decision: "approve" as const,
  };
  return { release, review, approval, decide };
}

test("dispatch after an owner decision re-reads candidate bytes in full", async () => {
  const { release, review, approval, decide } = await dispatchFixture();
  vi.mocked(Worker).mockClear();
  await expect(review.decide(approval, "owner password")).rejects.toThrow(
    "Prepared document digest changed",
  );
  expect(decide).toHaveBeenCalledTimes(1);
  // One scan before the decision and a fresh one at launch, never a reused proof.
  expect(treeScans(release)).toBe(2);
});

test("dispatch does not join an enclosing reuse operation", async () => {
  const { release, review, approval } = await dispatchFixture();
  vi.mocked(Worker).mockClear();
  await withBootstrapArtifactReuse(async () => {
    await expect(review.decide(approval, "owner password")).rejects.toThrow(
      "Prepared document digest changed",
    );
  });
  expect(treeScans(release)).toBe(2);
});
