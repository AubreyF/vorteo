import { lstatSync } from "node:fs";
import { z } from "zod";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  CoordinatorBootstrapPreparationSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";
import {
  BootstrapAdmissionSetupSchema,
  createBootstrapReviewService,
  inspectBootstrapWritableMountRoots,
  readPrivateBootstrapConfiguration,
} from "./coordinator-bootstrap-host.js";
import {
  assertBootstrapPathsProtected,
  digestBootstrapArtifact,
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";
import {
  BootstrapRunnerSetupSchema,
  waitForBootstrapWatchdog,
} from "./coordinator-bootstrap-runner.js";

/** Existing Host launchers already provide the private installation client.
 * Discover only its fixed sibling, so routine worker delivery needs no plist reload. */
export async function createConfiguredBootstrapReview(
  daemonId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapReviewService | undefined> {
  let setup = environment.VORTEO_COORDINATOR_BOOTSTRAP_SETUP;
  const client = environment.VORTEO_INSTALLATION_CLIENT_CONFIG;
  if (!setup && client) {
    const uid = process.getuid?.();
    if (process.platform !== "darwin" || uid === undefined) return undefined;
    const identity = z
      .object({ kind: z.string() })
      .parse(readPrivateBootstrapConfiguration(client, uid));
    if (identity.kind !== "host-agent") return undefined;
    setup = path.join(path.dirname(client), "coordinator-bootstrap-runner.json");
    try {
      lstatSync(setup);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  return createManagedBootstrapReview(setup, daemonId);
}

/** Launcher configuration, never an RPC, supplies the runner setup. Existing
 * approvals are not scanned or replayed after a Host daemon restart. */
export async function createManagedBootstrapReview(
  setupFile: string | undefined,
  daemonId: string,
): Promise<BootstrapReviewService | undefined> {
  if (!setupFile) return undefined;
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host bootstrap launch required");
  const readSetup = () =>
    BootstrapRunnerSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const setup = readSetup();
  if (setup.daemonId !== daemonId)
    throw new BootstrapRequestConflict("Bootstrap setup belongs to another daemon");
  const readAdmission = () =>
    BootstrapAdmissionSetupSchema.parse(
      readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
    );
  const admission = readAdmission();
  const verifySetup = async () => {
    if (!isDeepStrictEqual(setup, readSetup()) || !isDeepStrictEqual(admission, readAdmission()))
      throw new BootstrapRequestConflict("Bootstrap launch setup changed");
    const roots = await inspectBootstrapWritableMountRoots(admission);
    await assertBootstrapPathsProtected(
      [setupFile, setup.admissionSetupFile, setup.runtimeDirectory],
      roots,
    );
    const relative = path.relative(setup.runtimeDirectory, setup.entrypoint.path);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new BootstrapRequestConflict("Bootstrap runner is outside its prepared runtime");
    for (const file of [setup.entrypoint, setup.ownerLauncher, setup.ownershipVerifier])
      await readBootstrapPreparedFile(file, roots);
    if ((await digestBootstrapArtifact(setup.runtimeDirectory)) !== setup.runtimeSha256)
      throw new BootstrapRequestConflict("Bootstrap runner artifact changed");
    return roots;
  };
  await verifySetup();
  const requests = await createBootstrapReviewService(setup.admissionSetupFile, daemonId);
  const verifyCandidate = async (request: Pick<CoordinatorBootstrapRequest, "plan">) => {
    const candidate = request.plan.candidate;
    if (
      candidate.directory !== setup.runtimeDirectory ||
      candidate.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(candidate.node, setup.node)
    )
      throw new BootstrapRequestConflict("Bootstrap request does not match the installed runner");
    await verifyBootstrapReleaseArtifacts(candidate, await verifySetup());
  };
  return {
    list: () => requests.list(),
    prepare: async (input) => {
      const prepared = CoordinatorBootstrapPreparationSchema.parse(input);
      await verifyCandidate(prepared);
      return requests.prepare(prepared);
    },
    decide: async (input, password) => {
      const request = await requests.decide(input, password);
      if (request.status !== "approved") return request;
      await verifyCandidate(request);
      const source = await readBootstrapPreparedFile(setup.ownerLauncher, await verifySetup());
      const current = requests.list().find((item) => item.id === request.id);
      if (!current || current.revision !== request.revision || current.execution)
        throw new BootstrapRequestConflict("Bootstrap decision changed before launch");
      const child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          source.toString("utf8"),
          path.join(request.plan.state.directory, "coordinator-bootstrap-execution.lock"),
          setup.node.path,
          setup.entrypoint.path,
          setupFile,
          "executor",
          request.id,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
      );
      child.on("error", () => {});
      try {
        await waitForBootstrapWatchdog(child, "executor");
      } catch {
        // An observation failure is not permission to signal or relaunch a child.
        throw new BootstrapRequestConflict(
          "Bootstrap dispatch is unconfirmed. Refresh its recorded status before recovery.",
        );
      } finally {
        child.stdout?.destroy();
        child.unref();
      }
      const dispatched = requests.list().find((item) => item.id === request.id);
      if (!dispatched?.execution)
        throw new BootstrapRequestConflict("Bootstrap dispatch receipt is unavailable");
      return dispatched;
    },
  };
}
