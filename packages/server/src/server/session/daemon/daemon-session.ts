import type pino from "pino";
import type { ProviderAvailability } from "../../agent/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { getPidLockInfo } from "../../pid-lock.js";
import {
  collectDaemonDiagnostics,
  type DaemonWebSocketRuntimeDiagnosticSnapshot,
} from "./diagnostics.js";
import { DaemonSelfUpdateSessionController } from "./daemon-self-update-session-controller.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import type { HubRelationshipManagement } from "../../hub/relationship-controller.js";
import {
  type DaemonConfigReloadResult,
  type DaemonConfigStore,
  OriginAdmissionUnavailableError,
} from "../../daemon-config-store.js";
import { ConfigWriterError } from "../../config-writer.js";
import { ZodError } from "zod";
import type { DaemonOriginAdmissionResponse } from "@getpaseo/protocol/messages";

export interface DaemonRuntimeConfig {
  listen: string | null;
  worktreesRoot?: string;
  appBaseUrl?: string;
  desktopManaged?: boolean;
  getRelayConfig(): {
    enabled: boolean;
    endpoint: string;
    publicEndpoint: string;
    useTls: boolean;
    publicUseTls: boolean;
  } | null;
}

export interface DaemonSessionHost {
  emit(msg: SessionOutboundMessage): void;
  emitLifecycleIntent(intent: {
    type: "restart";
    clientId: string;
    requestId: string;
    reason: string;
  }): void;
}

export interface DaemonSessionOptions {
  host: DaemonSessionHost;
  clientId: string;
  paseoHome: string;
  serverId: string | undefined;
  daemonVersion: string | undefined;
  daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  listAgents: () => ManagedAgent[];
  listProjects: () => Promise<PersistedProjectRecord[]>;
  listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  listProviderAvailability: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  getObservationMetrics?: () => Record<string, number>;
  logger: pino.Logger;
  hubRelationships?: HubRelationshipManagement;
  reloadConfig: () => DaemonConfigReloadResult;
  originAdmission?: Pick<DaemonConfigStore, "inspectOriginAdmission" | "admitOrigin">;
}

/**
 * A client's read surface for the daemon process itself: its runtime status
 * (pid-lock start time, listen address, relay config, provider availability) and
 * a fresh local pairing offer for connecting a new client. Owns the `daemon.*`
 * RPCs. Reaches no state beyond the never-mutated runtime values injected at
 * construction and the outbound channel.
 */
export class DaemonSession {
  private readonly host: DaemonSessionHost;
  private readonly clientId: string;
  private readonly paseoHome: string;
  private readonly serverId: string | undefined;
  private readonly daemonVersion: string | undefined;
  private readonly daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  private readonly listAgents: () => ManagedAgent[];
  private readonly listProjects: () => Promise<PersistedProjectRecord[]>;
  private readonly listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  private readonly listProviderAvailability: () => Promise<ProviderAvailability[]>;
  private readonly getWebSocketRuntimeMetrics: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  private readonly getObservationMetrics: DaemonSessionOptions["getObservationMetrics"];
  private readonly logger: pino.Logger;
  private readonly selfUpdate: DaemonSelfUpdateSessionController;
  private readonly hubRelationships: HubRelationshipManagement | null;
  private readonly reloadConfig: () => DaemonConfigReloadResult;
  private readonly inspectOrigins: DaemonConfigStore["inspectOriginAdmission"] | null;
  private readonly admitOrigin: DaemonConfigStore["admitOrigin"] | null;

  constructor(options: DaemonSessionOptions) {
    this.host = options.host;
    this.clientId = options.clientId;
    this.paseoHome = options.paseoHome;
    this.serverId = options.serverId;
    this.daemonVersion = options.daemonVersion;
    this.daemonRuntimeConfig = options.daemonRuntimeConfig;
    this.listAgents = options.listAgents;
    this.listProjects = options.listProjects;
    this.listWorkspaces = options.listWorkspaces;
    this.listProviderAvailability = options.listProviderAvailability;
    this.getWebSocketRuntimeMetrics = options.getWebSocketRuntimeMetrics ?? (() => null);
    this.getObservationMetrics = options.getObservationMetrics;
    this.logger = options.logger;
    this.hubRelationships = options.hubRelationships ?? null;
    this.reloadConfig = options.reloadConfig;
    this.inspectOrigins = options.originAdmission
      ? options.originAdmission.inspectOriginAdmission.bind(options.originAdmission)
      : null;
    this.admitOrigin = options.originAdmission
      ? options.originAdmission.admitOrigin.bind(options.originAdmission)
      : null;
    this.selfUpdate = new DaemonSelfUpdateSessionController({
      clientId: this.clientId,
      daemonVersion: this.daemonVersion ?? null,
      desktopManaged: this.daemonRuntimeConfig?.desktopManaged === true,
      emit: (msg) => this.host.emit(msg),
      emitLifecycleIntent: (intent) => this.host.emitLifecycleIntent(intent),
      sessionLogger: this.logger,
    });
  }

