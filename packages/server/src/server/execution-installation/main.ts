import { realpathSync } from "node:fs";
import { createNativeHelperExecutor } from "./native-helper-executor.js";
import { inspectBootstrapWritableMountRoots } from "./coordinator-bootstrap-host.js";
import { loadCoordinatorStartupFence } from "./coordinator-bootstrap-startup.js";
import { createClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
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
const executor = createInstallationRestartExecutor(config);
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
const profiles = createInstallationProfiles(config);
const settings = createInstallationSettings(config);
let stopProfileSynchronization: (() => void) | undefined;
let stopSettingsReconciliation: (() => void) | undefined;
let synchronizing = false;
function activateSynchronization() {
  if (synchronizing || (startupFence && !startupFence.released())) return;
  stopProfileSynchronization = startProfileSynchronization(profiles, logger);
  stopSettingsReconciliation = startSettingsReconciliation(settings, logger);
  synchronizing = true;
}
activateSynchronization();
const claudeSetup = createClaudeSetupRuntime(config, settings);
const claudeSetupTimer = setInterval(() => {
  if (!synchronizing) return;
  void claudeSetup
    .reconcile()
    .catch(() => logger.warn("Claude subscription synchronization is pending"));
}, 5000);
claudeSetupTimer.unref();
const app = createInstallationServer(
  config,
  executor,
  logger,
  profiles,
  settings,
  undefined,
  claudeSetup,
  startupFence,
);
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
    void claudeSetup.dispose();
    stopProfileSynchronization?.();
    stopSettingsReconciliation?.();
    server.close();
  });
