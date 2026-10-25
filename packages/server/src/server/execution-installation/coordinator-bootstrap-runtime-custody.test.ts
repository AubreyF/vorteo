import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  CoordinatorBootstrapPlan,
  CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { digestBootstrapArtifact } from "./coordinator-bootstrap-artifact.js";
import type { BootstrapExecutorOperations } from "./coordinator-bootstrap-executor.js";
import * as host from "./coordinator-bootstrap-host.js";
import * as renewalModule from "./coordinator-bootstrap-renewal.js";
import { runnerRenewal, type BootstrapRunnerSetupSchema } from "./coordinator-bootstrap-runner.js";
import * as custodyModule from "./coordinator-bootstrap-runtime-custody.js";
import {
  RUNTIME_CUSTODY_BOUNDARIES,
  createRuntimeCustody,
  guardReleaseWithRuntimeCustody,
} from "./coordinator-bootstrap-runtime-custody.js";
import type { z } from "zod";

vi.mock("./coordinator-bootstrap-renewal.js", async (original) => ({
  ...(await original<typeof import("./coordinator-bootstrap-renewal.js")>()),
  verifyRetainedRenewal: vi.fn(async () => {}),
  deriveBootstrapRenewal: vi.fn(),
  verifyRenewalPlan: vi.fn(async () => {}),
  retainRenewalGeneration: vi.fn(async () => {}),
}));
vi.mock("./coordinator-bootstrap-runtime-custody.js", async (original) => ({
  ...(await original<typeof import("./coordinator-bootstrap-runtime-custody.js")>()),
  digestRuntimeInChild: vi.fn(),
}));
vi.mock("./coordinator-bootstrap-host.js", async (original) => ({
  ...(await original<typeof import("./coordinator-bootstrap-host.js")>()),
  readPrivateBootstrapConfiguration: vi.fn(),
}));

type RunnerSetup = z.infer<typeof BootstrapRunnerSetupSchema>;
const digest = (character: string) => character.repeat(64);
const file = (name: string) => ({ path: `/protected/${name}`, sha256: digest("a") });

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-custody-")));
  vi.clearAllMocks();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function runtimeTree() {
  const runtime = path.join(root, "runtime");
  mkdirSync(path.join(runtime, "dist"), { recursive: true });
  writeFileSync(path.join(runtime, "dist/main.js"), "export {};");
  writeFileSync(path.join(runtime, "package.json"), "{}");
  return runtime;
}

function renewalSetup(maintenance = false): RunnerSetup {
  const reference = {
    id: randomUUID(),
    revision: randomUUID(),
    generation: randomUUID(),
    planSha256: digest("b"),
  };
  return {
    admissionSetupFile: "/protected/admission.json",
    daemonId: "host-id",
    node: file("node"),
    entrypoint: file("runtime/runner.js"),
    ownerLauncher: file("runtime/owner.py"),
    ownershipVerifier: file("runtime/verifier.py"),
    runtimeDirectory: "/protected/runtime",
    runtimeSha256: digest("c"),
    renewal: {
      version: 1,
      originalSetup: file("original-setup.json"),
      originalAdmission: file("admission.json"),
      terminal: reference,
      configuration: file("config.json"),
      sourceCommit: "d".repeat(40),
      source: file("runtime/.installation-source.json"),
      hostProcess: {
        pid: 10,
        parentPid: 1,
        uid: process.getuid!(),
        bootId: randomUUID(),
        startIdentity: "1:2",
        argumentsSha256: digest("e"),
        executable: "/protected/node",
      },
      request: { id: randomUUID(), revision: randomUUID(), planSha256: digest("f") },
    },
    ...(maintenance
      ? {
          maintenance: { installationRoot: "/protected/maintenance", admissionSha256: digest("9") },
        }
      : {}),
  };
}

const admission = {
  configurationFile: "/protected/config.json",
  launcherFile: "/protected/launcher.plist",
  docker: "/protected/docker",
  socket: "/protected/docker.sock",
  containerId: digest("a"),
  helperPath: "/protected/helper.py",
  helperSha256: digest("a"),
};

/** Drive one runner's renewal fences in the order an executor reaches them:
 * admission, setup fences, the claim, the watchdog arm and the post-dispatch fences. */
async function runFences(setup: RunnerSetup, role: "executor" | "watchdog") {
  vi.mocked(host.readPrivateBootstrapConfiguration).mockReturnValue(setup);
  vi.mocked(renewalModule.deriveBootstrapRenewal).mockResolvedValue(setup);
  vi.mocked(custodyModule.digestRuntimeInChild).mockResolvedValue(setup.runtimeSha256);
  const fences = runnerRenewal(setup, "/protected/setup.json", role, admission, (_phase, run) =>
    run(),
  );
  const request = {
    ...setup.renewal!.request,
    plan: {},
    execution: { generation: randomUUID() },
  } as unknown as CoordinatorBootstrapRequest;
  await fences.verifyApproval(request);
  for (let fence = 0; fence < 3; fence++) await fences.verify();
  await fences.options?.verify({} as CoordinatorBootstrapPlan);
  for (let fence = 0; fence < 3; fence++) await fences.verify();
  fences.markDispatched(request);
  for (let fence = 0; fence < 20; fence++) await fences.verify();
  return fences;
}

