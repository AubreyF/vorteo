import { lstatSync } from "node:fs";
import { z } from "zod";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CoordinatorBootstrapPreparationSchema,
  CoordinatorBootstrapDecisionSchema,
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
import {
  deriveBootstrapRenewal,
  persistRenewalSetup,
  verifyRenewalPlan,
  verifyRetainedRenewal,
} from "./coordinator-bootstrap-renewal.js";

/** Artifact verification can outlast Host readiness. Keep all maintenance
 * operations fenced while it runs, then notify connected clients of the result. */
export function deferBootstrapReview(
  initialize: () => Promise<BootstrapReviewService | undefined>,
): BootstrapReviewService {
  let pending = true;
  let service: BootstrapReviewService | undefined;
  let failure: string | undefined;
  const listeners = new Set<() => void>();
  const reason = () =>
    pending
      ? "Checking coordinator maintenance availability. Host remains available while release verification finishes."
      : (failure ?? service?.unavailableReason);
  const ready = () => {
    if (pending || failure || !service || service.unavailableReason || service.available === false)
      throw new BootstrapRequestConflict(reason() ?? "Coordinator maintenance is not configured.");
    return service;
  };
  void Promise.resolve()
    .then(initialize)
    .then(
      (result) => {
        service = result;
        return undefined;
      },
      () => {
        failure =
          "Coordinator maintenance is unavailable: this Host could not validate its configuration.";
      },
    )
    .then(() => {
      pending = false;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // A failed notification cannot change validation or block other clients.
        }
      }
      return undefined;
    });
  return {
    get available() {
      return !pending && !failure && service !== undefined && service.available !== false;
    },
    get unavailableReason() {
      return reason();
    },
    subscribeAvailability(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: () => ready().list(),
    prepare: async (input) => ready().prepare(input),
    decide: async (input, password) => ready().decide(input, password),
  };
}

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
  try {
    return await createManagedBootstrapReview(setup, daemonId);
  } catch (error) {
    // Keep a safe diagnosis reachable through the existing review UI. In
    // particular an older Host must not rewrite history it cannot understand.
    const description =
      error instanceof BootstrapRequestConflict
        ? error.message
        : "Coordinator maintenance is unavailable: this Host cannot validate retained renewal evidence. Install a compatible Host reader; do not replay or rewrite history.";
    const unavailable = () => {
      throw new BootstrapRequestConflict(description);
    };
    return {
      unavailableReason: description,
      list: unavailable,
      prepare: async () => unavailable(),
      decide: async () => unavailable(),
    };
  }
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
  const original = readSetup();
  if (original.daemonId !== daemonId)
    throw new BootstrapRequestConflict("Bootstrap setup belongs to another daemon");
  if (original.renewal)
    throw new BootstrapRequestConflict(
      "Installed runner anchor cannot be a renewal execution snapshot",
    );
  const reconstruct = () =>
    deriveBootstrapRenewal({
      setupFile,
      setup: original,
      moduleFile: fileURLToPath(import.meta.url),
      hostPid: process.pid,
    });
  const setup = (await reconstruct()) ?? original;
  const readAdmission = () =>
    BootstrapAdmissionSetupSchema.parse(
      readPrivateBootstrapConfiguration(setup.admissionSetupFile, uid),
    );
  const admission = readAdmission();
  const verifySetup = async () => {
    if (!isDeepStrictEqual(original, readSetup()) || !isDeepStrictEqual(admission, readAdmission()))
      throw new BootstrapRequestConflict("Bootstrap launch setup changed");
    if (setup.renewal) {
      if (!isDeepStrictEqual(await reconstruct(), setup))
        throw new BootstrapRequestConflict("Host renewal context changed; prepare a fresh review");
      await verifyRetainedRenewal(setup);
    }
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
  const requests = await createBootstrapReviewService(
    setup.admissionSetupFile,
    daemonId,
    setup.renewal
      ? {
          setup: { ...admission, configurationFile: setup.renewal.configuration.path },
          verify: async (plan) => {
            await verifySetup();
            await verifyRenewalPlan(setup, plan);
          },
        }
      : undefined,
  );
  const verifyCandidate = async (request: Pick<CoordinatorBootstrapRequest, "plan">) => {
    const candidate = request.plan.candidate;
    if (
      candidate.directory !== setup.runtimeDirectory ||
      candidate.artifactSha256 !== setup.runtimeSha256 ||
      !isDeepStrictEqual(candidate.node, setup.node)
    )
      throw new BootstrapRequestConflict("Bootstrap request does not match the installed runner");
    await verifyBootstrapReleaseArtifacts(candidate, await verifySetup());
    await verifyRenewalPlan(setup, request.plan);
  };
  return {
    list: () => requests.list(),
    prepare: async (input) => {
      const prepared = CoordinatorBootstrapPreparationSchema.parse(input);
      await verifyCandidate(prepared);
      return requests.prepare(prepared);
    },
    decide: async (input, password) => {
      const decision = CoordinatorBootstrapDecisionSchema.parse(input);
      if (decision.decision === "approve") {
        const pending = requests.list().find((item) => item.id === decision.id);
        if (!pending) throw new BootstrapRequestConflict("Exact bootstrap review is unavailable");
        await verifyCandidate(pending);
      }
      const request = await requests.decide(input, password);
      if (request.status !== "approved") return request;
      await verifyCandidate(request);
      const source = await readBootstrapPreparedFile(setup.ownerLauncher, await verifySetup());
      const current = requests.list().find((item) => item.id === request.id);
      if (!current || current.revision !== request.revision || current.execution)
        throw new BootstrapRequestConflict("Bootstrap decision changed before launch");
      const executionSetup = setup.renewal
        ? persistRenewalSetup(request.plan.state.directory, setup, request)
        : setupFile;
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
          executionSetup,
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
