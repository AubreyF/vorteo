import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import { readPrivateBootstrapConfiguration } from "./coordinator-bootstrap-private-configuration.js";
import { MaintenanceLauncherSetupSchema } from "./coordinator-bootstrap-maintenance-setup.js";
import { userInfo } from "node:os";
import {
  createMaintenanceControlApp,
  MaintenanceOwnerConfigurationSchema,
} from "./coordinator-bootstrap-maintenance-control.js";

/** Independent access starts without enrollment or lifecycle parsing. Registration
 * must protect this setup and its runtime; opening the listener grants no effects. */
export async function runIndependentMaintenanceRecovery(setupFile: string) {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new BootstrapRequestConflict("Independent recovery requires the native Host account");
  const readSetup = () =>
    MaintenanceLauncherSetupSchema.parse(readPrivateBootstrapConfiguration(setupFile, uid));
  const setup = readSetup();
  const access = setup.control?.recoveryAccess;
  if (setup.target !== "recovery-launcher" || !access)
    throw new BootstrapRequestConflict(
      "Recovery access requires its explicit protected launcher setup",
    );
  const refuseEffects = () => {
    throw new BootstrapRequestConflict(
      "Independent recovery does not expose enrollment provisioning or main application health through this endpoint.",
    );
  };
  const review = async () => {
    const { createIndependentCoordinatorRecoveryReviews } =
      await import("./coordinator-bootstrap-maintenance-recovery-rollback.js");
    const account = userInfo();
    return createIndependentCoordinatorRecoveryReviews({
      setupFile,
      account: { uid: account.uid, home: account.homedir },
      stateDirectory: setup.enrollmentStateDirectory,
    });
  };
  const app = createMaintenanceControlApp({
    installationId: access.installationId,
    recoveryOrigin: access.origin,
    status: refuseEffects,
    provision: refuseEffects,
    async prepareRollback() {
      await (await review()).prepareRollback();
    },
    async readOwnerConfiguration() {
      if (!isDeepStrictEqual(readSetup(), setup))
        throw new BootstrapRequestConflict("Protected recovery setup changed");
      const owner = MaintenanceOwnerConfigurationSchema.parse(
        readPrivateBootstrapConfiguration(access.ownerConfigurationFile, uid),
      );
      if (owner.stateDir !== setup.enrollmentStateDirectory)
        throw new BootstrapRequestConflict(
          "Recovery owner configuration belongs to another state directory",
        );
      return owner;
    },
    service: review,
  });
  const server = createServer(app);
  const listening = once(server, "listening");
  server.listen(access.listenPort, "127.0.0.1");
  await listening;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const setupFile = process.argv[2];
  if (!setupFile || process.argv.length !== 3) {
    process.stderr.write("Independent recovery requires one protected setup file.\n");
    process.exitCode = 1;
  } else {
    void runIndependentMaintenanceRecovery(setupFile).catch(() => {
      process.stderr.write("Independent recovery access could not open its protected listener.\n");
      process.exitCode = 1;
    });
  }
}
