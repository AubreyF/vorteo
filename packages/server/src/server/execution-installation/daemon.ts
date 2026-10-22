import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { filterArchivedRestartErrors } from "./restart-impact.js";
import { runSupervisorMaintenance, supervisorPlanDigest } from "./supervisor-maintenance.js";
import { factoryRuntimePlanDigest, runFactoryRuntimePhase } from "./factory-runtime-adoption.js";
import { WebSocket } from "ws";
import type { Logger } from "pino";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  RestartImpact,
  RestartJob,
  ExecutionEnvironmentKind,
} from "@getpaseo/protocol/execution-installation";
import { hostLaunchdService, type InstallationConfig } from "./config.js";
import type { RestartExecutor } from "./restarts.js";
import type { CoordinatorBootstrapPreparation } from "@getpaseo/protocol/coordinator-bootstrap";
import { coordinatorAutomaticAuthority, signCoordinatorSubmission } from "./daemon-automation.js";
import {
  BootstrapRequestConflict,
  type BootstrapReconciliationLedger,
} from "./coordinator-bootstrap.js";

const execFileAsync = promisify(execFile);

// Status includes provider availability probes, which can exceed three seconds.
const DAEMON_RESPONSE_TIMEOUT_MS = 30_000;
const READINESS_PROBE_TIMEOUT_MS = 10_000;

interface CoordinatorSubmission {
  config: InstallationConfig;
  input: CoordinatorBootstrapPreparation;
  requester: "host-agent" | "container-agent";
  requireOwnerApproval: boolean;
}

type CoordinatorSubmissionClient = Pick<DaemonClient, "prepareCoordinatorBootstrap" | "close">;
type CoordinatorCapabilityClient = Pick<DaemonClient, "getLastServerInfoMessage" | "close">;

export async function inspectInstallationCoordinator(
  config: InstallationConfig,
  connect: () => Promise<CoordinatorCapabilityClient> = () =>
    connectInstallationDaemon(config, "host"),
) {
  try {
    const client = await connect();
    try {
      const features = client.getLastServerInfoMessage()?.features;
      const available = features?.coordinatorBootstrapReview === true;
      const automaticAvailable =
        available &&
        features.coordinatorBootstrapAuthenticatedSubmission === true &&
        features.coordinatorBootstrapAutomaticReconciliation === true &&
        features.coordinatorBootstrapAutomaticStatus === true &&
        features.coordinatorBootstrapBootRecovery === true &&
        features.coordinatorBootstrapCompatibleRecovery === true &&
        features.coordinatorBootstrapRecoveryBootPlan === true;
      return { available, automaticAvailable };
    } finally {
      await client.close();
    }
  } catch {
    return { available: false, automaticAvailable: false };
  }
}

type CoordinatorReconciliationClient = Pick<
  DaemonClient,
  "reconcileAutomaticCoordinatorBootstrap" | "close"
>;

export async function reconcileInstallationCoordinator(
  config: InstallationConfig,
  ledger: BootstrapReconciliationLedger,
  connect: () => Promise<CoordinatorReconciliationClient> = () =>
    connectInstallationDaemon(config, "host"),
): Promise<void> {
  for (const request of ledger.list()) {
    const automatic =
      request.status === "pending" ? request.automaticSubmission : request.automaticApproval;
    if (
      !automatic ||
      request.status === "canceled" ||
      request.execution ||
      request.automaticDispatch
    )
      continue;
    const reserved = ledger.reserveAutomaticReconciliation({
      id: request.id,
      revision: request.revision,
      planSha256: request.planSha256,
    });
    if (!reserved) continue;
    try {
      const client = await connect();
      try {
        await client.reconcileAutomaticCoordinatorBootstrap(reserved.id);
      } finally {
        await client.close();
      }
    } finally {
      // A changed phase or native launch receipt makes this a no-op. Otherwise
      // persist bounded backoff even when the transport outcome was lost.
      ledger.finishAutomaticReconciliation(reserved.id, reserved.automaticCheck);
    }
    return;
  }
}

