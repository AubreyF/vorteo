import { spawn } from "node:child_process";
import type { createBootstrapRunnerEvidence } from "./coordinator-bootstrap-evidence.js";
import { isDeepStrictEqual } from "node:util";
import type { CoordinatorBootstrapRequest } from "@getpaseo/protocol/coordinator-bootstrap";
import type { BootstrapExecutorOperations } from "./coordinator-bootstrap-executor.js";
import { BootstrapRequestConflict, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import {
  createBootstrapNativeLifecycle,
  type BootstrapManualProcessControl,
} from "./coordinator-bootstrap-native.js";
import { requireBootstrapOwnership } from "./coordinator-bootstrap-ownership.js";
import {
  createNativeBootstrapServiceReader,
  verifyBootstrapReplacement,
} from "./coordinator-bootstrap-service.js";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";
import {
  inspectBootstrapWritableMountRoots,
  type BootstrapAdmissionHost,
} from "./coordinator-bootstrap-host.js";
import { InstallationConfigSchema } from "./config.js";

/** Protected Host setup supplies every dependency here. The RPC boundary must
 * never accept these paths, descriptors or launch callbacks from a client. */
interface BootstrapNativeOperationsInput {
  requests: CoordinatorBootstrapRequests;
  approved: CoordinatorBootstrapRequest;
  host: BootstrapAdmissionHost;
  descriptor: number;
  lockFile: string;
  ownershipVerifier: { path: string; sha256: string };
  verifySetup(): Promise<void>;
  armWatchdog(request: CoordinatorBootstrapRequest): Promise<void>;
  evidence?: ReturnType<typeof createBootstrapRunnerEvidence>;
}

export async function createBootstrapNativeOperations(
  input: BootstrapNativeOperationsInput,
): Promise<BootstrapExecutorOperations> {
  if (input.approved.plan.supervisionRecovery)
    throw new BootstrapRequestConflict(
      "Supervision recovery requires the exact unregistered-process executor",
    );
  return createNativeOperations(input);
}

/** The protected supervision runner is the only caller of this explicit mode. */
export async function createBootstrapSupervisionNativeOperations(
  input: BootstrapNativeOperationsInput & { ownerLauncher: { path: string; sha256: string } },
): Promise<BootstrapExecutorOperations> {
  if (!input.approved.plan.supervisionRecovery || !input.approved.supervisionDispatch)
    throw new BootstrapRequestConflict("Exact reserved supervision launch required");
  return createNativeOperations(input, input.ownerLauncher);
}

async function createNativeOperations(
  input: BootstrapNativeOperationsInput,
  ownerLauncher?: { path: string; sha256: string },
): Promise<BootstrapExecutorOperations> {
  const trace: ReturnType<typeof createBootstrapRunnerEvidence>["run"] =
    input.evidence?.run ?? ((_phase, operation) => operation());
  const writableMountRoots = () =>
    trace("ownership-mounts", () => inspectBootstrapWritableMountRoots(input.host));
  const requireOwnership = async () => {
    await input.verifySetup();
    const roots = await writableMountRoots();
    await trace("ownership-lock", () =>
      requireBootstrapOwnership({
        descriptor: input.descriptor,
        lockFile: input.lockFile,
        verifier: input.ownershipVerifier,
        writableMountRoots: roots,
      }),
    );
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
    manualPrevious: ownerLauncher
      ? createBootstrapSupervisionControl({
          requests: input.requests,
          host: input.host,
          ownerLauncher,
          descriptor: input.descriptor,
          requireOwnership,
        })
      : undefined,
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
      input.evidence?.bind(request);
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
      if (!request.execution) throw new BootstrapRequestConflict("Bootstrap generation is missing");
      await verifyBootstrapReplacement({
        plan: request.plan,
        generation: request.execution.generation,
        hostUid: process.getuid!(),
        reader,
        readHealth: () => readBootstrapHealth(config.listenPort),
      });
      await requireRequest(request);
    },
  };
}

interface SupervisionEffectDeadline {
  expiresAt: number;
  expired: boolean;
}

/** Only protected runner setup supplies the helper, native context and inherited
 * execution descriptor. A browser supplies no process or command arguments. */
export function createBootstrapSupervisionControl(input: {
  requests: CoordinatorBootstrapRequests;
  host: BootstrapAdmissionHost;
  ownerLauncher: { path: string; sha256: string };
  descriptor: number;
  requireOwnership(): Promise<void>;
}): BootstrapManualProcessControl {
  return {
    async signal(request, effect) {
      const deadline: SupervisionEffectDeadline = {
        expiresAt: performance.now() + 25_000,
        expired: false,
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadline.expired = true;
          reject(
            new BootstrapRequestConflict(
              "Supervision effect deadline elapsed; reconcile the retained generation",
            ),
          );
        }, 25_000);
      });
      try {
        await Promise.race([dispatch(request, effect, deadline), timeout]);
      } finally {
        deadline.expired = true;
        clearTimeout(timer);
      }
    },
  };

  async function dispatch(
    request: CoordinatorBootstrapRequest,
    effect: "freeze" | "terminate-frozen",
    deadline: SupervisionEffectDeadline,
  ): Promise<void> {
    if (!request.plan.supervisionRecovery || !request.supervisionDispatch || !request.execution)
      throw new BootstrapRequestConflict("Reserved supervision generation required");
    await input.requireOwnership();
    const roots = await inspectBootstrapWritableMountRoots(input.host);
    const helper = await readBootstrapPreparedFile(input.ownerLauncher, roots);
    const current = input.requests.list().find((record) => record.id === request.id);
    if (!isDeepStrictEqual(current, request))
      throw new BootstrapRequestConflict("Supervision generation changed before native dispatch");
    const remaining = Math.floor(deadline.expiresAt - performance.now());
    if (deadline.expired || remaining <= 0)
      throw new BootstrapRequestConflict("Supervision effect deadline elapsed before launch");
    await new Promise<void>((resolve, reject) => {
      let diagnostic = "";
      const failed = () => {
        const category =
          /^supervision:(deadline_elapsed|approval_changed|process_changed|not_frozen|transfer_unavailable|state_changed|effect_consumed|effect_uncertain|verification_failed)\n$/.exec(
            diagnostic,
          )?.[1];
        reject(
          new BootstrapRequestConflict(
            `Supervision native effect requires reconciliation: ${category ?? "verification_failed"}`,
          ),
        );
      };
      const child = spawn(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          helper.toString("utf8"),
          "supervision-effect",
          request.plan.state.directory,
          request.id,
          request.revision,
          request.execution!.generation,
          request.planSha256,
          effect,
          input.host.helperPath,
          input.host.helperSha256,
          input.host.configurationFile,
          input.host.launcherFile,
          String(Date.now() + remaining),
        ],
        {
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "ignore", "pipe", input.descriptor],
          timeout: remaining,
          killSignal: "SIGKILL",
        },
      );
      child.stderr!.on("data", (bytes: Buffer) => {
        diagnostic = (diagnostic + bytes.toString("utf8")).slice(0, 256);
      });
      child.once("error", failed);
      child.once("close", (code) => (code === 0 ? resolve() : failed()));
    });
  }
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
