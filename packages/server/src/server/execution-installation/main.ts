import { inspectMaintenanceObservationRuntime } from "./coordinator-bootstrap-maintenance-observation-runtime.js";
import { reconcileNativeInitialHostActivation } from "./maintenance/host-supervisor-activation.js";
import { createNativeMaintenanceServiceExecutor } from "./coordinator-bootstrap-maintenance-service-producer.js";
import { observeNativeMaintenanceServices } from "./coordinator-bootstrap-maintenance-health.js";
import { observeNativeRecoveryAccess } from "./coordinator-bootstrap-maintenance-recovery-native-ports.js";
import { createNativeMaintenanceServiceRouter } from "./coordinator-bootstrap-maintenance-service-routing.js";
import { initializePackagedClaudeCli } from "../agent/providers/claude/packaged-cli.js";
import { createPreviewMonitorExecutor } from "./preview-monitor-executor.js";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createNativeHelperExecutor } from "./native-helper-executor.js";
import { createSessionHostExecutor, sessionHostLabel } from "./session-host-job.js";
import { createNativeSessionHostPorts } from "./session-host-job-native.js";
import {
  createSessionHostReleaseGuard,
  setReleaseSelectionGuard,
} from "./release-selection-guard.js";
import {
  inspectBootstrapWritableMountRoots,
  createBootstrapReconciliationLedger,
} from "./coordinator-bootstrap-host.js";
import { loadCoordinatorStartupFence } from "./coordinator-bootstrap-startup.js";
import { createClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
import { createClaudeOAuthRuntime } from "./accounts/claude-oauth-runtime.js";
import { createInstallationProfiles, startProfileSynchronization } from "./profiles/runtime.js";
import pino from "pino";
import { readInstallationConfig } from "./config.js";
import { createInstallationServer } from "./server.js";
import { createInstallationRestartExecutor } from "./daemon.js";
import { createInstallationSettings, startSettingsReconciliation } from "./settings/runtime.js";

const configFile = process.argv[2];
if (!configFile) throw new Error("Usage: installation-entrypoint <private-config-file>");
const config = readInstallationConfig(configFile);
const logger = pino({ name: "vorteo-installation" });
const startupFence = loadCoordinatorStartupFence({
  installationId: config.public.installationId,
  stateDirectory: config.stateDir,
  node: realpathSync(process.execPath),
  entrypoint: realpathSync(process.argv[1]!),
  configuration: realpathSync(configFile),
});
// This installation entrypoint uses its release CLI, independent of daemon worker markers.
initializePackagedClaudeCli(true);
function assertRegistrationReadiness(target: "host" | "container-daemon"): void {
  app.assertRegistrationReadiness(target);
}
const executor = createInstallationRestartExecutor(config, assertRegistrationReadiness, logger);
if (process.platform === "darwin") {
  executor.reconcileInitialHostActivation = () =>
    reconcileNativeInitialHostActivation({
      configuration: config,
      configurationFile: realpathSync(configFile),
    });
  executor.observeRecoveryAccess = (signal) =>
    observeNativeRecoveryAccess({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      signal,
    });
  executor.observeMaintenanceServices = (signal) =>
    observeNativeMaintenanceServices({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      signal,
    });
  executor.discoverMaintenanceServices = async () => {
    const observationRuntime = await inspectMaintenanceObservationRuntime({
      configuration: config,
      configurationFile: realpathSync(configFile),
    });
    return createNativeMaintenanceServiceRouter({
      installationId: config.public.installationId,
      stateDirectory: config.stateDir,
      mode: "replacement-only",
      observeRetained: async (request, reservation, executorTarget) => {
        const observer = await createNativeMaintenanceServiceExecutor({
          installationId: config.public.installationId,
          stateDirectory: config.stateDir,
          executorTarget,
          observationRuntime,
        });
        return observer.observe(request, reservation);
      },
    });
  };
}
if (config.nativeHelper) {
  if (process.platform !== "darwin")
    throw new Error("Native helper maintenance requires macOS Host");
  const helper = config.nativeHelper;
  Object.assign(
    executor,
    createNativeHelperExecutor({
      home: helper.home,
      installationId: config.public.installationId,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(helper),
    }),
  );
}
// The coordinator owns the session host's launchd job wherever Host releases are selected
// through the current link. Every Host release selection then refuses a release without the
// session host while the job is installed.
if (config.sourceUpdates && config.host.startupValidation && process.platform === "darwin") {
  const ports = createNativeSessionHostPorts();
  Object.assign(executor, createSessionHostExecutor({ config, ports }));
  setReleaseSelectionGuard(
    createSessionHostReleaseGuard({
      currentReleaseLink: config.sourceUpdates.currentReleaseLink,
      plistPath: path.join(
        ports.launchAgentsDirectory,
        `${sessionHostLabel(config.public.installationId)}.plist`,
      ),
    }),
  );
}
if (config.previewMonitor)
  Object.assign(
    executor,
    createPreviewMonitorExecutor({
      installationId: config.public.installationId,
      configuration: config.previewMonitor,
      writableMountRoots: () => inspectBootstrapWritableMountRoots(config.previewMonitor!),
    }),
  );
const profiles = createInstallationProfiles(config, assertRegistrationReadiness);
const settings = createInstallationSettings(config, assertRegistrationReadiness);
let stopProfileSynchronization: (() => void) | undefined;
let stopSettingsReconciliation: (() => void) | undefined;
let synchronizing = false;
function activateSynchronization() {
  if (synchronizing || (startupFence && !startupFence.released())) return;
  stopProfileSynchronization = startProfileSynchronization(profiles, logger);
  stopSettingsReconciliation = startSettingsReconciliation(settings, logger);
  synchronizing = true;
}
const claudeSetup = createClaudeSetupRuntime(config, settings, assertRegistrationReadiness);
const host = config.public.environments.find((environment) => environment.kind === "host");
if (!host) throw new Error("Installation Host identity is missing");
const coordinatorRequests = createBootstrapReconciliationLedger(configFile, host.serverId);
const claudeSetupTimer = setInterval(() => {
  if (!synchronizing) return;
  void claudeSetup
    .reconcile()
    .catch(() => logger.warn("Claude subscription synchronization is pending"));
}, 5000);
claudeSetupTimer.unref();
// Off by default: Host-owned refresh for full sign-in Claude accounts.
const claudeOAuth =
  config.claudeHostRefresh === true
    ? createClaudeOAuthRuntime(config, settings, assertRegistrationReadiness)
    : undefined;
const claudeOAuthTimer = claudeOAuth
  ? setInterval(() => {
      if (!synchronizing) return;
      void claudeOAuth.reconcile().catch(() => logger.warn("Claude sign-in refresh is pending"));
    }, 30_000)
  : undefined;
claudeOAuthTimer?.unref();
const app = createInstallationServer(
  config,
  executor,
  logger,
  profiles,
  settings,
  undefined,
  claudeSetup,
  startupFence,
  coordinatorRequests,
  claudeOAuth,
);
activateSynchronization();
const restartTimer = setInterval(() => {
  try {
    activateSynchronization();
  } catch {
    logger.warn("Coordinator synchronization remains fenced for recovery");
  }
  void app.drainRestarts();
}, 2000);
restartTimer.unref();
const server = app.listen(config.listenPort, "127.0.0.1", () =>
  logger.info("Installation coordinator ready"),
);
server.on("error", (error) => {
  logger.error({ err: error }, "Installation listener failed");
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(restartTimer);
    clearInterval(claudeSetupTimer);
    if (claudeOAuthTimer) clearInterval(claudeOAuthTimer);
    void claudeSetup.dispose();
    void claudeOAuth?.dispose();
    stopProfileSynchronization?.();
    stopSettingsReconciliation?.();
    server.close();
  });
