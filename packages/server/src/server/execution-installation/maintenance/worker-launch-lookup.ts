import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  WorkerLaunchRequestSchema,
  WorkerLaunchNativeIdentitySchema,
  type RestartJob,
  type WorkerLaunchBinding,
} from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "../config.js";
import { FileBootstrapRequestJournal } from "../coordinator-bootstrap-journal.js";
import { readEnrollmentNativeIdentity } from "./native-registration.js";

const LookupSchema = z.strictObject({
  installationId: z.uuid(),
  serverId: z.string().min(1).max(256),
  targetIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  hints: WorkerLaunchRequestSchema,
  supervisor: WorkerLaunchNativeIdentitySchema,
});
export type WorkerLaunchLookup = z.infer<typeof LookupSchema>;
const QuerySchema = z.strictObject({
  workerLaunch: z.literal("1"),
  lookup: z.string().min(1).max(4096),
});

export class WorkerLaunchLookupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Query values are exact selectors into protected retained state, never native
 * evidence. PID-only requester hints cannot distinguish supervisor lifetimes. */
export function parseWorkerLaunchLookupQuery(
  query: unknown,
  encodedUrl: string,
): WorkerLaunchLookup {
  if (Buffer.byteLength(encodedUrl, "utf8") > 16 * 1024)
    throw new WorkerLaunchLookupError(400, "Worker launch lookup exceeds its size limit");
  const values = QuerySchema.parse(query);
  if (Buffer.byteLength(values.lookup, "utf8") > 4096)
    throw new WorkerLaunchLookupError(400, "Worker launch lookup exceeds its size limit");
  let value: unknown;
  try {
    value = JSON.parse(values.lookup);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new WorkerLaunchLookupError(400, "Invalid worker launch lookup");
    throw error;
  }
  return parseLookup(value);
}

function parseLookup(value: unknown): WorkerLaunchLookup {
  const lookup = LookupSchema.parse(value);
  if (lookup.hints.supervisorPid !== lookup.supervisor.pid)
    throw new WorkerLaunchLookupError(400, "Worker launch lookup supervisor differs");
  return lookup;
}

function causeHint(cause: WorkerLaunchBinding["cause"]) {
  return cause.kind === "startup"
    ? { kind: cause.kind, registrationGeneration: cause.registrationGeneration }
    : { kind: cause.kind, generation: cause.generation };
}

function assertConfiguredTarget(config: InstallationConfig, lookup: WorkerLaunchLookup): void {
  const environment = config.public.environments.find((item) => item.kind === "container");
  if (
    lookup.installationId !== config.public.installationId ||
    environment?.serverId !== lookup.serverId
  )
    throw new WorkerLaunchLookupError(403, "Worker launch lookup belongs to another environment");
  const settings = config.containerSourceUpdates;
  if (!settings)
    throw new WorkerLaunchLookupError(
      503,
      "Immutable Dev configuration is unavailable for worker launch lookup",
    );
  let identity;
  try {
    identity = readEnrollmentNativeIdentity(config.stateDir, lookup.targetIdentitySha256);
  } catch {
    throw new WorkerLaunchLookupError(503, "Protected worker launch target is unavailable");
  }
  if (
    identity.environment !== "container" ||
    identity.target !== "container-daemon" ||
    identity.installationId !== config.public.installationId ||
    identity.stateDirectory !== config.stateDir
  )
    throw new WorkerLaunchLookupError(403, "Worker launch target differs from this installation");
  if (
    identity.containerId !== settings.containerId ||
    identity.containerStateDirectory !== settings.home ||
    identity.selectionPath !== settings.currentReleaseLink ||
    identity.containerUid !== lookup.supervisor.uid
  )
    throw new WorkerLaunchLookupError(
      403,
      "Worker launch target differs from configured Dev identity",
    );
}

/** Observation only, including after revocation. Never calls the queue/controller,
 * consumes a generation or uses the transaction's replacement callback. */
export function lookupWorkerLaunch(config: InstallationConfig, input: WorkerLaunchLookup) {
  const lookup = parseLookup(input);
  const journal = new FileBootstrapRequestJournal(config.stateDir);
  return journal.withRecoveryTransaction(() => {
    assertConfiguredTarget(config, lookup);
    const matches = journal.readLifecycle().filter((job): job is RestartJob => {
      if (job.target !== "container-daemon" || !job.workerLaunch) return false;
      const binding = job.workerLaunch.binding;
      return (
        binding.targetIdentitySha256 === lookup.targetIdentitySha256 &&
        isDeepStrictEqual(binding.supervisor, lookup.supervisor) &&
        isDeepStrictEqual(causeHint(binding.cause), lookup.hints.cause)
      );
    });
    if (matches.length > 1)
      throw new WorkerLaunchLookupError(409, "Worker launch cause has multiple retained records");
    const job = matches[0];
    if (!job || job.workerLaunch!.binding.profileSha256 !== lookup.hints.profileSha256) return null;
    if (job.workerLaunch!.binding.requestId !== job.id)
      throw new WorkerLaunchLookupError(409, "Retained worker launch request binding differs");
    // A maintenance parent may carry Host diagnostics unrelated to this child.
    // The negotiated child response must not expose its raw detail or authority.
    return {
      id: job.id,
      revision: job.revision,
      status: job.status,
      detail: `Retained worker launch is ${job.workerLaunch!.phase}. Native custody observation remains separate.`,
      workerLaunch: structuredClone(job.workerLaunch!),
    };
  });
}
