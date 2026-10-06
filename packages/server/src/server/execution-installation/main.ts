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
const profiles = createInstallationProfiles(config);
const stopProfileSynchronization = startProfileSynchronization(profiles, logger);
const settings = createInstallationSettings(config);
const stopSettingsReconciliation = startSettingsReconciliation(settings, logger);
const app = createInstallationServer(
  config,
  createInstallationRestartExecutor(config),
  logger,
  profiles,
  settings,
);
const restartTimer = setInterval(() => {
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
    stopProfileSynchronization();
    stopSettingsReconciliation();
    server.close();
  });
