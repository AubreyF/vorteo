import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { setInterval } from "node:timers/promises";
import path from "node:path";
import type { Logger } from "pino";
import { writePrivateFileAtomicSync } from "../../private-files.js";
import type { InstallationConfig } from "../config.js";
import { connectInstallationDaemon } from "../daemon.js";
import {
  InstallationProfiles,
  ProfileSharingStateSchema,
  type ProfileEnvironment,
} from "./service.js";

export function createInstallationProfiles(config: InstallationConfig): InstallationProfiles {
  const directory = path.join(config.stateDir, "shared-profiles");
  const file = path.join(directory, "state.json");
  const environments: ProfileEnvironment[] = config.public.environments.map((environment) => {
    const target: ProfileEnvironment = {
      serverId: environment.serverId,
      kind: environment.kind,
      workerAccounts: false,
      async read() {
        target.workerAccounts = false;
        const client = await connectInstallationDaemon(config, environment.kind);
        try {
          if (client.getLastServerInfoMessage()?.features?.installationProfileAuthority !== true)
            throw new Error("Update the daemon to preserve shared profile identities");
          target.workerAccounts =
            client.getLastServerInfoMessage()?.features?.explicitWorkerAccounts === true;
          return (await client.getDaemonConfig()).config;
        } finally {
          await client.close();
        }
      },
      async patch(patch) {
        const client = await connectInstallationDaemon(config, environment.kind);
        try {
          return (await client.patchDaemonConfig(patch)).config;
        } finally {
          await client.close();
        }
      },
    };
    return target;
  });
  return new InstallationProfiles(
    {
      read: () =>
        existsSync(file)
          ? ProfileSharingStateSchema.parse(JSON.parse(readFileSync(file, "utf8")))
          : null,
      write(state) {
        writePrivateFileAtomicSync(file, JSON.stringify(state, null, 2));
        syncReceipt(file);
      },
      backup(configs) {
        const backups = path.join(directory, "backups");
        mkdirSync(backups, { recursive: true, mode: 0o700 });
        const receipt = path.join(backups, `${randomUUID()}.json`);
        writeFileSync(receipt, JSON.stringify(configs, null, 2), { mode: 0o600, flag: "wx" });
        syncReceipt(receipt);
      },
    },
    environments,
    config.public.installationId,
  );
}

export function startProfileSynchronization(
  profiles: InstallationProfiles,
  logger: Logger,
): () => void {
  let running = false;
  async function synchronize() {
    if (running) return;
    running = true;
    try {
      await profiles.synchronize();
    } catch {
      logger.warn(
        "Shared profiles are waiting for every environment to become available and support shared provider preferences",
      );
    } finally {
      running = false;
    }
  }
  const controller = new AbortController();
  async function poll() {
    try {
      for await (const _tick of setInterval(5000, undefined, {
        signal: controller.signal,
        ref: false,
      })) {
        void synchronize();
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  }
  void poll();
  void synchronize();
  return () => controller.abort();
}

function syncReceipt(file: string): void {
  for (const target of [file, path.dirname(file)]) {
    const fd = openSync(target, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
