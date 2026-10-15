import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DaemonAutomationChangeSchema,
  DaemonAutomationPreferenceSchema,
  type DaemonAutomationPreference,
  type MaintenanceService,
} from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { RestartRequestError } from "./restarts.js";
import type { InstallationConfig } from "./config.js";
import type { CoordinatorAutomaticAuthority } from "@getpaseo/protocol/coordinator-bootstrap";

/** Read protected installation state on each decision and claim. No daemon or
 * legacy permission can supply a coordinator activation epoch. */
export function coordinatorAutomaticAuthority(
  config: InstallationConfig,
): CoordinatorAutomaticAuthority | null {
  const policyActivatedAt = new DaemonAutomation(config.stateDir, false).activation("coordinator");
  if (!policyActivatedAt) return null;
  const credentialBinding = createHash("sha256")
    .update(
      JSON.stringify({
        scope: "coordinator-maintenance-v1",
        installation: config.public.installationId,
        host: config.hostAgentTokenHash,
        container: config.containerAgentTokenHash,
        owner: config.ownerPasswordHash,
      }),
    )
    .digest("hex");
  return { credentialBinding, policyActivatedAt };
}

/** Owner preference lives with the coordinator, not a browser or a replaceable daemon. */
export class DaemonAutomation {
  private readonly file: string;
  constructor(
    private readonly stateDir: string,
    private readonly legacyHostOnly: boolean,
    private readonly legacyActivatedAt?: string,
  ) {
    this.file = path.join(stateDir, "daemon-automation.json");
  }

  read(): DaemonAutomationPreference {
    if (!existsSync(this.file)) {
      return {
        revision: null,
        enabled: false,
        enabledAfter: null,
        legacyHostOnly: this.legacyHostOnly,
      };
    }
    const state = DaemonAutomationPreferenceSchema.parse(
      JSON.parse(readFileSync(this.file, "utf8")),
    );
    if (
      !state.revision ||
      state.legacyHostOnly ||
      state.enabled !== (state.enabledAfter !== null)
    ) {
      throw new RestartRequestError("Invalid retained daemon automation preference");
    }
    return state;
  }

  servicePermissions(): NonNullable<DaemonAutomationPreference["services"]> {
    const state = this.read();
    if (state.services) return state.services;
    let inherited = state.enabledAfter;
    if (state.revision === null)
      inherited = this.legacyHostOnly ? (this.legacyActivatedAt ?? null) : null;
    return { host: inherited, "container-daemon": inherited, coordinator: null, supervisor: null };
  }

  activation(service: MaintenanceService = "host"): string | null | undefined {
    const state = this.read();
    if (state.services) return state.services[service];
    if (service === "coordinator" || service === "supervisor") return null;
    if (state.revision === null) return undefined;
    return state.enabledAfter;
  }

  change(input: unknown): DaemonAutomationPreference {
    const change = DaemonAutomationChangeSchema.parse(input);
    const current = this.read();
    if (change.expectedRevision !== current.revision) {
      throw new RestartRequestError("Daemon automation preference changed. Refresh before saving.");
    }
    const services = this.servicePermissions();
    const targets: MaintenanceService[] = change.service
      ? [change.service]
      : ["host", "container-daemon"];
    if (
      current.revision !== null &&
      targets.every((service) => Boolean(services[service]) === change.enabled)
    )
      return current;
    const activatedAt = change.enabled ? new Date().toISOString() : null;
    for (const service of targets) services[service] = activatedAt;
    const enabled = Boolean(services.host && services["container-daemon"]);
    const next: DaemonAutomationPreference = {
      revision: randomUUID(),
      enabled,
      enabledAfter: enabled ? [services.host!, services["container-daemon"]!].sort()[0] : null,
      legacyHostOnly: false,
      services,
    };
    writePrivateFileAtomicSync(this.file, JSON.stringify(next));
    // The preference must survive power loss before the queue can grant authority.
    for (const target of [this.file, this.stateDir]) {
      const fd = openSync(target, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return next;
  }
}
