import {
  lookupWorkerLaunch,
  parseWorkerLaunchLookupQuery,
  WorkerLaunchLookupError,
} from "./maintenance/worker-launch-lookup.js";
import {
  legacyOperationReplies,
  operationFor,
  reviewedPlanCapabilities,
  type ReviewedRestartOperation,
} from "./restart-operations.js";
import { DaemonAutomation } from "./daemon-automation.js";
import { createRecoveryAccessStatusReader } from "./maintenance/recovery-access.js";
import { MaintenanceServiceCancellationSchema } from "@getpaseo/protocol/maintenance-service-status";
import { MaintenanceServiceProposalSchema } from "@getpaseo/protocol/maintenance-service";
import type { SessionHostStatus } from "@getpaseo/protocol/session-host-maintenance";
import { ensureSessionHostReleaseGuard } from "./release-selection-guard.js";
import { maintenanceServiceView } from "./maintenance/service-view.js";
import { FileEnrollmentJournal } from "./maintenance/authorization.js";
import {
  projectEnrollmentStatus,
  readMaintenanceServiceObservations,
} from "./maintenance/status.js";
import { createDaemonStandingRuntime } from "./maintenance/daemon-standing-runtime.js";
import {
  coordinatorAutomaticStatus,
  BootstrapRequestConflict,
  openBootstrapRequests,
  type BootstrapReconciliationLedger,
} from "./coordinator-bootstrap.js";
import { mountClaudeSetupRoutes } from "./accounts/claude-setup-routes.js";
import { mountClaudeOAuthRoutes } from "./accounts/claude-oauth-routes.js";
import type { ClaudeOAuthRuntime } from "./accounts/claude-oauth-runtime.js";
import type { ClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
import { mountProviderSecretsRoutes } from "./accounts/provider-secrets-routes.js";
import type { ProviderSecretsRuntime } from "./accounts/provider-secrets-runtime.js";
import {
  SkillSourceSchema,
  InstallationSkillSchema,
  SkillPackageSchema,
} from "@getpaseo/protocol/skill-library";
import { InstallationSkillPackages } from "./settings/skill-packages.js";
import {
  PluginSourceResolutionInputSchema,
  ResolvedPluginSourceSchema,
} from "@getpaseo/protocol/plugin-installation";
import { OwnerSessions, OWNER_SESSION_MAX_AGE } from "./owner-sessions.js";
import { createInstallationProfiles } from "./profiles/runtime.js";
import { ProfileSharingConflict } from "./profiles/merge.js";
import { ProviderPreferencesValidationError } from "../agent/provider-preferences/validation.js";
import type { InstallationProfiles } from "./profiles/service.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Logger } from "pino";
import { z } from "zod";
import {
  DaemonAutomationChangeSchema,
  type InstallationMaintenanceStatus,
  SourceUpdateSchema,
  type RestartJob,
  type RestartImpact,
  type SourceContribution,
  RestartRequestSchema,
  RestartDecisionSchema,
  InstallationProfilesPatchSchema,
} from "@getpaseo/protocol/execution-installation";
import { extractHttpBearerToken, isBearerTokenValidAsync } from "../auth.js";
import { createWebUiMiddleware } from "../web-ui.js";
import {
  InstallationRestarts,
  RestartRequestError,
  supportsAutomaticMaintenance,
  type RestartExecutor,
} from "./restarts.js";
import type { InstallationConfig } from "./config.js";
import {
  connectInstallationDaemon,
  submitInstallationCoordinator,
  reconcileInstallationCoordinator,
  inspectInstallationCoordinator,
} from "./daemon.js";
import { CoordinatorBootstrapPreparationSchema } from "@getpaseo/protocol/coordinator-bootstrap";
import { delegateToContainer, DelegationRequestSchema } from "./delegation.js";
import {
  InstallationSettingsUpdateSchema,
  type InstallationSettingsSnapshot,
} from "@getpaseo/protocol/installation-settings";
import { AgentSkillSelectionSchema } from "@getpaseo/protocol/messages";
import {
  createInstallationSettings,
  installationHostInstructions,
  resolveInstallationPluginSource,
  type InstallationPluginSourceResolver,
} from "./settings/runtime.js";
import {
  InstallationSettingsConflict,
  InstallationSettingsInvalidUpdate,
  InstallationSettingsNotInitialized,
  type InstallationSettingsService,
} from "./settings/service.js";
import type { InstructionRequestEnvironment } from "@getpaseo/protocol/instruction-requests";
import { InstructionRequestError, InstructionRequests } from "./settings/instruction-requests.js";

import { inspectContainerSource } from "./container-updates.js";
import { RestartTargetSchema } from "@getpaseo/protocol/execution-installation";
import { InstallationSourceUpdates } from "./source-updates.js";
import { FactoryGate, factoryRestartClass } from "./factory-gate.js";
import { delegatedHandler, readOwnerDelegation, type OwnerDelegation } from "./owner-delegation.js";

/**
 * Status answers are reused this long unless a session host job changes. Each answer greets the
 * host, which records the greeting, and Installation controls refresh every five seconds.
 */
const SESSION_HOST_STATUS_CACHE_MS = 30_000;

// COMPAT(providerRemovalOwner): added in v155, remove after legacy strict catalog clients are unsupported.
function ownerSettingsSnapshot(
  snapshot: InstallationSettingsSnapshot,
  client: { removalAware: boolean; projectPoliciesAware: boolean },
) {
  const catalogs = [snapshot.settings, ...Object.values(snapshot.conflicts?.candidates ?? {})];
  for (const catalog of catalogs) {
    if (!catalog) continue;
    if (!client.removalAware)
      for (const provider of catalog.providerDefinitions ?? []) delete provider.removed;
    // COMPAT(projectPolicies): added 2026-10-22, remove after 2027-04-22. Older strict clients
    // reject the key; newer ones read its presence as the capability.
    if (client.projectPoliciesAware) catalog.projectPolicies ??= {};
    else delete catalog.projectPolicies;
  }
  return snapshot;
}

function ownerSettingsClient(req: Request) {
  return {
    removalAware: req.get("X-Vorteo-Provider-Removal") === "1",
    projectPoliciesAware: req.get("X-Vorteo-Project-Policies") === "1",
  };
}

function matchesToken(token: string | null, hash: string): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

function pendingUpdateDetail(job: RestartJob, pendingDetail: string) {
  return job.status === "pending" ? pendingDetail : job.detail;
}

/**
 * Only a ready batch needs a newer client to review it. While a batch is preparing or a
 * contribution conflicts, the coordinator's own detail says so; a reload would not help.
 */
function legacyBatchDetail(job: RestartJob) {
  return job.sourceBatch?.status === "ready"
    ? pendingUpdateDetail(job, "Source batch pending. Reload Vorteo to review contributions.")
    : job.detail;
}

// COMPAT(requireOwnerApproval): v311; legacy strict contribution decoders omit this field until 2027-04-11.
function contributionReply(contribution: SourceContribution, requireOwnerApproval: boolean) {
  if (requireOwnerApproval) return contribution;
  const { requireOwnerApproval: _required, ...legacy } = contribution;
  return legacy;
}

// COMPAT(requireOwnerApproval): v311; legacy strict receipts omit requirements until 2027-04-11.
function ownerApprovalReply(job: RestartJob, enabled: boolean | undefined): RestartJob {
  if (enabled) return job;
  const { requireOwnerApproval: _requirement, ...compatible } = job;
  if (job.sourceBatch) {
    compatible.sourceBatch = {
      ...job.sourceBatch,
      contributions: job.sourceBatch.contributions.map((item) => contributionReply(item, false)),
    };
  }
  return compatible;
}

// COMPAT(delegatedRequests): added in v0.11.0-beta.3.vorteo.695; only clients that ask receive delegatedTo.
function withDelegation(reply: RestartJob, job: RestartJob, delegation: OwnerDelegation | null) {
  const handler = delegation ? delegatedHandler(job, delegation, Date.now()) : null;
  if (handler?.state === "handling") return { ...reply, delegatedTo: handler.requester };
  if (handler?.state === "overdue") return { ...reply, delegationOverdue: handler.requester };
  return reply;
}

function requestedDelegation(stateDir: string, requested: boolean): OwnerDelegation | null {
  return requested ? readOwnerDelegation(stateDir) : null;
}

// COMPAT(idleRestart): added in v0.11.0-beta.3.vorteo.131; keep old open tabs' strict restart decoders working until they reload.
function restartReply(
  job: RestartJob,
  details: boolean,
  graceful = false,
  sourceUpdates = false,
  sourceBatches = false,
  containerSourceUpdates = false,
  supervisorMaintenance = false,
  hostAutomaticRestarts = false,
  factoryRuntimeAdoption?: boolean,
  requireOwnerApproval?: boolean,
  engineRestart?: boolean,
  hostLauncherUpdate?: boolean,
  engineRecovery?: boolean,
) {
  // Captures are retained in the protected journal, not sent to legacy strict clients.
  // COMPAT(workerLaunchReply): added in v674; remove after 2027-04-17 once requester floor >= v674.
  const {
    supervisorEffect: _supervisorEffect,
    workerLaunch: _workerLaunch,
    workerLaunchRequest: _workerLaunchRequest,
    standingDecision: _standingDecision,
    standingHold: _standingHold,
    standingInterruption: _standingInterruption,
    interruptionChecks: _interruptionChecks,
    standingManualApprovals: _standingManualApprovals,
    updatePreparation: _preparation,
    devRepairs: _devRepairs,
    automaticAuthority: _authority,
    supervisorRecoveredBy: _supervisorRecovery,
    automaticDispatchAfter: _dispatchAfter,
    // COMPAT(restartContinuation): coordinator-internal; strict v689 clients reject it.
    continuationCaptureId: _captureId,
    ...publicJob
  } = job;
  job = ownerApprovalReply(publicJob, requireOwnerApproval);
  // COMPAT projections for reviewed plans; each entry in restart-operations.ts says when.
  job = legacyOperationReplies(job, {
    factoryRuntimeAdoption,
    engineRestart,
    hostLauncherUpdate,
    engineRecovery,
  });
  if (!hostAutomaticRestarts) {
    const { automaticApproval: _approval, ...compatible } = job;
    job = compatible;
  }
  // COMPAT(supervisorMaintenance): keep strict old clients readable, but never accept their approval.
  if (job.supervisorPlanSha256 && !supervisorMaintenance) {
    const { supervisorPlanSha256: _plan, ...compatible } = job;
    return restartReply(
      {
        ...compatible,
        reason: "Dev supervisor maintenance. Reload Vorteo to review the exact operation.",
        detail: "Reload to review supervisor maintenance. Cancellation remains available.",
      },
      details,
      graceful,
    );
  }
  // COMPAT(containerSourceUpdates): v189; old owner tabs must reload before reviewing Dev builds.
  if (
    job.target === "container-daemon" &&
    (job.update || job.sourceBatch) &&
    !containerSourceUpdates
  ) {
    const { update: _update, sourceBatch: _batch, ...compatible } = job;
    return restartReply(
      {
        ...compatible,
        detail: pendingUpdateDetail(
          job,
          "Dev source update pending. Reload Vorteo to review and approve its installation.",
        ),
      },
      details,
      graceful,
    );
  }
  if (job.sourceBatch && !sourceBatches) {
    const { sourceBatch: _batch, ...compatible } = job;
    return restartReply(
      {
        ...compatible,
        detail: legacyBatchDetail(job),
      },
      details,
      graceful,
      sourceUpdates,
    );
  }
  // COMPAT(sourceUpdates): added in v177; retain until older restart-only clients are retired.
  if (job.update && !sourceUpdates) {
    const { update: _update, ...restart } = job;
    return restartReply(
      {
        ...restart,
        detail: pendingUpdateDetail(
          job,
          "Source update pending. Reload Vorteo to review installation details.",
        ),
      },
      details,
      graceful,
    );
  }
  // COMPAT(gracefulRestart): v162 owner clients opt in; older strict decoders omit these fields.
  const {
    finishCurrentTurns: _finishCurrentTurns,
    holdReleased: _holdReleased,
    ...compatible
  } = job;
  if (details) return graceful ? job : compatible;
  const {
    whenIdle: _whenIdle,
    approvedAt: _approvedAt,
    impact: _impact,
    requester: _requester,
    ...legacy
  } = compatible;
  return { ...legacy, expiresAt: "9999-12-31T23:59:59.999Z" };
}

export interface InstallationStartupFence {
  generation: string;
  released(): boolean;
}

/** Version reported by the daemon now answering for this environment. */
async function loadedDaemonVersion(
  config: InstallationConfig,
  kind: "host" | "container",
): Promise<string | null> {
  const client = await connectInstallationDaemon(config, kind);
  try {
    return (await client.getDaemonStatus({ timeout: 15_000 })).version ?? null;
  } finally {
    await client.close();
  }
}

export function createInstallationServer(
  config: InstallationConfig,
  executor: RestartExecutor,
  logger: Logger,
  profiles: InstallationProfiles = createInstallationProfiles(config),
  settings: InstallationSettingsService = createInstallationSettings(config),
  resolvePluginSource: InstallationPluginSourceResolver = (input) =>
    resolveInstallationPluginSource(config, input),
  claudeSetup?: ClaudeSetupRuntime,
  startupFence?: InstallationStartupFence,
  coordinatorRequests?: BootstrapReconciliationLedger,
  claudeOAuth?: ClaudeOAuthRuntime,
  providerSecrets?: ProviderSecretsRuntime,
) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const instructionRequests = new InstructionRequests(
    path.join(config.stateDir, "shared-settings"),
    settings,
    () => new Date(),
    (message) => logger.warn(message),
  );
  const updates = {
    host: config.sourceUpdates ? new InstallationSourceUpdates(config) : null,
    "container-daemon": config.containerSourceUpdates
      ? new InstallationSourceUpdates(config, "container-daemon", (target) =>
          standingRuntime.assertRegistrationReadiness(target),
        )
      : null,
  };
  const forTarget = (target: RestartJob["target"]) => {
    const updater = updates[target];
    if (!updater)
      throw new RestartRequestError("Source updates require installation setup for this target");
    return updater;
  };
  const standingRuntime = createDaemonStandingRuntime(config, updates);
  function assertUpdateReadiness(target: RestartJob["target"]): void {
    standingRuntime.assertRegistrationReadiness(target);
    if (target === "container-daemon" && config.container.persistentRegistration)
      throw new RestartRequestError(
        "Dev source updates require independently verified transition-phase readiness",
      );
  }
  // Factory's read-only checks around every Dev worker replacement, once configured.
  const factoryGate = config.container.factoryGate
    ? new FactoryGate(config.container.factoryGate)
    : null;
  const restartExecutor: RestartExecutor = {
    ...executor,
    ...(factoryGate
      ? {
          async guardDevRestart(job, dispatch) {
            await factoryGate.before(job.id);
            let detail: string | null;
            try {
              detail = await dispatch();
            } catch (error) {
              await factoryGate.discard(job.id);
              throw error;
            }
            // Not idle yet: keep the baseline for the next attempt.
            if (detail === null) return null;
            return `${detail} ${await factoryGate.after(job.id, factoryRestartClass(job))}`;
          },
        }
      : {}),
    supportsUpdate: (target) => updates[target] !== null,
    sourceBase: (target) => forTarget(target).source().baseCommit,
    sourceWeb: (target) => forTarget(target).source().webCommit,
    prepareUpdate: (items, target) => {
      assertUpdateReadiness(target);
      return forTarget(target).prepare(items);
    },
    captureDevRepair: (items) => {
      assertUpdateReadiness("container-daemon");
      return forTarget("container-daemon").captureDevRepair(items);
    },
    prepareDevRepair: (capture, items) => {
      assertUpdateReadiness("container-daemon");
      return forTarget("container-daemon").prepareDevRepair(capture, items);
    },
    prepareInstallation: (job) => {
      assertUpdateReadiness(job.target);
      return forTarget(job.target).prepareInstallation(job);
    },
    verifyPreparedInstallation: async (job, options) => {
      await forTarget(job.target).verifyPreparedInstallation(job, options);
      await standingRuntime.refresh([job], true);
    },
    initialActivationInstance: (job) => standingRuntime.initialActivationInstance(job),
    prepareInterruption: (job) => standingRuntime.prepareInterruption(job),
    observeInterruption: (job) => standingRuntime.observeInterruption(job),
    verifyDispatch: (job) => standingRuntime.verifySelection(job, executor),
    installUpdate: (job, options) =>
      forTarget(job.target).install(
        job,
        async (target) => {
          assertUpdateReadiness(target);
          if (job.standingInterruption) {
            if (!executor.restartHeld)
              throw new RestartRequestError("Acknowledged restart executor is unavailable");
            return executor.restartHeld(job);
          }
          // An owner approve, or an owner-delegated automatic update, replaces the service.
          if (!job.whenIdle || options.serviceRestart) return executor.restart(target);
          if (!executor.restartWhenIdle)
            throw new RestartRequestError("Safe update admission is unavailable");
          const detail = await executor.restartWhenIdle(target);
          if (detail === null)
            throw new RestartRequestError(
              "Target admitted new work before replacement. No restart dispatched.",
            );
          return detail;
        },
        () => standingRuntime.verifySelection(job, executor),
        // Readiness is already proven; an unreadable version only means unknown.
        job.target === "host"
          ? () => loadedDaemonVersion(config, "host").catch(() => null)
          : undefined,
      ),
  };
  const daemonAutomation = new DaemonAutomation(
    config.stateDir,
    Boolean(config.restartApprovalPolicy),
    config.restartApprovalPolicy?.hostRequestsAfter,
  );
  // Host release selection runs only through this queue, so it never starts unguarded.
  ensureSessionHostReleaseGuard(config);
  const restarts = new InstallationRestarts(
    standingRuntime.journal,
    restartExecutor,
    Date.now,
    {
      ...config.restartApprovalPolicy,
      standingDecision: standingRuntime.standingDecision,
      serviceAuthority: standingRuntime.serviceAuthority,
      daemonRequestsAfter: (target) => daemonAutomation.activation(target),
      supervisorRequestsAfter: () => daemonAutomation.activation("supervisor") ?? null,
      cancellationDelayMs: 30_000,
      hostUpdateServiceRestart: () => readOwnerDelegation(config.stateDir).hostUpdateServiceRestart,
      authority: () =>
        createHash("sha256")
          .update(
            JSON.stringify({
              installation: config.public.installationId,
              host: config.hostAgentTokenHash,
              container: config.containerAgentTokenHash,
              policy: "host-only-service-permissions-v2",
              // Absent when off, so existing grants keep their authority.
              ...(readOwnerDelegation(config.stateDir).hostUpdateServiceRestart
                ? { hostUpdateServiceRestart: true }
                : {}),
            }),
          )
          .digest("hex"),
    },
    {
      fenced: startupFence !== undefined,
      progress: (message, fields) => logger.info(fields, message),
    },
  );
  const startupReleased = () => {
    if (startupFence && !startupFence.released()) return false;
    restarts.activate();
    return true;
  };
  let coordinatorReconciliation: Promise<void> | null = null;
  let drainInProgress = false;
  let serviceDiscovery: Promise<void> | null = null;
  let nextServiceDiscovery = 0;
  function discoverMaintenanceServices(): void {
    const discover = executor.discoverMaintenanceServices;
    if (
      !discover ||
      restartExecutor.maintenanceServices ||
      serviceDiscovery ||
      Date.now() < nextServiceDiscovery
    )
      return;
    let expired = false;
    const expiresAt = Date.now() + 25_000;
    const deadline = setTimeout(() => {
      expired = true;
    }, 25_000);
    deadline.unref();
    // Construction is observation only. Keep the original attempt in flight
    // after expiry so a hung native read cannot multiply concurrent attempts.
    serviceDiscovery = Promise.resolve()
      .then(() => discover())
      .then(
        (native) => {
          if (!expired && Date.now() < expiresAt) restartExecutor.maintenanceServices = native;
          return undefined;
        },
        () => undefined,
      )
      .finally(() => {
        clearTimeout(deadline);
        nextServiceDiscovery = Date.now() + 5000;
        serviceDiscovery = null;
      });
  }
  // A Host install that selects a new release leaves coordinator updates
  // prepared for the old one unverifiable. Cancel them rather than leave them
  // waiting for the owner; a renewal prepared on the new release is kept.
  function cancelStaleCoordinatorUpdates() {
    const hostSourceUpdates = config.sourceUpdates;
    if (!coordinatorRequests || !hostSourceUpdates) return;
    try {
      const canceled = coordinatorRequests.cancelForReplacedHostRelease(
        realpathSync(hostSourceUpdates.currentReleaseLink),
        realpathSync(hostSourceUpdates.releaseRoot),
      );
      if (canceled.length)
        logger.info(
          { canceled },
          "Canceled coordinator updates prepared for a replaced Host release",
        );
    } catch {
      logger.warn("Stale coordinator update check is pending");
    }
  }
  const drainRestarts = async () => {
    if (drainInProgress) return;
    drainInProgress = true;
    try {
      if (startupReleased()) {
        // Keep the actual callback owned until settlement. Another timer or
        // caller must not bypass a slow activation into discovery or dispatch.
        if (restartExecutor.reconcileInitialHostActivation) {
          if (serviceDiscovery) return;
          const progress = await restartExecutor.reconcileInitialHostActivation().catch(() => {
            logger.warn("Initial Host activation remains unconfirmed");
            return "unresolved";
          });
          if (progress !== "idle" && progress !== "verified") return;
        }
        coordinatorRequests?.revokeAutomatic();
        cancelStaleCoordinatorUpdates();
        discoverMaintenanceServices();
        await standingRuntime.refresh(restarts.list());
        await restarts.drain();
        if (coordinatorRequests && !coordinatorReconciliation) {
          coordinatorReconciliation = reconcileInstallationCoordinator(config, coordinatorRequests)
            .catch(() => logger.warn("Automatic coordinator reconciliation remains unconfirmed"))
            .finally(() => {
              coordinatorReconciliation = null;
            });
        }
      }
    } catch {
      logger.error("Installation restart journal or startup fence failed");
    } finally {
      drainInProgress = false;
    }
  };
  const sessions = new OwnerSessions(path.join(config.stateDir, "owner-sessions.json"));
  const secureCookies = new URL(config.public.origin).protocol === "https:";
  const cookieName = secureCookies ? "__Host-vorteo-owner" : "vorteo-owner";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "strict" as const,
    path: "/",
  };
  const sessionToken = (req: Request): string | undefined =>
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const configuredPasswordFile =
    config.ownerPasswordFile ?? path.resolve(config.stateDir, "../..", "owner-password");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  const canonicalHost = new URL(config.public.origin).host;
  const recoveryHost = config.recoveryOrigin ? new URL(config.recoveryOrigin).host : null;
  const isRecoveryRequest = (req: Request) =>
    recoveryHost !== null && req.headers.host === recoveryHost;
  const ownerOriginMatches = (req: Request) =>
    req.header("origin") ===
    (isRecoveryRequest(req) ? config.recoveryOrigin : config.public.origin);
  const redirectHosts = new Set(
    (config.redirectOrigins ?? []).map((origin) => new URL(origin).host),
  );
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const legacyHost = host !== canonicalHost && host !== recoveryHost && redirectHosts.has(host);
    if (legacyHost) {
      res.setHeader("Cache-Control", "no-store");
      const navigation = req.method === "GET" || req.method === "HEAD";
      if (!navigation || req.path.startsWith("/api/")) {
        res.sendStatus(403);
        return;
      }
      res.redirect(302, `${config.public.origin}${req.originalUrl}`);
      return;
    }
    const allowedHosts = new Set([
      canonicalHost,
      ...(recoveryHost ? [recoveryHost] : []),
      `127.0.0.1:${config.listenPort}`,
      `localhost:${config.listenPort}`,
    ]);
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.sendStatus(403);
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // Resolve retained child state before startup activation can rewrite the queue.
  app.get("/api/installation/worker-launch-lookup", authenticateUpdate, (req, res, next) => {
    if (res.locals.updateRequester !== "container-agent") {
      res.sendStatus(403);
      return;
    }
    try {
      const lookup = parseWorkerLaunchLookupQuery(req.query, req.originalUrl);
      const receipt = lookupWorkerLaunch(config, lookup);
      if (!receipt) {
        res.sendStatus(404);
        return;
      }
      res.json(receipt);
    } catch (error) {
      if (error instanceof WorkerLaunchLookupError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
  app.use((req, res, next) => {
    try {
      if (startupReleased()) return next();
      if (req.method === "GET" && req.path === "/api/installation/health") {
        res.json({
          installationId: config.public.installationId,
          bootstrap: { generation: startupFence!.generation, pid: process.pid, fenced: true },
        });
        return;
      }
      res
        .status(503)
        .json({ error: "Coordinator maintenance is verifying startup. Try again shortly." });
    } catch {
      res.status(503).json({ error: "Coordinator startup requires installation recovery." });
    }
  });
  let uploads = 0;
  function authenticateUpdate(req: Request, res: Response, next: NextFunction) {
    const token = extractHttpBearerToken(req.header("authorization"));
    const host = matchesToken(token, config.hostAgentTokenHash);
    const container = matchesToken(token, config.containerAgentTokenHash);
    if (!host && !container) {
      res.sendStatus(401);
      return;
    }
    res.locals.updateRequester = host ? "host-agent" : "container-agent";
    next();
  }
  async function updateCapability(target: RestartJob["target"]) {
    try {
      standingRuntime.assertRegistrationReadiness(target);
      if (target === "container-daemon" && config.container.persistentRegistration)
        return {
          available: false,
          reason: "Dev source updates require independently verified transition-phase readiness.",
        };
      forTarget(target).source();
      if (target === "container-daemon" && config.containerSourceUpdates)
        await inspectContainerSource(config.containerSourceUpdates);
      return { available: true };
    } catch {
      return {
        available: false,
        reason: `The ${target === "host" ? "Host" : "Dev"} source updater is not ready. Bootstrap or repair its installation configuration and managed release receipt on Host.`,
      };
    }
  }
  function supervisorMaintenanceStatus(
    impacts: RestartImpact[],
  ): NonNullable<InstallationMaintenanceStatus["services"]>[number] {
    const devImpact = impacts.find((item) => item.target === "container-daemon");
    let supervisorBlocker = restarts.maintenanceBlocker("container-daemon");
    if (!supervisorBlocker && (!executor.supervisorPlan?.() || !executor.restartSupervisor))
      supervisorBlocker = "Prepare and validate the protected supervisor maintenance plan on Host.";
    if (
      !supervisorBlocker &&
      (!supportsAutomaticMaintenance(executor) ||
        !devImpact?.idleRestartSupported ||
        devImpact.error)
    )
      supervisorBlocker = "Cannot verify safe Dev admission for supervisor maintenance.";
    return {
      service: "supervisor",
      readiness: supervisorBlocker ? "blocked" : "ready",
      reason:
        supervisorBlocker ??
        "The protected supervisor plan is available through the tracked queue. Only a separate supervisor permission can authorize it automatically.",
    };
  }
  async function coordinatorCapability() {
    const unavailable = { available: false, automaticAvailable: false };
    if (!coordinatorRequests)
      return {
        ...unavailable,
        reason: "Update the coordinator to expose its durable maintenance ledger.",
      };
    try {
      const open = openBootstrapRequests(coordinatorRequests.list());
      const awaitingRecovery =
        open.length > 0 &&
        open.every((request) => request.execution?.stage === "recovery_required");
      if (open.length > 0 && !awaitingRecovery)
        return {
          ...unavailable,
          reason: "Inspect the retained coordinator request before preparing another operation.",
        };
      const capability = await inspectInstallationCoordinator(config);
      if (awaitingRecovery)
        return {
          ...capability,
          automaticAvailable: false,
          reason:
            "Coordinator recovery requires an exact manually reviewed successor. Inspect the retained failure before preparing it.",
        };
      const reason = capability.automaticAvailable
        ? "Tracked coordinator maintenance and independent recovery are available."
        : "Update the Host to support authenticated coordinator submission and independent recovery.";
      return { ...capability, reason };
    } catch {
      return {
        ...unavailable,
        reason:
          "Coordinator ledger inspection failed. Inspect Installation controls before preparing maintenance.",
      };
    }
  }
  async function coordinatorMaintenanceStatus(): Promise<
    NonNullable<InstallationMaintenanceStatus["services"]>[number]
  > {
    const capability = await coordinatorCapability();
    return {
      service: "coordinator",
      readiness: capability.automaticAvailable ? "ready" : "blocked",
      reason: capability.reason,
    };
  }
  async function maintenanceStatus(): Promise<InstallationMaintenanceStatus> {
    const preference = daemonAutomation.read();
    const impacts = await restarts.impacts();
    const paths: InstallationMaintenanceStatus["paths"] = [];
    const executorReady = supportsAutomaticMaintenance(executor);
    for (const target of ["host", "container-daemon"] as const) {
      const sourceUpdate = await updateCapability(target);
      const selectedSource = sourceUpdate.available ? forTarget(target).source().baseCommit : null;
      const impact = impacts.find((item) => item.target === target);
      const recoveryBlocker = restarts.maintenanceBlocker(target);
      for (const requester of ["host-agent", "container-agent"] as const) {
        const automatic =
          requester === "host-agent" && Boolean(daemonAutomation.effectiveActivation(target));
        for (const operation of ["restart", "source-update"] as const) {
          let blocker: string | null = null;
          if (recoveryBlocker) blocker = recoveryBlocker;
          else if (!executorReady)
            blocker = "Update the coordinator to support safe maintenance admission.";
          else if (!impact || impact.error || !impact.idleRestartSupported)
            blocker =
              "Cannot verify safe admission. Check the target daemon's connection and compatibility.";
          else if (operation === "source-update" && !sourceUpdate.available)
            blocker = "Repair the target source updater before submitting an update.";
          const authorization = automatic ? "automatic" : "manual";
          const readiness = blocker ? "blocked" : "ready";
          const reason =
            blocker ??
            (automatic
              ? "Fresh routine requests may be approved automatically. Current turns finish before dispatch."
              : "An exact owner approval is required. Maintenance policy does not authorize this requester.");
          paths.push({
            requester,
            target,
            operation,
            authorization,
            readiness,
            reason,
            selectedSource,
          });
        }
      }
    }
    const services: NonNullable<InstallationMaintenanceStatus["services"]> = [
      "host",
      "container-daemon",
    ].map((target) => {
      const entries = paths.filter(
        (item) => item.target === target && item.requester === "host-agent",
      );
      const blocked = entries.find((item) => item.readiness === "blocked");
      return {
        service: target as "host" | "container-daemon",
        readiness: blocked ? "blocked" : "ready",
        reason:
          blocked?.reason ??
          "Routine updates and restarts are available through the tracked queue.",
      };
    });
    services.push(await coordinatorMaintenanceStatus(), supervisorMaintenanceStatus(impacts));
    return { version: 1, checkedAt: new Date().toISOString(), preference, paths, services };
  }
  app.get("/api/installation/maintenance-status", authenticateUpdate, (_req, res, next) => {
    void maintenanceStatus().then((status) => res.json(status), next);
  });
  app.get("/api/installation/capabilities", authenticateUpdate, (req, res, next) => {
    const host = matchesToken(
      extractHttpBearerToken(req.header("authorization")),
      config.hostAgentTokenHash,
    );
    const devReady = standingRuntime.registrationReadiness().available;
    // Host plans need only a Host caller; Dev plans also need a ready, unregistered Dev.
    const advertisedPlan = (operation: ReviewedRestartOperation) =>
      host &&
      (operation.target === "host" || (devReady && !config.container.persistentRegistration))
        ? operation.plan(executor)
        : undefined;
    const supervisorPlan = advertisedPlan(operationFor("supervisorPlanSha256"));
    const permissions = daemonAutomation.servicePermissions();
    const automaticSupported = supportsAutomaticMaintenance(executor);
    // COMPAT(hostAutomaticRestarts): per-target permissions added v543; retain
    // the conservative aggregate until legacy capability clients retire after 2027-04-15.
    const automaticHost = Boolean(
      permissions.host && permissions["container-daemon"] && automaticSupported && devReady,
    );
    void (async () => {
      const monitorCompatible = host ? ((await executor.monitorCompatible?.()) ?? false) : false;
      const coordinator = await coordinatorCapability();
      return Promise.all(
        (["host", "container-daemon"] as const).map(async (target) => ({
          target,
          restart: target === "host" || devReady,
          ownerApprovalRequired: !(
            host &&
            permissions[target] &&
            automaticSupported &&
            (target === "host" || devReady)
          ),
          hostAutomaticRestarts: Boolean(
            permissions[target] && automaticSupported && (target === "host" || devReady),
          ),
          sourceUpdate: await updateCapability(target),
        })),
      ).then(
        (targets) =>
          res.json({
            version: 1,
            targets,
            // No protected per-worker native launch capability has been installed.
            workerLaunch: { available: false },
            ownerApprovalRequired: !automaticHost || !host,
            hostAutomaticRestarts: automaticHost,
            requireOwnerApproval: host,
            maintenanceServices: {
              available: host && restarts.serviceMaintenanceAvailable(),
              operations: host ? restarts.serviceMaintenanceOperations() : [],
            },
            coordinatorMaintenance: {
              ...coordinator,
              ownerApprovalRequired: !(host && daemonAutomation.activation("coordinator")),
            },
            previewMonitor: {
              available: Boolean(
                host &&
                executor.validateMonitorPlan &&
                executor.installMonitor &&
                monitorCompatible,
              ),
              ownerApprovalRequired: true,
            },
            nativeHelper: {
              available: Boolean(
                host &&
                executor.validateHelperPlan &&
                executor.installHelper &&
                executor.verifyHelperRecovery,
              ),
              ownerApprovalRequired: true,
            },
            sessionHostJob: {
              available: host && restarts.sessionHostAvailable(),
              ownerApprovalRequired: true,
              // COMPAT(sessionHostRestart): clients send the restart operation only when this is set.
              restart: true,
            },
            supervisorMaintenance: {
              available: Boolean(supervisorPlan && executor.restartSupervisor),
              ownerApprovalRequired: !(
                host &&
                daemonAutomation.activation("supervisor") &&
                supportsAutomaticMaintenance(executor)
              ),
              ...(supervisorPlan ? { sha256: supervisorPlan } : {}),
            },
            // Reviewed plans advertise owner approval, as before; supervisor maintenance is above.
            ...reviewedPlanCapabilities(advertisedPlan, executor),
          }),
        next,
      );
    })().then(undefined, next);
  });
  const updateTarget = (req: Request) => RestartTargetSchema.parse(req.query.target ?? "host");
  function requireUpdate(req: Request, res: Response, next: NextFunction) {
    const target = updateTarget(req);
    void (async () => {
      try {
        const capability = await updateCapability(target);
        if (!capability.available) res.status(503).json({ error: capability.reason });
        else next();
      } catch (error) {
        next(error);
      }
    })();
  }
  app.get("/api/installation/update-source", authenticateUpdate, requireUpdate, (req, res) => {
    const target = updateTarget(req);
    const source = forTarget(target).source();
    const previousBases = restarts
      .list()
      .filter(
        (job) =>
          job.target === target &&
          job.update &&
          ["approved", "running", "succeeded", "failed"].includes(job.status),
      )
      .toReversed()
      .map((job) => job.update!.baseCommit);
    res.json({
      ...source,
      target,
      baseCandidates: [...new Set([source.baseCommit, ...previousBases])],
    });
  });
  app.post(
    "/api/installation/source-update-requests",
    authenticateUpdate,
    requireUpdate,
    (req, res, next) => {
      const batching = req.query.sourceBatches === "1";
      if (uploads >= 2) {
        res.status(429).json({ error: "Upload capacity reached. Retry the same contribution ID." });
        return;
      }
      const active = restarts
        .list()
        .some(
          (job) =>
            job.target === updateTarget(req) &&
            ["pending", "approved", "running"].includes(job.status),
        );
      if (!batching && (uploads > 0 || active)) {
        res
          .status(409)
          .json({ error: "A request for this target or source upload is already active" });
        return;
      }
      uploads++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          uploads--;
        }
      };
      res.once("finish", release);
      res.once("close", release);
      next();
    },
    express.raw({ type: "application/octet-stream", limit: "128mb" }),
    (req, res) => {
      const metadata = req.header("x-vorteo-update");
      if (!metadata || metadata.length > 16000 || !Buffer.isBuffer(req.body)) {
        res.sendStatus(400);
        return;
      }
      const input = z
        .strictObject({
          request: RestartRequestSchema,
          update: SourceUpdateSchema,
          contributionId: z.string().uuid().optional(),
          replaces: z.string().uuid().optional(),
        })
        .parse(JSON.parse(Buffer.from(metadata, "base64").toString("utf8")));
      if (input.request.target !== updateTarget(req)) {
        res.sendStatus(400);
        return;
      }
      // A plain restart may have arrived while the upload was streaming.
      const active = restarts
        .list()
        .some(
          (job) =>
            job.target === updateTarget(req) &&
            ["pending", "approved", "running"].includes(job.status),
        );
      const batching = req.query.sourceBatches === "1";
      if (batching && !input.contributionId) {
        res.status(400).json({ error: "Contribution ID required" });
        return;
      }
      if (active && !batching) {
        res.sendStatus(409);
        return;
      }
      forTarget(input.request.target).stage(input.update, req.body, batching);
      const requester = z.enum(["host-agent", "container-agent"]).parse(res.locals.updateRequester);
      if (batching && input.contributionId) {
        const receipt = restarts.contribute(
          input.request,
          requester,
          input.update,
          input.contributionId,
          input.replaces,
        );
        res.status(201).json({
          ...receipt,
          contribution: contributionReply(
            receipt.contribution,
            req.query.requireOwnerApproval === "1",
          ),
          batch: restartReply(
            receipt.batch,
            true,
            true,
            true,
            true,
            true,
            true,
            req.query.hostAutomaticRestarts === "1",
            req.query.factoryRuntimeAdoption === "1",
            req.query.requireOwnerApproval === "1",
            req.query.engineRestart === "1",
            req.query.hostLauncherUpdate === "1",
            req.query.engineRecovery === "1",
          ),
        });
        void drainRestarts();
      } else
        res
          .status(201)
          .json(
            restartReply(
              restarts.request(input.request, requester, input.update),
              true,
              true,
              true,
              true,
              true,
              true,
              req.query.hostAutomaticRestarts === "1",
              true,
              req.query.requireOwnerApproval === "1",
              req.query.engineRestart === "1",
              req.query.hostLauncherUpdate === "1",
              req.query.engineRecovery === "1",
            ),
          );
    },
  );
  app.get("/api/installation/source-contributions/:id", authenticateUpdate, (req, res) => {
    const receipt = restarts.contribution(req.params.id);
    if (!receipt) {
      res.sendStatus(404);
      return;
    }
    res.json({
      ...receipt,
      contribution: contributionReply(receipt.contribution, req.query.requireOwnerApproval === "1"),
      batch: restartReply(
        receipt.batch,
        true,
        true,
        true,
        true,
        true,
        true,
        req.query.hostAutomaticRestarts === "1",
        undefined,
        req.query.requireOwnerApproval === "1",
        req.query.engineRestart === "1",
        req.query.hostLauncherUpdate === "1",
        req.query.engineRecovery === "1",
      ),
    });
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/installation/health", (_req, res) =>
    res.json({ installationId: config.public.installationId }),
  );

  // Only counts are public. Reasons and task identities require owner access.
  app.get("/api/installation/restart-summary", (_req, res) => {
    const jobs = restarts.list();
    const delegation = readOwnerDelegation(config.stateDir);
    const now = Date.now();
    const delegated = (job: RestartJob) =>
      delegatedHandler(job, delegation, now)?.state === "handling";
    const helpers = restarts.listHelpers();
    const monitors = restarts.listMonitors();
    const services = restarts.listServices();
    const sessionHosts = restarts.listSessionHosts();
    res.json({
      ...(sessionHosts.length
        ? {
            sessionHost: {
              requested: sessionHosts.filter((job) => job.status === "pending").length,
              queued: sessionHosts.filter((job) => job.status === "approved").length,
              running: sessionHosts.filter((job) => job.status === "running").length,
            },
          }
        : {}),
      ...(services.length
        ? {
            serviceMaintenance: {
              requested: services.filter((job) => job.status === "pending").length,
              queued: services.filter((job) => job.status === "approved").length,
              unverified: services.filter((job) => job.status === "running").length,
              attention: services.filter(
                (job) =>
                  ["pending", "approved", "running"].includes(job.status) &&
                  job.reconciliation?.attempts === 3,
              ).length,
            },
          }
        : {}),
      ...(monitors.length
        ? {
            previewMonitor: {
              requested: monitors.filter((j) => j.status === "pending").length,
              queued: monitors.filter((j) => j.status === "approved").length,
              running: monitors.filter((j) => j.status === "running").length,
              recovery: monitors.filter((j) => j.stage === "recovery_required").length,
            },
          }
        : {}),
      ...(helpers.length
        ? {
            nativeHelper: {
              requested: helpers.filter((job) => job.status === "pending").length,
              queued: helpers.filter((job) => job.status === "approved").length,
              running: helpers.filter((job) => job.status === "running").length,
              recovery: helpers.filter((job) => job.stage === "recovery_required").length,
            },
          }
        : {}),
      // A delegated request needs no owner prompt; it stays visible as queued work.
      requested: jobs.filter((job) => job.status === "pending" && !delegated(job)).length,
      queued: jobs.filter(
        (job) => job.status === "approved" || (job.status === "pending" && delegated(job)),
      ).length,
      running: jobs.filter((job) => job.status === "running").length,
    });
  });

  app.get("/api/installation/profiles/admission", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let kind: "host" | "container";
    if (matchesToken(token, config.hostAgentTokenHash)) kind = "host";
    else if (matchesToken(token, config.containerAgentTokenHash)) kind = "container";
    else {
      res.sendStatus(401);
      return;
    }
    const environment = config.public.environments.find((item) => item.kind === kind);
    if (!environment || !profiles.snapshot()) {
      res.sendStatus(503);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({
      installationId: config.public.installationId,
      environment: kind,
      serverId: environment.serverId,
      preferences: profiles.admission(environment.serverId),
    });
  });

  app.get("/api/installation/settings/admission", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let kind: "host" | "container";
    if (matchesToken(token, config.hostAgentTokenHash)) kind = "host";
    else if (matchesToken(token, config.containerAgentTokenHash)) kind = "container";
    else {
      res.sendStatus(401);
      return;
    }
    const environment = config.public.environments.find((item) => item.kind === kind);
    const snapshot = settings.snapshot();
    if (!environment || !snapshot.settings) {
      res.sendStatus(503);
      return;
    }
    // COMPAT(projectPolicies): added 2026-10-22, remove after 2027-04-22. Older daemons parse
    // admission strictly, so only readers that ask receive project policies.
    if (req.query.projectPolicies !== "1") delete snapshot.settings.projectPolicies;
    res.json({
      installationId: config.public.installationId,
      serverId: environment.serverId,
      environment: kind,
      revision: snapshot.revision,
      settings: snapshot.settings,
      installationInstructions: kind === "host" ? installationHostInstructions(config) : "",
    });
  });

  // Agents may propose shared agent instructions. Request-only credentials never apply them.
  const instructionRequester = (req: Request): InstructionRequestEnvironment | null => {
    const token = extractHttpBearerToken(req.header("authorization"));
    if (matchesToken(token, config.hostAgentTokenHash)) return "host";
    if (matchesToken(token, config.containerAgentTokenHash)) return "container";
    return null;
  };
  app.post("/api/installation/instruction-requests", (req, res) => {
    const environment = instructionRequester(req);
    if (!environment) {
      res.sendStatus(401);
      return;
    }
    res.status(201).json(instructionRequests.submit(req.body, environment));
  });
  app.get("/api/installation/instruction-requests/:id", (req, res) => {
    const environment = instructionRequester(req);
    if (!environment) {
      res.sendStatus(401);
      return;
    }
    const request = instructionRequests.get(req.params.id, environment);
    if (!request) {
      res.sendStatus(404);
      return;
    }
    res.json(request);
  });
  app.post("/api/installation/instruction-requests/:id/cancel", (req, res) => {
    const environment = instructionRequester(req);
    if (!environment) {
      res.sendStatus(401);
      return;
    }
    res.json(instructionRequests.cancel(req.params.id, environment));
  });

  app.get("/api/installation/monitor-selection", (req, res, next) => {
    if (
      !matchesToken(extractHttpBearerToken(req.header("authorization")), config.hostAgentTokenHash)
    ) {
      res.sendStatus(401);
      return;
    }
    if (!executor.inspectMonitor) {
      res.status(503).json({ error: "Monitor preparation inspection unavailable" });
      return;
    }
    void executor.inspectMonitor().then((state) => res.json(state), next);
  });
  app.get("/api/installation/monitor-requests/:id", (req, res) => {
    if (
      !matchesToken(extractHttpBearerToken(req.header("authorization")), config.hostAgentTokenHash)
    ) {
      res.sendStatus(401);
      return;
    }
    const job = restarts.listMonitors().find((j) => j.id === req.params.id);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    res.json(job);
  });
  app.post("/api/installation/monitor-requests", (req, res, next) => {
    if (
      !matchesToken(extractHttpBearerToken(req.header("authorization")), config.hostAgentTokenHash)
    ) {
      res.sendStatus(401);
      return;
    }
    if (!executor.validateMonitorPlan || !executor.installMonitor || !executor.monitorCompatible) {
      res.status(503).json({ error: "Preview monitor maintenance unavailable" });
      return;
    }
    void restarts
      .prepareMonitor(req.body, "host-agent")
      .then((job) => res.status(201).json(job), next);
  });
  // Request-only credentials never authorize login, approval, delegation, or another daemon.
  app.get("/api/installation/service-maintenance-requests/:id", authenticateUpdate, (req, res) => {
    if (res.locals.updateRequester !== "host-agent") {
      res.sendStatus(403);
      return;
    }
    const job = restarts.listServices().find((item) => item.id === req.params.id);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    res.json(maintenanceServiceView(job));
  });
  app.post("/api/installation/service-maintenance-requests", authenticateUpdate, (req, res) => {
    if (res.locals.updateRequester !== "host-agent") {
      res.sendStatus(403);
      return;
    }
    if (!restarts.serviceMaintenanceAvailable()) {
      res.status(503).json({ error: "Native maintenance is unavailable" });
      return;
    }
    const input = z
      .strictObject({
        proposal: MaintenanceServiceProposalSchema,
        reason: z.string().min(1).max(4096),
        requester: z.string().min(1).max(256).optional(),
      })
      .parse(req.body);
    if (input.proposal.installationId !== config.public.installationId)
      throw new RestartRequestError("Maintenance proposal belongs to another installation");
    const job = restarts.requestService(
      input.proposal,
      input.reason,
      "host-agent",
      input.requester,
    );
    res.status(201).json(maintenanceServiceView(job));
  });
  app.get("/api/installation/helper-requests/:id", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    if (!matchesToken(token, config.hostAgentTokenHash)) {
      res.sendStatus(401);
      return;
    }
    const job = restarts.listHelpers().find((entry) => entry.id === req.params.id);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    res.json(job);
  });
  // Status asks the host only when detail is wanted, and briefly reuses the answer, so status
  // checks never flood the host's audit log.
  let sessionHostStatusCache: {
    key: string;
    at: number;
    value: Promise<SessionHostStatus>;
  } | null = null;
  function sessionHostStatus(detail: boolean): Promise<SessionHostStatus> {
    if (!executor.inspectSessionHost)
      return Promise.reject(new RestartRequestError("Session host maintenance is unavailable"));
    const now = Date.now();
    const key = JSON.stringify([
      detail,
      restarts.listSessionHosts().map((job) => [job.id, job.status, job.stage]),
    ]);
    const cached = sessionHostStatusCache;
    if (cached && cached.key === key && now - cached.at < SESSION_HOST_STATUS_CACHE_MS)
      return cached.value;
    const value = executor.inspectSessionHost(detail);
    sessionHostStatusCache = { key, at: now, value };
    value.catch(() => {
      if (sessionHostStatusCache?.value === value) sessionHostStatusCache = null;
    });
    return value;
  }
  app.get("/api/installation/session-host", authenticateUpdate, (_req, res, next) => {
    void sessionHostStatus(res.locals.updateRequester === "host-agent").then(
      (status) => res.json(status),
      next,
    );
  });
  app.get("/api/installation/session-host-requests/:id", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    if (!matchesToken(token, config.hostAgentTokenHash)) {
      res.sendStatus(401);
      return;
    }
    const job = restarts.listSessionHosts().find((entry) => entry.id === req.params.id);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    res.json(job);
  });
  app.post("/api/installation/session-host-requests", (req, res, next) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    if (!matchesToken(token, config.hostAgentTokenHash)) {
      res.sendStatus(401);
      return;
    }
    if (!restarts.sessionHostAvailable()) {
      res.status(503).json({ error: "Session host maintenance is unavailable" });
      return;
    }
    void restarts
      .requestSessionHost(req.body, "host-agent")
      .then((job) => res.status(201).json(job), next);
  });
  app.post("/api/installation/helper-requests", (req, res, next) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    if (!matchesToken(token, config.hostAgentTokenHash)) {
      res.sendStatus(401);
      return;
    }
    if (!executor.validateHelperPlan || !executor.installHelper || !executor.verifyHelperRecovery) {
      res.status(503).json({ error: "Native helper maintenance is unavailable" });
      return;
    }
    void restarts
      .prepareHelper(req.body, "host-agent")
      .then((job) => res.status(201).json(job), next);
  });

  app.get("/api/installation/coordinator-requests/:id", authenticateUpdate, (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    try {
      if (!coordinatorRequests) throw new Error("Coordinator ledger unavailable");
      const request = coordinatorRequests.list().find((item) => item.id === id);
      if (!request) {
        res.status(404).json({
          error: "Coordinator request not found. Inspect Installation controls before retrying.",
        });
        return;
      }
      const approvalUrl = new URL("/settings/general", config.public.origin);
      approvalUrl.searchParams.set("installation", "1");
      approvalUrl.searchParams.set("bootstrap", id);
      res.json({
        id: request.id,
        revision: request.revision,
        status: request.status,
        createdAt: request.createdAt,
        decisionAt: request.decisionAt,
        execution: request.execution,
        automaticStatus: coordinatorAutomaticStatus(request, Date.now()),
        approvalUrl: approvalUrl.toString(),
      });
    } catch {
      res.status(503).json({
        error: "Coordinator status is unavailable. Inspect Installation controls before retrying.",
      });
    }
  });
  app.post("/api/installation/coordinator-requests", authenticateUpdate, (req, res) => {
    const input = z
      .strictObject({
        preparation: CoordinatorBootstrapPreparationSchema,
        requireOwnerApproval: z.boolean().optional(),
      })
      .parse(req.body);
    const requester = z.enum(["host-agent", "container-agent"]).parse(res.locals.updateRequester);
    void submitInstallationCoordinator({
      config,
      input: input.preparation,
      requester,
      requireOwnerApproval: input.requireOwnerApproval === true,
    }).then(
      (receipt) => res.status(201).json(receipt),
      () =>
        res.status(503).json({
          error:
            "Coordinator preparation is unconfirmed. Check Installation controls and Host compatibility before retrying the same request.",
        }),
    );
  });

  app.post("/api/installation/restart-requests", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    let requestedBy: "host-agent" | "container-agent";
    if (matchesToken(token, config.hostAgentTokenHash)) requestedBy = "host-agent";
    else if (matchesToken(token, config.containerAgentTokenHash)) requestedBy = "container-agent";
    else {
      res.sendStatus(401);
      return;
    }
    const input = RestartRequestSchema.parse(req.body);
    if (input.workerLaunchRequest && req.query.workerLaunch !== "1") {
      res
        .status(409)
        .json({ error: "Worker launch requires explicit compatible requester negotiation" });
      return;
    }
    const job = restarts.request(input, requestedBy);
    if (input.workerLaunchRequest) {
      res.status(201).json({
        id: job.id,
        revision: job.revision,
        status: job.status,
        detail: job.detail,
        workerLaunch: job.workerLaunch ?? null,
      });
      return;
    }
    res
      .status(201)
      .json(
        restartReply(
          job,
          true,
          true,
          true,
          true,
          true,
          true,
          req.query.hostAutomaticRestarts === "1",
          true,
          req.query.requireOwnerApproval === "1",
          req.query.engineRestart === "1",
          req.query.hostLauncherUpdate === "1",
          req.query.engineRecovery === "1",
        ),
      );
  });

  app.get("/api/installation/restart-requests/:id", (req, res) => {
    const token = extractHttpBearerToken(req.header("authorization"));
    const host = matchesToken(token, config.hostAgentTokenHash);
    const container = matchesToken(token, config.containerAgentTokenHash);
    if (!host && !container) {
      res.sendStatus(401);
      return;
    }
    // Both installation credentials can request either target and share its queue.
    // A caller joining an existing request must be able to observe that receipt.
    const job = restarts.list().find((candidate) => candidate.id === req.params.id);
    if (!job) {
      res.sendStatus(404);
      return;
    }
    if (req.query.workerLaunch === "1") {
      res.json({
        id: job.id,
        revision: job.revision,
        status: job.status,
        detail: job.detail,
        workerLaunch: job.workerLaunch ?? null,
      });
      return;
    }
    res.json(
      restartReply(
        job,
        true,
        true,
        true,
        req.query.sourceBatches === "1",
        true,
        true,
        req.query.hostAutomaticRestarts === "1",
        true,
        req.query.requireOwnerApproval === "1",
        req.query.engineRestart === "1",
        req.query.hostLauncherUpdate === "1",
        req.query.engineRecovery === "1",
      ),
    );
  });

  app.post("/api/installation/container-agents", (req, res, next) => {
    void (async () => {
      const token = extractHttpBearerToken(req.header("authorization"));
      if (!matchesToken(token, config.hostAgentTokenHash)) {
        res.sendStatus(403);
        return;
      }
      try {
        const request = DelegationRequestSchema.parse(req.body);
        const client = await connectInstallationDaemon(config, "container");
        try {
          const result = await delegateToContainer(client, request);
          const environment = config.public.environments.find(
            (candidate) => candidate.kind === "container",
          );
          res.json({
            environment: "container",
            serverId: environment?.serverId,
            untrustedTaskData: result,
          });
        } finally {
          await client.close();
        }
      } catch (error) {
        next(error);
      }
    })();
  });

  // Public setup metadata contains a recovery path, never credentials or connection secrets.
  app.get("/api/installation/owner-access", (_req, res) =>
    res.json({
      sessions: true,
      passwordFile: existsSync(configuredPasswordFile) ? configuredPasswordFile : null,
    }),
  );
  app.post("/api/installation/owner/session", (req, res) => {
    if (!ownerOriginMatches(req)) {
      res.sendStatus(403);
      return;
    }
    const expiresAt = sessions.expiresAt(sessionToken(req));
    res.json({ authenticated: expiresAt !== null, expiresAt });
  });
  app.use("/api/installation/owner", (req, res, next) => {
    void (async () => {
      try {
        // Origin checking is independent of bearer authentication. Agent request keys
        // are deliberately not accepted, even on loopback.
        if (!ownerOriginMatches(req)) {
          res.sendStatus(403);
          return;
        }
        const token = extractHttpBearerToken(req.header("authorization"));
        if (
          !sessions.expiresAt(sessionToken(req)) &&
          !(await isBearerTokenValidAsync({ password: config.ownerPasswordHash, token }))
        ) {
          res.sendStatus(401);
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  });
  app.post("/api/installation/owner/maintenance-services/query", (_req, res) => {
    res.json({
      installationId: config.public.installationId,
      available: restarts.serviceMaintenanceAvailable(),
      jobs: restarts.listServices().map(maintenanceServiceView),
    });
  });
  app.post("/api/installation/owner/maintenance-services/cancel", (req, res) => {
    const input = MaintenanceServiceCancellationSchema.parse(req.body);
    res.json(maintenanceServiceView(restarts.cancelService(input.id, input.revision)));
  });
  app.post("/api/installation/owner/monitors/query", (_req, res) =>
    res.json({ jobs: restarts.listMonitors() }),
  );
  app.post("/api/installation/owner/monitors/decision", (req, res) => {
    const job = restarts.decideMonitor(req.body);
    res.json(job);
    void restarts.drain().catch(() => logger.error("Monitor lifecycle journal failed"));
  });
  app.post("/api/installation/owner/instruction-requests/query", (_req, res) => {
    const snapshot = settings.snapshot();
    res.json({
      revision: snapshot.revision,
      appendSystemPrompt: snapshot.settings?.appendSystemPrompt ?? null,
      requests: instructionRequests.list(),
    });
  });
  app.post("/api/installation/owner/instruction-requests/decision", (req, res, next) => {
    void instructionRequests.decide(req.body).then((request) => res.json(request), next);
  });
  app.post("/api/installation/owner/helpers/query", (_req, res) => {
    res.json({ jobs: restarts.listHelpers() });
  });
  app.post("/api/installation/owner/helpers/decision", (req, res) => {
    const job = restarts.decideHelper(req.body);
    res.json(job);
    void restarts.drain().catch(() => logger.error("Helper lifecycle journal failed"));
  });
  app.post("/api/installation/owner/helpers/verify-installed", (req, res, next) => {
    void restarts.verifyHelperRecovery(req.body).then((job) => res.json(job), next);
  });
  app.post("/api/installation/owner/session-host/query", (req, res) => {
    const jobs = restarts.listSessionHosts();
    if (!restarts.sessionHostAvailable()) {
      res.status(404).json({ error: "Session host maintenance is unavailable" });
      return;
    }
    // COMPAT(sessionHostRestart, hostedIndicator, sessionHostUpgrade): apps before v762 parse this
    // response strictly, so anything added after v712 is sent only to an app that declares it
    // understands it. A client sending {} gets the v712 shape: no restart jobs, no previousHost,
    // no installed release or provider counts, no pending upgrade. Apps from v762 ignore unknown
    // keys, so later additions need no flag for them. Remove once every interface in use is v762
    // or newer.
    const body = (req.body ?? {}) as { restart?: unknown; indicator?: unknown; upgrade?: unknown };
    const wantsRestart = body.restart === true;
    const visible = { indicator: body.indicator === true, upgrade: body.upgrade === true };
    const visibleJobs = wantsRestart
      ? jobs
      : jobs
          .filter((job) => job.operation !== "session-host-restart")
          .map(({ previousHost: _previousHost, ...job }) => job);
    const extra = wantsRestart ? { restartSupported: true } : {};
    void sessionHostStatus(true).then(
      (status) =>
        res.json({
          jobs: visibleJobs,
          status: visibleStatus(status, visible),
          ...extra,
        }),
      () => res.json({ jobs: visibleJobs, status: null, ...extra }),
    );
  });
  /**
   * The status as the client can parse it: without the installed release and per-provider counts
   * unless it declares the indicator (v760), and without the pending upgrade unless it declares
   * upgrades (v762).
   */
  function visibleStatus(
    status: SessionHostStatus,
    flags: { indicator: boolean; upgrade: boolean },
  ): SessionHostStatus {
    if (!status.detail || (flags.indicator && flags.upgrade)) return status;
    const { installedRelease, upgradePending, host, ...detail } = status.detail;
    const visible: SessionHostStatus["detail"] = { ...detail, host };
    if (flags.indicator) {
      if (installedRelease !== undefined) visible.installedRelease = installedRelease;
    } else if (host) {
      visible.host = (({ providers: _providers, ...rest }) => rest)(host);
    }
    if (flags.upgrade && upgradePending !== undefined) visible.upgradePending = upgradePending;
    return { ...status, detail: visible };
  }
  app.post("/api/installation/owner/session-host/request", (req, res, next) => {
    void restarts
      .requestSessionHost(req.body, "owner")
      .then((job) => res.status(201).json(job), next);
  });
  app.post("/api/installation/owner/session-host/decision", (req, res) => {
    const job = restarts.decideSessionHost(req.body);
    res.json(job);
    sessionHostStatusCache = null;
    void restarts.drain().catch(() => logger.error("Session host lifecycle journal failed"));
  });
  if (claudeSetup) mountClaudeSetupRoutes(app, claudeSetup);
  if (claudeOAuth) mountClaudeOAuthRoutes(app, claudeOAuth);
  if (providerSecrets) mountProviderSecretsRoutes(app, providerSecrets);
  app.post("/api/installation/owner/lock", (req, res) => {
    sessions.revoke(sessionToken(req));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ locked: true });
  });
  const sendConnections = (_req: Request, res: Response) => {
    const connections = config.public.environments.map((environment) => ({
      ...environment,
      password: config[environment.kind].password,
    }));
    res.json({ installationId: config.public.installationId, connections });
  };
  app.post("/api/installation/owner/connections", sendConnections);
  app.post("/api/installation/owner/unlock", (req, res) => {
    sessions.revoke(sessionToken(req));
    res.cookie(cookieName, sessions.create(), {
      ...cookieOptions,
      maxAge: OWNER_SESSION_MAX_AGE * 1000,
    });
    sendConnections(req, res);
  });
  app.post("/api/installation/owner/profiles/query", (_req, res) => res.json(profiles.status()));
  app.post("/api/installation/owner/settings/read", (req, res) => {
    res.json(ownerSettingsSnapshot(settings.snapshot(), ownerSettingsClient(req)));
  });
  app.post("/api/installation/owner/settings/plugins/resolve", (req, res, next) => {
    const input = PluginSourceResolutionInputSchema.parse(req.body);
    void resolvePluginSource(input)
      .then((resolved) => ResolvedPluginSourceSchema.parse(resolved))
      .then((resolved) => res.json(resolved), next);
  });
  app.post("/api/installation/owner/settings/skills/package", (req, res) => {
    const input = z.strictObject({ definition: InstallationSkillSchema }).parse(req.body);
    const packages = new InstallationSkillPackages(
      path.join(config.stateDir, "shared-settings/skill-packages"),
    );
    res.json({ package: packages.read(input.definition) });
  });
  app.post("/api/installation/owner/settings/skills/prepare", (req, res, next) => {
    const input = z.strictObject({ source: SkillSourceSchema }).parse(req.body);
    const packages = new InstallationSkillPackages(
      path.join(config.stateDir, "shared-settings/skill-packages"),
    );
    void packages
      .prepare(input.source)
      .then((prepared) =>
        z
          .strictObject({
            definition: InstallationSkillSchema,
            package: SkillPackageSchema,
          })
          .parse(prepared),
      )
      .then((prepared) => res.json(prepared), next);
  });
  app.post("/api/installation/owner/settings/skills/preview", (req, res, next) => {
    const input = z.strictObject({ selection: AgentSkillSelectionSchema }).parse(req.body);
    void settings.previewSkills(input.selection).then((sources) => res.json({ sources }), next);
  });
  app.patch("/api/installation/owner/settings", (req, res, next) => {
    const input = InstallationSettingsUpdateSchema.parse(req.body);
    const removalAware = req.get("X-Vorteo-Provider-Removal") === "1";
    const current = settings.snapshot();
    if (
      !removalAware &&
      input.settings.providerDefinitions &&
      (input.settings.providerDefinitions.some((provider) => provider.removed !== undefined) ||
        current.settings?.providerDefinitions?.some((provider) => provider.removed))
    )
      throw new InstallationSettingsConflict(current.revision);
    void settings
      .update(input)
      .then(
        (snapshot) => res.json(ownerSettingsSnapshot(snapshot, ownerSettingsClient(req))),
        next,
      );
  });
  const readProfiles = (_req: Request, res: Response) => {
    const snapshot = profiles.snapshot();
    if (!snapshot) {
      res.sendStatus(503);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  };
  app.get("/api/installation/owner/profiles", readProfiles);
  app.post("/api/installation/owner/profiles/read", readProfiles);
  app.patch("/api/installation/owner/profiles", (req, res, next) => {
    const input = InstallationProfilesPatchSchema.parse(req.body);
    if (!profiles.snapshot()) {
      res.sendStatus(503);
      return;
    }
    void profiles.patch(input).then((snapshot) => res.json(snapshot), next);
  });
  app.post("/api/installation/owner/profiles/synchronize", (_req, res, next) => {
    void profiles.synchronize().then(() => res.json(profiles.status()), next);
  });
  app.post("/api/installation/owner/profiles/resolve", (req, res, next) => {
    const input = z
      .strictObject({
        serverId: z.string().min(1),
        expectedRevision: z.number().int().positive(),
        choice: z.enum(["shared", "environment"]),
      })
      .parse(req.body);
    void profiles.resolve(input).then(() => res.json(profiles.status()), next);
  });
  app.post("/api/installation/owner/maintenance-status/query", (_req, res, next) => {
    void maintenanceStatus().then((status) => res.json(status), next);
  });
  async function enrollmentStatus() {
    const journal = new FileEnrollmentJournal(config.stateDir);
    const state = journal.read();
    const native =
      state.status === "enrolled"
        ? await readMaintenanceServiceObservations(executor.observeMaintenanceServices)
        : [];
    // Read authority after asynchronous native inspection so a concurrent
    // revocation is reflected without discarding independently verified health.
    return projectEnrollmentStatus({
      installationId: config.public.installationId,
      state: journal.read(),
      checkedAt: new Date().toISOString(),
      observations: [...standingRuntime.observations(), ...native],
      freshnessMs: 30_000,
    });
  }
  const recoveryAccessStatus = createRecoveryAccessStatusReader({
    installationId: config.public.installationId,
    read: executor.observeRecoveryAccess,
  });
  app.post("/api/installation/owner/recovery-access/query", (_req, res, next) => {
    void recoveryAccessStatus().then((status) => res.json(status), next);
  });
  app.post("/api/installation/owner/enrollment/query", (_req, res, next) => {
    void enrollmentStatus().then((status) => res.json(status), next);
  });
  const legacyAutomation = () => {
    const { services: _services, ...legacy } = daemonAutomation.read();
    return legacy;
  };
  app.post("/api/installation/owner/maintenance-permissions/query", (_req, res) => {
    res.json({ ...daemonAutomation.read(), services: daemonAutomation.servicePermissions() });
  });
  app.post("/api/installation/owner/maintenance-permissions/change", (req, res) => {
    const change = DaemonAutomationChangeSchema.parse(req.body);
    if (!change.service) throw new RestartRequestError("Choose the service permission to change");
    const preference = daemonAutomation.change(change);
    coordinatorRequests?.revokeAutomatic();
    restarts.refreshApprovalPolicy();
    res.json({ ...preference, services: daemonAutomation.servicePermissions() });
    void drainRestarts();
  });
  app.post("/api/installation/owner/daemon-automation/query", (_req, res) => {
    res.json(legacyAutomation());
  });
  app.post("/api/installation/owner/daemon-automation/change", (req, res) => {
    const change = DaemonAutomationChangeSchema.parse(req.body);
    const executorReady = supportsAutomaticMaintenance(executor);
    if (change.enabled && !executorReady) {
      throw new RestartRequestError(
        "Update the coordinator before enabling automatic daemon maintenance",
      );
    }
    daemonAutomation.change(change);
    coordinatorRequests?.revokeAutomatic();
    restarts.refreshApprovalPolicy();
    res.json(legacyAutomation());
    void drainRestarts();
  });
  app.post("/api/installation/owner/dev-repair/query", (_req, res) => {
    res.json({
      available: Boolean(updates["container-daemon"] && updates.host),
      preparingIds: restarts
        .list()
        .filter((job) => job.status === "pending" && job.devRepairs?.at(-1)?.status === "preparing")
        .map((job) => job.id),
    });
  });
  app.post("/api/installation/owner/dev-repair/prepare", (req, res) => {
    const input = z
      .strictObject({ id: z.string().uuid(), revision: z.string().uuid() })
      .parse(req.body);
    const job = restarts.requestDevRepair(input.id, input.revision);
    // Durable capture is visible before asynchronous object preparation starts.
    res.status(202).json({ id: job.id, revision: job.revision });
    void restarts
      .prepareBatches()
      .catch((error) => logger.error({ err: error }, "Dev repair preparation failed"));
  });
  app.post("/api/installation/owner/restarts/impact", (_req, res, next) => {
    void restarts.impacts().then((impacts) => res.json(impacts), next);
  });
  app.post("/api/installation/owner/restarts/query", (req, res) => {
    const delegation = requestedDelegation(config.stateDir, req.query.delegatedRequests === "1");
    res.json(
      restarts
        .list()
        .map((job) =>
          withDelegation(
            restartReply(
              job,
              req.query.idleRestarts === "1",
              req.query.gracefulRestarts === "1",
              req.query.sourceUpdates === "1",
              req.query.sourceBatches === "1",
              req.query.containerSourceUpdates === "1",
              req.query.supervisorMaintenance === "1",
              req.query.hostAutomaticRestarts === "1",
              req.query.factoryRuntimeAdoption === "1",
              req.query.requireOwnerApproval === "1",
              req.query.engineRestart === "1",
              req.query.hostLauncherUpdate === "1",
              req.query.engineRecovery === "1",
            ),
            job,
            delegation,
          ),
        ),
    );
    void restarts
      .refreshImpacts()
      .catch((error) => logger.error({ err: error }, "Restart impact refresh failed"));
  });
  app.post("/api/installation/owner/restarts", (req, res) =>
    res
      .status(201)
      .json(
        restartReply(
          restarts.request(RestartRequestSchema.parse(req.body), "owner"),
          req.query.idleRestarts === "1",
          req.query.gracefulRestarts === "1",
        ),
      ),
  );
  app.post("/api/installation/owner/restarts/:id/decision", (req, res) => {
    const decision = RestartDecisionSchema.parse(req.body);
    const reviewed = restarts.list().find((item) => item.id === req.params.id);
    if (
      reviewed?.target === "container-daemon" &&
      (reviewed.update || reviewed.sourceBatch) &&
      req.query.containerSourceUpdates !== "1" &&
      decision.decision !== "reject" &&
      decision.decision !== "cancel"
    )
      throw new RestartRequestError(
        "Reload Vorteo to review Dev source installation before approval",
      );
    if (
      reviewed?.sourceBatch &&
      req.query.sourceBatches !== "1" &&
      decision.decision !== "reject" &&
      decision.decision !== "cancel"
    )
      throw new RestartRequestError(
        "Reload Vorteo to review all source contributions before approval",
      );
    const job = restarts.decide(
      req.params.id,
      decision.revision,
      decision.decision,
      decision.updateSha256,
      decision.supervisorPlanSha256,
      decision.factoryRuntimePlanSha256,
      decision.engineRestartPlanSha256,
      decision.hostLauncherPlanSha256,
      decision.engineRecoveryPlanSha256,
    );
    res.json(
      withDelegation(
        restartReply(
          job,
          req.query.idleRestarts === "1",
          req.query.gracefulRestarts === "1",
          req.query.sourceUpdates === "1",
          req.query.sourceBatches === "1",
          req.query.containerSourceUpdates === "1",
          req.query.supervisorMaintenance === "1",
          req.query.hostAutomaticRestarts === "1",
          req.query.factoryRuntimeAdoption === "1",
          req.query.requireOwnerApproval === "1",
          req.query.engineRestart === "1",
          req.query.hostLauncherUpdate === "1",
          req.query.engineRecovery === "1",
        ),
        job,
        requestedDelegation(config.stateDir, req.query.delegatedRequests === "1"),
      ),
    );
    void restarts
      .drain()
      .catch((error) => logger.error({ err: error }, "Installation restart journal failed"));
  });
  const webUi = (origin: string) =>
    createWebUiMiddleware({
      enabled: true,
      distDir: config.webDistDir,
      label: "Vorteo",
      logger,
      installation: {
        ...config.public,
        origin,
        profileSharing: true,
        idleRestarts: Boolean(executor.inspect && executor.restartWhenIdle),
        gracefulRestarts: Boolean(executor.holdCurrentTurns && executor.releaseCurrentTurns),
      },
    });
  const canonicalWebUi = webUi(config.public.origin);
  const recoveryWebUi = config.recoveryOrigin ? webUi(config.recoveryOrigin) : canonicalWebUi;
  app.use((req, res, next) =>
    (isRecoveryRequest(req) ? recoveryWebUi : canonicalWebUi)(req, res, next),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    if (error instanceof ProviderPreferencesValidationError) {
      res.status(400).json({ error: error.message, reference: error.reference });
      return;
    }
    if (error instanceof InstructionRequestError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof InstallationSettingsInvalidUpdate) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (
      error instanceof InstallationSettingsConflict ||
      error instanceof InstallationSettingsNotInitialized
    ) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (
      error instanceof ProfileSharingConflict ||
      error instanceof RestartRequestError ||
      error instanceof BootstrapRequestConflict
    ) {
      res.status(409).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, "Installation request failed");
    res.status(500).json({ error: "Installation request failed" });
  });
  return Object.assign(app, {
    drainRestarts,
    assertRegistrationReadiness: standingRuntime.assertRegistrationReadiness,
    registrationReadiness: standingRuntime.registrationReadiness,
  });
}