  async handleHubRelationshipRequest(
    msg: Extract<
      SessionInboundMessage,
      {
        type:
          | "hub.management.daemon.connect.request"
          | "hub.management.daemon.get_status.request"
          | "hub.management.daemon.disconnect.request"
          | "hub.management.daemon.permissions.update.request";
      }
    >,
  ): Promise<void> {
    try {
      if (!this.hubRelationships) throw new Error("Hub relationship management is unavailable");
      if (msg.type === "hub.management.daemon.connect.request") {
        const status = await this.hubRelationships.connect({
          hubUrl: msg.hubUrl,
          token: msg.token,
          permissions: msg.permissions,
        });
        this.host.emit({
          type: "hub.management.daemon.connect.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      if (msg.type === "hub.management.daemon.permissions.update.request") {
        const status = await this.hubRelationships.updatePermissions({
          grant: msg.grant,
          revoke: msg.revoke,
        });
        this.host.emit({
          type: "hub.management.daemon.permissions.update.response",
          payload: { requestId: msg.requestId, status },
        });
        return;
      }
      if (msg.type === "hub.management.daemon.disconnect.request") {
        const result = await this.hubRelationships.disconnect({ force: msg.force ?? false });
        this.host.emit({
          type: "hub.management.daemon.disconnect.response",
          payload: { requestId: msg.requestId, ...result },
        });
        return;
      }
      this.host.emit({
        type: "hub.management.daemon.get_status.response",
        payload: { requestId: msg.requestId, status: this.hubRelationships.status() },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle Hub relationship request");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }

  async handleGetStatusRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_status.request" }>,
  ): Promise<void> {
    try {
      const pidInfo = await getPidLockInfo(this.paseoHome);
      const providers = (await this.listProviderAvailability()).map((p) => ({
        provider: p.provider,
        available: p.available,
        error: p.error ?? null,
      }));
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: pidInfo?.startedAt ?? null,
          listen: this.daemonRuntimeConfig?.listen ?? null,
          relay: this.daemonRuntimeConfig?.getRelayConfig() ?? null,
          providers,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle daemon status request");
      this.host.emit({
        type: "daemon.get_status.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId ?? "",
          version: this.daemonVersion ?? null,
          pid: process.pid,
          nodePath: process.execPath,
          startedAt: null,
          listen: null,
          relay: null,
          providers: [],
        },
      });
    }
  }

  // COMPAT(retiredPairing): added in v155, retain the error response until legacy pairing clients are unsupported.
  async handleGetPairingOfferRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.get_pairing_offer.request" }>,
  ): Promise<void> {
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: msg.type,
        error:
          "Device pairing has been retired. Connect through Tailscale using the environment address and existing authentication.",
      },
    });
  }

  handleOriginAdmissionInspectRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.config.get_origin_admission.request" }>,
  ): void {
    try {
      if (!this.serverId || this.serverId !== msg.expectedServerId || !this.inspectOrigins)
        throw new OriginAdmissionUnavailableError();
      const observation = this.inspectOrigins();
      this.host.emit({
        type: "daemon.config.get_origin_admission.response",
        payload: {
          requestId: msg.requestId,
          serverId: this.serverId,
          observedAt: new Date().toISOString(),
          ...observation,
        },
      });
    } catch {
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          code: "handler_error",
          error:
            "Origin inspection unavailable on the expected serving daemon. No admission was attempted.",
        },
      });
    }
  }

  handleOriginAdmissionRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.config.admit_origin.request" }>,
  ): void {
    const captured = structuredClone(msg);
    const identity = { requestId: captured.requestId, serverId: this.serverId ?? null };
    if (!this.serverId || this.serverId !== captured.expectedServerId) {
      this.host.emit({
        type: "daemon.config.admit_origin.response",
        payload: {
          ...identity,
          observedAt: new Date().toISOString(),
          state: "refused",
          code: "host_mismatch",
          reason: "Serving daemon identity does not match the requested host.",
          writeAttempted: false,
        },
      });
      return;
    }
    try {
      if (!this.admitOrigin) throw new OriginAdmissionUnavailableError();
      const result = this.admitOrigin({
        origin: captured.origin,
        expectedPersistedOrigins: captured.expectedPersistedOrigins,
        expectedActiveOrigins: captured.expectedActiveOrigins,
      });
      this.host.emit({
        type: "daemon.config.admit_origin.response",
        payload: {
          ...identity,
          observedAt: new Date().toISOString(),
          state: "applied",
          origin: captured.origin,
          ...result,
        },
      });
    } catch (error) {
      const failure = originAdmissionFailure(error);
      this.host.emit({
        type: "daemon.config.admit_origin.response",
        payload: {
          ...identity,
          observedAt: new Date().toISOString(),
          ...failure,
        },
      });
    }
  }

  handleConfigReloadRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.config.reload.request" }>,
  ): void {
    try {
      this.host.emit({
        type: "daemon.config.reload.response",
        payload: { requestId: msg.requestId, ...this.reloadConfig() },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to reload daemon config");
      this.host.emit({
        type: "rpc_error",
        payload: {
          requestId: msg.requestId,
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: "handler_error",
        },
      });
    }
  }

  async handleDiagnosticsRequest(
    msg: Extract<SessionInboundMessage, { type: "diagnostics.request" }>,
  ): Promise<void> {
    try {
      const diagnostic = await collectDaemonDiagnostics({
        paseoHome: this.paseoHome,
        serverId: this.serverId,
        daemonVersion: this.daemonVersion,
        daemonRuntimeConfig: this.daemonRuntimeConfig,
        listAgents: this.listAgents,
        listProjects: this.listProjects,
        listWorkspaces: this.listWorkspaces,
        listProviderAvailability: this.listProviderAvailability,
        getWebSocketRuntimeMetrics: this.getWebSocketRuntimeMetrics,
        getObservationMetrics: this.getObservationMetrics,
        logger: this.logger,
      });
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic,
        },
      });
    } catch (error) {
      this.logger.error({ err: error }, "Failed to handle diagnostics request");
      this.host.emit({
        type: "diagnostics.response",
        payload: {
          requestId: msg.requestId,
          diagnostic: `Vorteo diagnostics\n  Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  }

  async handleUpdateRequest(
    msg: Extract<SessionInboundMessage, { type: "daemon.update.request" }>,
  ): Promise<void> {
    await this.selfUpdate.dispatch(msg);
  }
}

function originAdmissionFailure(
  error: unknown,
): Omit<
  Exclude<DaemonOriginAdmissionResponse["payload"], { state: "applied" }>,
  "requestId" | "serverId" | "observedAt"
> {
  if (error instanceof OriginAdmissionUnavailableError)
    return {
      state: "refused",
      code: "unavailable",
      writeAttempted: false,
      reason: "The native origin field owner is unavailable or overridden.",
    };
  if (error instanceof ZodError)
    return {
      state: "refused",
      code: "invalid_origin",
      writeAttempted: false,
      reason: "Supply a canonical HTTP or HTTPS origin without credentials, path or query.",
    };
  if (error instanceof ConfigWriterError) {
    const refusal =
      !error.writeAttempted && (error.code === "busy" || error.code === "stale_input");
    if (refusal)
      return {
        state: "refused",
        code: error.code,
        writeAttempted: false,
        reason:
          "Configuration ownership or observed origin preconditions changed. Inspect again before a new authorized attempt.",
      };
    return {
      state: "uncertain",
      code: "uncertain",
      writeAttempted: error.writeAttempted,
      reason:
        "Origin admission may have changed state. Retain this invocation and reconcile the exact host, persisted and active origins. Do not retry automatically.",
    };
  }
  return {
    state: "uncertain",
    code: "uncertain",
    writeAttempted: null,
    reason:
      "Origin admission outcome is unknown. Retain this invocation and reconcile the exact host without automatic replay.",
  };
}
