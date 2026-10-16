import { DaemonAutomation } from "./daemon-automation.js";
import { MaintenanceServiceCancellationSchema } from "@getpaseo/protocol/maintenance-service-status";
import { MaintenanceServiceProposalSchema } from "@getpaseo/protocol/maintenance-service";
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
import type { ClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
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
import { existsSync, mkdirSync } from "node:fs";
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

import { inspectContainerSource } from "./container-updates.js";
import { RestartTargetSchema } from "@getpaseo/protocol/execution-installation";
import { InstallationSourceUpdates } from "./source-updates.js";

// COMPAT(providerRemovalOwner): added in v155, remove after legacy strict catalog clients are unsupported.
function ownerSettingsSnapshot(snapshot: InstallationSettingsSnapshot, removalAware: boolean) {
  if (removalAware) return snapshot;
  const catalogs = [snapshot.settings, ...Object.values(snapshot.conflicts?.candidates ?? {})];
  for (const catalog of catalogs)
    for (const provider of catalog?.providerDefinitions ?? []) delete provider.removed;
  return snapshot;
}

function matchesToken(token: string | null, hash: string): boolean {
  if (!token) return false;
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

// COMPAT(factoryRuntimeAdoption): v285, remove after legacy installation clients are retired.
function factoryAdoptionReply(job: RestartJob, enabled: boolean | undefined): RestartJob {
  if (!job.factoryRuntimePlanSha256 || enabled) return job;
  const {
    factoryRuntimePlanSha256: _plan,
    factoryRuntimeRecoveryRequired: _recovery,
    factoryRuntimeRecoveryOf: _recoveryOf,
    factoryRuntimeRecoveredBy: _recoveredBy,
    ...compatible
  } = job;
  return {
    ...compatible,
    reason: "Factory startup adoption. Reload Vorteo to review the exact operation.",
    detail: "Reload to review Factory adoption. Cancellation remains available.",
  };
}

function pendingUpdateDetail(job: RestartJob, pendingDetail: string) {
  return job.status === "pending" ? pendingDetail : job.detail;
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
) {
  // Captures are retained in the protected journal, not sent to legacy strict clients.
  const {
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
    ...publicJob
  } = job;
  job = ownerApprovalReply(publicJob, requireOwnerApproval);
  job = factoryAdoptionReply(job, factoryRuntimeAdoption);
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
        detail: pendingUpdateDetail(
          job,
          "Source batch pending. Reload Vorteo to review contributions.",
        ),
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
) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const updates = {
    host: config.sourceUpdates ? new InstallationSourceUpdates(config) : null,
    "container-daemon": config.containerSourceUpdates
      ? new InstallationSourceUpdates(config, "container-daemon")
      : null,
  };
  const forTarget = (target: RestartJob["target"]) => {
    const updater = updates[target];
    if (!updater)
      throw new RestartRequestError("Source updates require installation setup for this target");
    return updater;
  };
  const standingRuntime = createDaemonStandingRuntime(config, updates);
  const restartExecutor: RestartExecutor = {
    ...executor,
    supportsUpdate: (target) => updates[target] !== null,
    sourceBase: (target) => forTarget(target).source().baseCommit,
    sourceWeb: (target) => forTarget(target).source().webCommit,
    prepareUpdate: (items, target) => forTarget(target).prepare(items),
    captureDevRepair: (items) => forTarget("container-daemon").captureDevRepair(items),
    prepareDevRepair: (capture, items) =>
      forTarget("container-daemon").prepareDevRepair(capture, items),
    prepareInstallation: (job) => forTarget(job.target).prepareInstallation(job),
    verifyPreparedInstallation: async (job, options) => {
      await forTarget(job.target).verifyPreparedInstallation(job, options);
      await standingRuntime.refresh([job], true);
    },
    initialActivationInstance: (job) => standingRuntime.initialActivationInstance(job),
    verifyDispatch: (job) => standingRuntime.verifySelection(job, executor),
    installUpdate: (job) =>
      forTarget(job.target).install(
        job,
        async (target) => {
          if (job.standingInterruption) {
            if (!executor.restartHeld)
              throw new RestartRequestError("Acknowledged restart executor is unavailable");
            return executor.restartHeld(job);
          }
          if (!job.whenIdle) return executor.restart(target);
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
      ),
  };
  const daemonAutomation = new DaemonAutomation(
    config.stateDir,
    Boolean(config.restartApprovalPolicy),
    config.restartApprovalPolicy?.hostRequestsAfter,
  );
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
      authority: () =>
        createHash("sha256")
          .update(
            JSON.stringify({
              installation: config.public.installationId,
              host: config.hostAgentTokenHash,
              container: config.containerAgentTokenHash,
              policy: "host-only-service-permissions-v2",
            }),
          )
          .digest("hex"),
    },
    { fenced: startupFence !== undefined },
  );
  const startupReleased = () => {
    if (startupFence && !startupFence.released()) return false;
    restarts.activate();
    return true;
  };
  let coordinatorReconciliation: Promise<void> | null = null;
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
  const drainRestarts = async () => {
    try {
      if (startupReleased()) {
        coordinatorRequests?.revokeAutomatic();
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
  const redirectHosts = new Set(
    (config.redirectOrigins ?? []).map((origin) => new URL(origin).host),
  );
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const legacyHost = host !== canonicalHost && redirectHosts.has(host);
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
    const supervisorPlan = host ? executor.supervisorPlan?.() : undefined;
    const factoryRuntimePlan = host ? executor.factoryRuntimePlan?.() : undefined;
    const permissions = daemonAutomation.servicePermissions();
    const automaticSupported = supportsAutomaticMaintenance(executor);
    // COMPAT(hostAutomaticRestarts): per-target permissions added v543; retain
    // the conservative aggregate until legacy capability clients retire after 2027-04-15.
    const automaticHost = Boolean(
      permissions.host && permissions["container-daemon"] && automaticSupported,
    );
    void (async () => {
      const monitorCompatible = host ? ((await executor.monitorCompatible?.()) ?? false) : false;
      const coordinator = await coordinatorCapability();
      return Promise.all(
        (["host", "container-daemon"] as const).map(async (target) => ({
          target,
          restart: true,
          ownerApprovalRequired: !(host && permissions[target] && automaticSupported),
          hostAutomaticRestarts: Boolean(permissions[target] && automaticSupported),
          sourceUpdate: await updateCapability(target),
        })),
      ).then(
        (targets) =>
          res.json({
            version: 1,
            targets,
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
            supervisorMaintenance: {
              available: Boolean(supervisorPlan && executor.restartSupervisor),
              ownerApprovalRequired: !(
                host &&
                daemonAutomation.activation("supervisor") &&
                supportsAutomaticMaintenance(executor)
              ),
              ...(supervisorPlan ? { sha256: supervisorPlan } : {}),
            },
            factoryRuntimeAdoption: {
              available: Boolean(factoryRuntimePlan && executor.adoptFactoryRuntime),
              ownerApprovalRequired: true,
              ...(factoryRuntimePlan ? { sha256: factoryRuntimePlan } : {}),
            },
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
    const helpers = restarts.listHelpers();
    const monitors = restarts.listMonitors();
    const services = restarts.listServices();
    res.json({
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
      requested: jobs.filter((job) => job.status === "pending").length,
      queued: jobs.filter((job) => job.status === "approved").length,
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
    res.json({
      installationId: config.public.installationId,
      serverId: environment.serverId,
      environment: kind,
      revision: snapshot.revision,
      settings: snapshot.settings,
      installationInstructions: kind === "host" ? installationHostInstructions(config) : "",
    });
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
    const job = restarts.request(RestartRequestSchema.parse(req.body), requestedBy);
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
    if (req.header("origin") !== config.public.origin) {
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
        if (req.header("origin") !== config.public.origin) {
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
  if (claudeSetup) mountClaudeSetupRoutes(app, claudeSetup);
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
    res.json(
      ownerSettingsSnapshot(settings.snapshot(), req.get("X-Vorteo-Provider-Removal") === "1"),
    );
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
      .then((snapshot) => res.json(ownerSettingsSnapshot(snapshot, removalAware)), next);
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
    res.json(
      restarts
        .list()
        .map((job) =>
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
    );
    res.json(
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
      ),
    );
    void restarts
      .drain()
      .catch((error) => logger.error({ err: error }, "Installation restart journal failed"));
  });
  app.use(
    createWebUiMiddleware({
      enabled: true,
      distDir: config.webDistDir,
      label: "Vorteo",
      logger,
      installation: {
        ...config.public,
        profileSharing: true,
        idleRestarts: Boolean(executor.inspect && executor.restartWhenIdle),
        gracefulRestarts: Boolean(executor.holdCurrentTurns && executor.releaseCurrentTurns),
      },
    }),
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
  return Object.assign(app, { drainRestarts });
}
