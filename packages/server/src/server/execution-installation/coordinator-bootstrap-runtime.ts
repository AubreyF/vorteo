import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import type { BootstrapExecutorOperations } from "./coordinator-bootstrap-executor.js";
import { BootstrapRequestConflict, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import { createBootstrapNativeLifecycle } from "./coordinator-bootstrap-native.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import {
  inspectBootstrapWritableMountRoots,
  type BootstrapAdmissionHost,
} from "./coordinator-bootstrap-host.js";
import { InstallationConfigSchema } from "./config.js";

/** Protected Host setup supplies every dependency here. The RPC boundary must
 * never accept these paths, descriptors or launch callbacks from a client. */
export async function createBootstrapNativeOperations(input: {
  requests: CoordinatorBootstrapRequests;
  approved: CoordinatorBootstrapRequest;
  host: BootstrapAdmissionHost;
  descriptor: number;
  lockFile: string;
  ownershipVerifier: { path: string; sha256: string };
  verifySetup(): Promise<void>;
  armWatchdog(request: CoordinatorBootstrapRequest): Promise<void>;
}): Promise<BootstrapExecutorOperations> {
  const writableMountRoots = () => inspectBootstrapWritableMountRoots(input.host);
  const requireOwnership = async () => {
    await input.verifySetup();
    await requireBootstrapOwnership({
      descriptor: input.descriptor,
      lockFile: input.lockFile,
      verifier: input.ownershipVerifier,
      writableMountRoots: await writableMountRoots(),
    });
  };
  await requireOwnership();
  const roots = await writableMountRoots();
  const bytes = await readBootstrapPreparedFile(input.approved.plan.candidate.configuration, roots);
  const config = InstallationConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    config.public.installationId !== input.approved.plan.installationId ||
    config.stateDir !== input.approved.plan.state.directory
  )
    throw new BootstrapRequestConflict(
      "Replacement configuration does not match the approved installation",
    );
  const reader = await createNativeBootstrapServiceReader({
    ...input.host,
    writableMountRoots: roots,
  });
  const native = createBootstrapNativeLifecycle({
    requests: input.requests,
    reader,
    configurationFile: input.host.configurationFile,
    launcherFile: input.host.launcherFile,
    writableMountRoots,
    requireOwnership,
    readHealth: () => readBootstrapHealth(config.listenPort),
  });
  const requireRequest = async (request: CoordinatorBootstrapRequest) => {
    await requireOwnership();
    if (
      request.id !== input.approved.id ||
      request.planSha256 !== input.approved.planSha256 ||
      !isDeepStrictEqual(request.plan, input.approved.plan)
    )
      throw new BootstrapRequestConflict("Native executor received a different approved plan");
  };
  return {
    ...native,
    async withOwnership(request, operation) {
      await requireRequest(request);
      return operation();
    },
    async armWatchdog(request) {
      await requireRequest(request);
      await input.armWatchdog(request);
      await requireRequest(request);
    },
    async releaseReplacement(request) {
      // The executor's durable succeeded transition releases the startup fence.
      // Recheck before that write; this operation never sends a release RPC.
      await requireRequest(request);
      await native.verifyReplacement(request);
    },
  };
}

/** Probe only the fixed loopback listener. Redirects and unbounded response
 * bodies cannot turn readiness into an arbitrary network fetch. */
export async function readBootstrapHealth(port: number): Promise<unknown> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new BootstrapRequestConflict("Invalid coordinator readiness port");
  const response = await fetch(`http://127.0.0.1:${port}/api/installation/health`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new BootstrapRequestConflict("Replacement coordinator readiness is unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 16 * 1024)
        throw new BootstrapRequestConflict(
          "Replacement coordinator readiness response is too large",
        );
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