test("an ordinary renewal executor digests the runtime once in its fences and derives once, at the claim", async () => {
  const fences = await runFences(renewalSetup(), "executor");
  // Admission is the only runner-side digest. Freeze, unload, start and release
  // add one each through requireRuntimeCustody, pinned below: five per renewal.
  expect(custodyModule.digestRuntimeInChild).toHaveBeenCalledTimes(1);
  expect(renewalModule.deriveBootstrapRenewal).toHaveBeenCalledTimes(1);
  // Every fence keeps the cheap retained checks, without the tree digest.
  expect(renewalModule.verifyRetainedRenewal).toHaveBeenCalledTimes(1 + 3 + 1 + 3 + 20);
  for (const call of vi.mocked(renewalModule.verifyRetainedRenewal).mock.calls)
    expect(call.slice(2)).toEqual([false, false]);
  expect(fences.requireRuntimeCustody).toBeDefined();
  for (const boundary of ["freeze", "unload", "start", "release"] as const)
    await fences.requireRuntimeCustody!(boundary);
  expect(custodyModule.digestRuntimeInChild).toHaveBeenCalledTimes(
    RUNTIME_CUSTODY_BOUNDARIES.length,
  );
  expect(RUNTIME_CUSTODY_BOUNDARIES).toEqual(["admission", "freeze", "unload", "start", "release"]);
});

test("watchdog and maintenance runners keep their existing per-fence checks", async () => {
  const watchdog = await runFences(renewalSetup(), "watchdog");
  expect(watchdog.requireRuntimeCustody).toBeUndefined();
  expect(renewalModule.deriveBootstrapRenewal).not.toHaveBeenCalled();
  for (const call of vi.mocked(renewalModule.verifyRetainedRenewal).mock.calls)
    expect(call.slice(2)).toEqual([true, true]);

  vi.clearAllMocks();
  // Maintenance keeps the tree digest in every retained check and gets no boundaries.
  // Its pre-dispatch derivation path is unchanged and needs a live admission to run.
  const setup = renewalSetup(true);
  const maintenance = runnerRenewal(
    setup,
    "/protected/setup.json",
    "executor",
    admission,
    (_phase, run) => run(),
  );
  expect(maintenance.requireRuntimeCustody).toBeUndefined();
  const request = { ...setup.renewal!.request } as unknown as CoordinatorBootstrapRequest;
  await maintenance.verifyApproval(request);
  maintenance.markDispatched(request);
  for (let fence = 0; fence < 3; fence++) await maintenance.verify();
  expect(custodyModule.digestRuntimeInChild).not.toHaveBeenCalled();
  expect(renewalModule.verifyRetainedRenewal).toHaveBeenCalledTimes(4);
  for (const call of vi.mocked(renewalModule.verifyRetainedRenewal).mock.calls)
    expect(call.slice(2)).toEqual([false, true]);
});

test("a runtime change is refused at the next boundary against the admitted digest", async () => {
  const runtime = runtimeTree();
  const custody = {
    runtimeDirectory: runtime,
    runtimeSha256: await digestBootstrapArtifact(runtime),
  };
  const require = createRuntimeCustody({
    custody,
    digest: (directory) => digestBootstrapArtifact(directory),
  });
  // A caller's later change to its copy cannot move the admitted expectation.
  custody.runtimeSha256 = digest("0");
  for (const boundary of RUNTIME_CUSTODY_BOUNDARIES) await require(boundary);
  const changed = path.join(runtime, "dist/main.js");
  writeFileSync(changed, "export const changed = true;");
  for (const boundary of RUNTIME_CUSTODY_BOUNDARIES)
    await expect(require(boundary)).rejects.toThrow(
      `Coordinator runtime changed after admission; refused before ${boundary}`,
    );
  // A changed tree never becomes the new expectation; restoring it is accepted again.
  writeFileSync(changed, "export {};");
  await expect(require("release")).resolves.toBeUndefined();
});

test("the release boundary runs after every release check and its failure withholds release", async () => {
  const events: string[] = [];
  let changed = false;
  const operations = {
    releaseReplacement: async () => {
      events.push("release-checks");
    },
  } as unknown as BootstrapExecutorOperations;
  guardReleaseWithRuntimeCustody(operations, async (boundary) => {
    events.push(`custody:${boundary}`);
    if (changed) throw new Error("Coordinator runtime changed after admission");
  });
  const request = {} as CoordinatorBootstrapRequest;
  await operations.releaseReplacement(request);
  expect(events).toEqual(["release-checks", "custody:release"]);
  changed = true;
  await expect(operations.releaseReplacement(request)).rejects.toThrow("runtime changed");
  expect(events).toEqual([
    "release-checks",
    "custody:release",
    "release-checks",
    "custody:release",
  ]);
});
