import { z } from "zod";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
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
import {
  CoordinatorBootstrapPreparationSchema,
  CoordinatorSubmissionProofSchema,
  type CoordinatorSubmissionProof,
  type CoordinatorAutomaticAuthority,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapAuthenticationRequired, coordinatorPlanDigest } from "./coordinator-bootstrap.js";

type CoordinatorAutomationConfig = Pick<
  InstallationConfig,
  "public" | "stateDir" | "hostAgentTokenHash" | "containerAgentTokenHash" | "ownerPasswordHash"
>;

/** Only scoped Host admission signs. The proof authorizes one exact preparation,
 * not a generic daemon session, and carries neither credentials nor reusable keys. */
export function signCoordinatorSubmission(
  config: CoordinatorAutomationConfig,
  input: unknown,
): CoordinatorSubmissionProof {
  const authority = coordinatorAutomaticAuthority(config);
  if (!authority)
    throw new BootstrapAuthenticationRequired("Coordinator automatic permission is disabled");
  const prepared = CoordinatorBootstrapPreparationSchema.parse(input);
  const signature = createHmac("sha256", Buffer.from(config.hostAgentTokenHash, "hex"))
    .update(
      JSON.stringify({
        scope: "coordinator-submission-v1",
        authority,
        id: prepared.id,
        reason: prepared.reason,
        planSha256: coordinatorPlanDigest(prepared.plan),
      }),
    )
    .digest("hex");
  return { policyActivatedAt: authority.policyActivatedAt, signature };
}

export function verifyCoordinatorSubmission(
  config: CoordinatorAutomationConfig,
  input: unknown,
  value: unknown,
): CoordinatorAutomaticAuthority {
  const proof = CoordinatorSubmissionProofSchema.parse(value);
  const expected = signCoordinatorSubmission(config, input);
  if (
    proof.policyActivatedAt !== expected.policyActivatedAt ||
    !timingSafeEqual(Buffer.from(proof.signature, "hex"), Buffer.from(expected.signature, "hex"))
  )
    throw new BootstrapAuthenticationRequired("Exact scoped Host coordinator submission required");
  const authority = coordinatorAutomaticAuthority(config);
  if (!authority || authority.policyActivatedAt !== proof.policyActivatedAt)
    throw new BootstrapAuthenticationRequired("Coordinator automatic permission changed");
  return authority;
}

/** Read protected installation state on each decision and claim. No daemon or
 * legacy permission can supply a coordinator activation epoch. */
export function coordinatorAutomaticAuthority(
  config: CoordinatorAutomationConfig,
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

const StoredPreferenceSchema = DaemonAutomationPreferenceSchema.extend({
  changedAt: z.string().datetime().optional(),
});

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
    const { changedAt: _changedAt, ...preference } = this.readStored();
    return preference;
  }

  private readStored(): z.infer<typeof StoredPreferenceSchema> {
    if (!existsSync(this.file)) {
      return {
        revision: null,
        enabled: false,
        enabledAfter: null,
        legacyHostOnly: this.legacyHostOnly,
      };
    }
    const state = StoredPreferenceSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
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
    const current = this.readStored();
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
      return this.read();
    // Persist every transition, including disable, so an immediate re-enable or
    // a clock correction cannot revive a grant from the previous activation.
    const previousActivations = Object.values(services).map((value) =>
      value ? Date.parse(value) : 0,
    );
    const previousChange = Date.parse(current.changedAt ?? "1970-01-01T00:00:00Z");
    const lastChange = Math.max(previousChange, ...previousActivations);
    const changedAt = new Date(Math.max(Date.now(), lastChange + 1)).toISOString();
    const activatedAt = change.enabled ? changedAt : null;
    for (const service of targets) services[service] = activatedAt;
    const enabled = Boolean(services.host && services["container-daemon"]);
    const next: DaemonAutomationPreference = {
      revision: randomUUID(),
      enabled,
      enabledAfter: enabled ? [services.host!, services["container-daemon"]!].sort()[0] : null,
      legacyHostOnly: false,
      services,
    };
    writePrivateFileAtomicSync(this.file, JSON.stringify({ ...next, changedAt }));
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