/** The requester comes from scoped HTTP authentication, never the submitted body. */
export async function submitInstallationCoordinator(
  submission: CoordinatorSubmission,
  connect: () => Promise<CoordinatorSubmissionClient> = () =>
    connectInstallationDaemon(submission.config, "host"),
) {
  const { config, input, requester, requireOwnerApproval } = submission;
  const automatic =
    requester === "host-agent" &&
    !requireOwnerApproval &&
    coordinatorAutomaticAuthority(config) !== null;
  const submissionProof = automatic ? signCoordinatorSubmission(config, input) : undefined;
  const client = await connect();
  try {
    const requests = await client.prepareCoordinatorBootstrap(input, { submissionProof });
    const request = requests.find((item) => item.id === input.id);
    if (!request) throw new BootstrapRequestConflict("Coordinator preparation is unconfirmed");
    const approvalUrl = new URL("/settings/general", config.public.origin);
    approvalUrl.searchParams.set("installation", "1");
    approvalUrl.searchParams.set("bootstrap", request.id);
    // Scoped clients receive a receipt, never private authority or another request.
    return {
      id: request.id,
      revision: request.revision,
      status: request.status,
      approvalUrl: approvalUrl.toString(),
    };
  } finally {
    await client.close();
  }
}

export async function connectInstallationDaemon(
  config: InstallationConfig,
  kind: ExecutionEnvironmentKind,
): Promise<DaemonClient> {
  const target = config[kind];
  const descriptor = config.public.environments.find((environment) => environment.kind === kind);
  if (!descriptor) throw new Error("Installation environment is missing");
  const client = new DaemonClient({
    url: `ws://${target.endpoint}/ws`,
    password: target.password,
    expectedServerId: descriptor.serverId,
    clientId: `installation-${randomUUID()}`,
    clientType: "cli",
    connectTimeoutMs: DAEMON_RESPONSE_TIMEOUT_MS,
    reconnect: { enabled: false },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
      return {
        get readyState() {
          return socket.readyState;
        },
        send: (data) => socket.send(data),
        close: (code, reason) => socket.close(code, reason),
        on: (event, listener) => {
          socket.on(event, listener);
        },
        off: (event, listener) => {
          socket.off(event, listener);
        },
      };
    },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function validateHostStartup(config: InstallationConfig): Promise<void> {
  const validation = config.host.startupValidation;
  if (!validation) return;
  try {
    await execFileAsync(validation.node, [validation.entrypoint], {
      env: { ...process.env, PASEO_HOME: validation.home, PASEO_VALIDATE_STARTUP: "1" },
      timeout: 15_000,
      maxBuffer: 8192,
    });
  } catch (error) {
    let fields = "";
    if (error instanceof Error && "stderr" in error && typeof error.stderr === "string") {
      const match = error.stderr.match(/^Invalid configuration fields: ([a-zA-Z0-9_., -]+)$/);
      if (match) fields = ` Invalid fields: ${match[1]}.`;
    }
    throw new Error(
      `Host startup preflight failed. No restart was dispatched.${fields} Repair configuration or restore a validated backup, then request a new restart.`,
      { cause: error },
    );
  }
}

async function reportRestartTimeout(
  config: InstallationConfig,
  target: RestartJob["target"],
): Promise<never> {
  if (target === "host") {
    await validateHostStartup(config);
    throw new Error(
      "Host replacement was not ready within two minutes. Startup configuration passed validation. Inspect the host service log for a worker crash, missing dependency, port conflict or identity mismatch. Preserve state and restore a validated launcher if needed, then request a new restart. No restart was replayed.",
    );
  }
  throw new Error(
    "Dev container replacement was not ready within two minutes. Inspect the existing supervisor log and verify its identity and credentials. Preserve the container and state, then request a new restart. No restart was replayed.",
  );
}

export function createInstallationRegistrationAdmission(
  config: InstallationConfig,
  assertRegistrationReadiness?: (target: RestartJob["target"]) => void,
): (target: RestartJob["target"]) => void {
  const configuration = structuredClone(config);
  const registrationRequired = configuration.container.persistentRegistration !== undefined;
  return function assertReady(target: RestartJob["target"]): void {
    if (target !== "container-daemon") return;
    if (!registrationRequired && config.container.persistentRegistration === undefined) return;
    if (!registrationRequired || !isDeepStrictEqual(config, configuration))
      throw new Error("Dev registration configuration changed");
    if (
      !assertRegistrationReadiness ||
      assertRegistrationReadiness(target) !== undefined ||
      !isDeepStrictEqual(config, configuration)
    )
      throw new Error("Verified Dev registration readiness is unavailable");
  };
}

export function createInstallationRestartExecutor(
  config: InstallationConfig,
  assertRegistrationReadiness?: (target: RestartJob["target"]) => void,
  logger?: Pick<Logger, "info" | "warn">,
): RestartExecutor {
  const assertReady = createInstallationRegistrationAdmission(config, assertRegistrationReadiness);
  function retainedHeldRestart(job: RestartJob) {
    const current = new FileBootstrapRequestJournal(config.stateDir)
      .readLifecycle()
      .find((item) => item.id === job.id);
    if (
      !current ||
      (current.target !== "host" && current.target !== "container-daemon") ||
      current.status !== "running" ||
      current.revision !== job.revision ||
      current.target !== job.target ||
      !isDeepStrictEqual(current.standingDecision, job.standingDecision) ||
      !isDeepStrictEqual(current.update, job.update) ||
      !isDeepStrictEqual(current.sourceBatch, job.sourceBatch) ||
      !current.standingInterruption ||
      !isDeepStrictEqual(current.standingInterruption, job.standingInterruption)
    )
      throw new Error("Exact durable interruption reservation is unavailable");
    return current.standingInterruption.held;
  }

  async function restartHeld(job: RestartJob): Promise<string> {
    assertReady(job.target);
    const held = retainedHeldRestart(job);
    const kind = job.target === "host" ? "host" : "container";
    const client = await connectInstallationDaemon(config, kind);
    try {
      retainedHeldRestart(job);
      assertReady(job.target);
      await client.restartServer("approved_exact_held_restart", undefined, {
        timeout: 5000,
        idleMode: "restart",
        restartDrainId: job.id,
        heldRestart: held,
      });
    } catch (error) {
      const lostReply =
        error instanceof Error &&
        "code" in error &&
        ["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"].includes(String(error.code));
      if (!lostReply) throw error;
      // Observe this same generation after a lost reply. Never send again.
    } finally {
      await client.close();
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await delay(1000);
      let observed: DaemonClient | null = null;
      try {
        observed = await connectInstallationDaemon(config, kind);
        const response = await observed.restartServer(undefined, undefined, {
          idleMode: "inspect",
          timeout: 5000,
        });
        const impact = response.impact;
        if (
          impact?.workerPid &&
          impact.workerPid !== held.workerPid &&
          impact.workerInstanceId &&
          impact.workerInstanceId !== held.workerInstanceId &&
          impact.restartDrainId === null
        )
          return `Replacement worker ${impact.workerPid} is ready; retained generation observed without replay`;
      } catch {
        // Readiness may be temporarily unavailable; this loop has no effects.
      } finally {
        await observed?.close();
      }
    }
    throw new Error(
      "Held restart readiness remains unverified; retain the generation without replay",
    );
  }

  /**
   * One bounded readiness probe. A frozen daemon still completes TCP handshakes
   * from its listen backlog, so an unbounded connect or close can wait forever.
   */
  async function probeDaemonPid(kind: "host" | "container"): Promise<number> {
    const attempt = (async () => {
      const client = await connectInstallationDaemon(config, kind);
      try {
        return (await client.getDaemonStatus({ timeout: READINESS_PROBE_TIMEOUT_MS })).pid;
      } finally {
        void client.close().catch(() => {});
      }
    })();
    const expired = delay(READINESS_PROBE_TIMEOUT_MS + 5_000).then(() => {
      throw new Error("Daemon readiness probe did not answer in time");
    });
    return Promise.race([attempt, expired]);
  }

  /** Waits for a changed worker PID, reporting progress, until its own deadline. */
  async function waitForReplacement(
    target: RestartJob["target"],
    kind: "host" | "container",
    previousPid: number | null,
  ): Promise<string> {
    const startedAt = Date.now();
    const deadline = startedAt + 120_000;
    let reportedAt = startedAt;
    logger?.info({ target, previousPid }, "Restart sent; waiting for a replacement worker");
    while (Date.now() < deadline) {
      await delay(1000);
      try {
        const pid = await probeDaemonPid(kind);
        if (pid !== previousPid)
          return `Replacement worker ${pid} is ready; environment identity verified`;
      } catch {
        // Startup can temporarily refuse connections. The deadline bounds recovery.
      }
      if (Date.now() - reportedAt >= 30_000) {
        reportedAt = Date.now();
        logger?.info(
          { target, previousPid, waitedMs: reportedAt - startedAt },
          "Still waiting for a replacement worker",
        );
      }
    }
    logger?.warn({ target, previousPid }, "No replacement worker became ready in time");
    return reportRestartTimeout(config, target);
  }

  async function restart(target: RestartJob["target"], whenIdle = false): Promise<string | null> {
    assertReady(target);
    const kind = target === "host" ? "host" : "container";
    let previousPid: number | null = null;
    try {
      previousPid = await probeDaemonPid(kind);
    } catch (error) {
      if (whenIdle) return null;
      if (target !== "host") throw error;
      // The installation owns this launchd service even when its daemon is down.
      // Readiness after recovery still requires the pinned identity and credential.
    }
    if (whenIdle) {
      let client: DaemonClient;
      try {
        client = await connectInstallationDaemon(config, kind);
      } catch {
        // No restart RPC was sent; safely keep waiting for the target.
        return null;
      }
      try {
        assertReady(target);
        const result = await client.restartServer("owner_approved_idle_restart", undefined, {
          timeout: 5000,
          idleMode: "restart",
        });
        if (result.accepted === false) return null;
        if (result.accepted !== true)
          throw new Error("Daemon did not confirm the idle restart barrier");
      } finally {
        await client.close();
      }
    } else if (target === "host") {
      await execFileAsync("/bin/launchctl", ["kickstart", "-k", hostLaunchdService(config)], {
        timeout: 15_000,
      });
    } else {
      const client = await connectInstallationDaemon(config, kind);
      try {
        // The container and its supervisor remain in place. Never recreate it.
        assertReady(target);
        await client.restartServer("owner_approved_installation_restart", undefined, {
          timeout: 5000,
        });
      } catch (error) {
        const lostReply =
          error instanceof Error &&
          "code" in error &&
          ["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"].includes(String(error.code));
        if (!lostReply) throw error;
        // The worker may exit before delivering its acknowledgement. Verify the
        // replacement instead of either replaying the restart or claiming failure.
      } finally {
        await client.close();
      }
    }
    return waitForReplacement(target, kind, previousPid);
  }
  return {
    restartHeld,
    factoryRuntimePlan: () => factoryRuntimePlanDigest(config.container.factoryRuntimeAdoption),
    async adoptFactoryRuntime(job) {
      assertReady("container-daemon");
      if (config.container.persistentRegistration)
        throw new Error(
          "Dev Factory adoption requires independently verified transition-phase readiness",
        );
      const plan = config.container.factoryRuntimeAdoption;
      const environment = config.public.environments.find((entry) => entry.kind === "container");
      if (!plan || !environment || job.factoryRuntimePlanSha256 !== factoryRuntimePlanDigest(plan))
        throw new Error("Factory adoption plan is unavailable or changed");
      const before = await connectInstallationDaemon(config, "container");
      let previousPid: number;
      try {
        previousPid = (await before.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS })).pid;
      } finally {
        await before.close();
      }
      const phase = { plan, job, serverId: environment.serverId, previousPid };
      assertReady("container-daemon");
      await runFactoryRuntimePhase({ ...phase, phase: "stage", replacementPid: null });
      // This is the existing tracked restart executor, after exact adoption approval.
      // Once staging starts, failure retains this request; it never requeues or rolls state back.
      await restart("container-daemon", false);
      const after = await connectInstallationDaemon(config, "container");
      let replacementPid: number;
      try {
        replacementPid = (await after.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS })).pid;
      } finally {
        await after.close();
      }
      if (replacementPid === previousPid)
        throw new Error("Factory adoption did not replace the worker; inspect retained selection");
      await runFactoryRuntimePhase({ ...phase, phase: "verify", replacementPid });
      return `Factory startup adoption verified on replacement Dev worker ${replacementPid}.`;
    },
    supervisorPlan: () => supervisorPlanDigest(config.container.supervisorMaintenance),
    async restartSupervisor(job) {
      assertReady("container-daemon");
      if (config.container.persistentRegistration)
        throw new Error("Dev supervisor maintenance requires an independently bound operation");
      const plan = config.container.supervisorMaintenance;
      if (!plan || job.target !== "container-daemon" || job.supervisorPlanSha256 !== plan.sha256)
        throw new Error("Supervisor maintenance plan is unavailable or changed");
      const before = await connectInstallationDaemon(config, "container");
      let previousPid: number;
      try {
        previousPid = (await before.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS })).pid;
      } finally {
        await before.close();
      }
      assertReady("container-daemon");
      await runSupervisorMaintenance(plan, job);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await delay(1000);
        let client: DaemonClient | null = null;
        try {
          client = await connectInstallationDaemon(config, "container");
          const status = await client.getDaemonStatus({ timeout: DAEMON_RESPONSE_TIMEOUT_MS });
          if (status.pid !== previousPid)
            return `Dev supervisor maintenance completed; replacement worker ${status.pid} and environment identity verified`;
        } catch {
          /* The worker may still be starting; never dispatch again. */
        } finally {
          await client?.close();
        }
      }
      return reportRestartTimeout(config, "container-daemon");
    },
    async inspect(target): Promise<RestartImpact> {
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        const features = client.getLastServerInfoMessage()?.features;
        const idleRestartSupported = features?.idleRestart === true;
        if (idleRestartSupported) {
          const response = await client.restartServer(undefined, undefined, {
            idleMode: "inspect",
          });
          if (!response.impact) throw new Error("Daemon did not return restart impact");
          const agents = await filterArchivedRestartErrors(
            response.impact.agents,
            async (id) => (await client.fetchAgent(id))?.agent,
          );
          return {
            target,
            checkedAt: new Date().toISOString(),
            ...response.impact,
            agents,
            idleRestartSupported,
            gracefulRestartSupported: features?.gracefulRestart === true,
            restartDrainObservationSupported: features?.restartDrainObservation === true,
            heldIdleRestartSupported: features?.heldIdleRestart === true,
            error: null,
          };
        }
        // COMPAT(idleRestart): added in v0.11.0-beta.3.vorteo.131; retain read-only inventory until the daemon floor supports idle restarts.
        const agents: RestartImpact["agents"] = [];
        let cursor: string | undefined;
        do {
          const page = await client.fetchAgents({
            filter: { includeArchived: true },
            page: { limit: 200, cursor },
          });
          for (const { agent } of page.entries) {
            if (agent.status === "running" || agent.status === "initializing")
              agents.push({
                id: agent.id,
                title: agent.title || agent.id,
                status: agent.status,
              });
          }
          cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
          if (page.pageInfo.hasMore && !cursor) throw new Error("Incomplete agent inventory");
        } while (cursor);
        return {
          target,
          checkedAt: new Date().toISOString(),
          agents,
          pendingStarts: 0,
          idleRestartSupported,
          error: null,
        };
      } finally {
        await client.close();
      }
    },
    async restartContinuationAvailable(target) {
      let client: DaemonClient;
      try {
        client = await connectInstallationDaemon(config, target === "host" ? "host" : "container");
      } catch (error) {
        // An unreachable daemon holds no tasks to capture; restart recovery stays legacy.
        logger?.warn(
          { err: error, target },
          "Restart continuation skipped: the daemon is unreachable, so this restart uses legacy behavior",
        );
        return false;
      }
      try {
        const available = client.getLastServerInfoMessage()?.features?.restartContinuation === true;
        if (!available)
          logger?.info(
            { target },
            "Restart continuation skipped: the daemon does not advertise it, so this restart uses legacy behavior",
          );
        return available;
      } finally {
        await client.close();
      }
    },
    async captureRestartContinuation(target, requestId) {
      assertReady(target);
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        assertReady(target);
        const result = await client.restartServer(undefined, undefined, {
          timeout: 5000,
          idleMode: "drain",
          restartDrainId: requestId,
          restartContinuation: "capture",
        });
        if (result.accepted !== true)
          throw new Error("Environment did not confirm durable restart continuation capture");
      } finally {
        await client.close();
      }
    },
    async releaseRestartContinuation(target, requestId, outcome) {
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        // COMPAT(restartContinuation): a daemon without durable continuation (for
        // example after a downgrade) can only hold the legacy drain, so release that.
        const continuation =
          client.getLastServerInfoMessage()?.features?.restartContinuation === true;
        if (!continuation)
          logger?.info(
            { target, requestId },
            "Releasing the legacy restart hold: the daemon does not advertise restart continuation",
          );
        const result = await client.restartServer(undefined, undefined, {
          timeout: 5000,
          idleMode: "cancel-drain",
          restartDrainId: requestId,
          ...(continuation ? { restartContinuation: outcome } : {}),
        });
        return result.accepted === true;
      } finally {
        await client.close();
      }
    },
    async holdCurrentTurns(target, requestId) {
      assertReady(target);
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        assertReady(target);
        const result = await client.restartServer(undefined, undefined, {
          timeout: 5000,
          idleMode: "drain",
          restartDrainId: requestId,
        });
        if (result.accepted !== true)
          throw new Error("Environment could not establish the restart hold");
      } finally {
        await client.close();
      }
    },
    async releaseCurrentTurns(target, requestId) {
      const client = await connectInstallationDaemon(
        config,
        target === "host" ? "host" : "container",
      );
      try {
        const result = await client.restartServer(undefined, undefined, {
          timeout: 5000,
          idleMode: "cancel-drain",
          restartDrainId: requestId,
        });
        if (result.accepted !== true)
          throw new Error("Environment is still releasing the restart hold");
      } finally {
        await client.close();
      }
    },
    async restart(target) {
      if (target === "host") await validateHostStartup(config);
      const detail = await restart(target);
      if (detail === null) throw new Error("Restart was not dispatched");
      return detail;
    },
    async restartWhenIdle(target) {
      if (target === "host") await validateHostStartup(config);
      return restart(target, true);
    },
  };
}
