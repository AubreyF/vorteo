import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { z } from "zod";
import {
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  assertRecoveredBootstrapBase,
  bootstrapRecoveryRelease,
  isCompletedBootstrap,
  BootstrapRequestConflict,
  coordinatorPlanDigest,
} from "./coordinator-bootstrap.js";

const StartupIdentitySchema = z.strictObject({
  installationId: z.string().uuid(),
  stateDirectory: z.string().startsWith("/"),
  node: z.string().startsWith("/"),
  entrypoint: z.string().startsWith("/"),
  configuration: z.string().startsWith("/"),
});
export type CoordinatorStartupIdentity = z.infer<typeof StartupIdentitySchema>;
export type CoordinatorStartupAdmission =
  | { kind: "ordinary" }
  | { kind: "fenced"; request: CoordinatorBootstrapRequest };

function replacedBootstrapRequests(requests: CoordinatorBootstrapRequest[]): Set<string> {
  const replaced = new Set<string>();
  for (const request of requests) {
    if (!request.execution) continue;
    let previous = assertRecoveredBootstrapBase(request.plan, requests);
    const seen = new Set<string>([request.id]);
    while (previous) {
      if (seen.has(previous.id))
        throw new BootstrapRequestConflict("Cyclic bootstrap startup history");
      seen.add(previous.id);
      replaced.add(previous.id);
      previous = assertRecoveredBootstrapBase(previous.plan, requests);
    }
  }
  return replaced;
}

/** Evaluate before constructing any queue, reconciliation service or writable
 * journal. The caller must use canonical native executable/configuration paths.
 * Fenced admission permits a readiness listener with its restart queue fenced
 * and all background synchronization disabled. Missing or malformed evidence is not release. */
export function coordinatorStartupAdmission(
  records: unknown,
  identity: CoordinatorStartupIdentity,
): CoordinatorStartupAdmission {
  const current = StartupIdentitySchema.parse(identity);
  const requests = z.array(CoordinatorBootstrapRequestSchema).parse(records);
  if (new Set(requests.map((request) => request.id)).size !== requests.length)
    throw new BootstrapRequestConflict("Duplicate bootstrap startup records");
  for (const request of requests) {
    if (
      request.plan.installationId !== current.installationId ||
      request.plan.state.directory !== current.stateDirectory ||
      request.planSha256 !== coordinatorPlanDigest(request.plan) ||
      (request.execution && request.status !== "approved")
    )
      throw new BootstrapRequestConflict("Bootstrap startup evidence does not match installation");
  }
  const replaced = replacedBootstrapRequests(requests);
  // Retain completed generations as audit evidence without counting them as
  // active owners of the next handoff. Unresolved unrelated failures still fence startup.
  const dispatched = requests.filter(
    (request) => request.execution && !replaced.has(request.id) && !isCompletedBootstrap(request),
  );
  if (dispatched.length > 1)
    throw new BootstrapRequestConflict("Multiple bootstrap ownership generations require recovery");
  const request = dispatched[0];
  if (!request?.execution) return { kind: "ordinary" };
  const matches = (release: CoordinatorBootstrapRequest["plan"]["candidate"]) =>
    current.node === release.node.path &&
    current.entrypoint === release.entrypoint.path &&
    current.configuration === release.configuration.path;
  const previousArguments = createHash("sha256")
    .update(JSON.stringify([current.node, current.entrypoint, current.configuration]))
    .digest("hex");
  const matchesPrevious =
    current.node === request.plan.previous.node.path &&
    current.entrypoint === request.plan.previous.entrypoint.path &&
    previousArguments === request.plan.expectedProcess.argumentsSha256;
  const matchesRecovery =
    request.plan.automaticRecovery === "restore-compatible"
      ? matches(bootstrapRecoveryRelease(request.plan))
      : matchesPrevious;
  if (request.execution.stage === "rollback_pending" && matchesRecovery)
    return { kind: "ordinary" };
  if (!matches(request.plan.candidate))
    throw new BootstrapRequestConflict("Coordinator startup does not match selected candidate");
  if (!["start_pending", "started", "verifying"].includes(request.execution.stage))
    throw new BootstrapRequestConflict("Coordinator startup requires observed bootstrap recovery");
  return { kind: "fenced", request };
}

/** Readiness waiters cannot accept deletion, cancellation, replacement or an
 * unrelated successful receipt as permission to start normal services. */
export function coordinatorStartupReleased(
  records: unknown,
  identity: CoordinatorStartupIdentity,
  expected: CoordinatorBootstrapRequest,
): boolean {
  if (!expected.execution) throw new BootstrapRequestConflict("Startup generation is missing");
  const admission = coordinatorStartupAdmission(records, identity);
  const requests = z.array(CoordinatorBootstrapRequestSchema).parse(records);
  const current = requests.find((request) => request.id === expected.id);
  if (
    !current ||
    current.planSha256 !== expected.planSha256 ||
    current.execution?.generation !== expected.execution.generation
  )
    throw new BootstrapRequestConflict("Bootstrap startup ownership changed");
  return admission.kind === "ordinary" && current.execution.stage === "succeeded";
}

/** The journal is colocated with the coordinator state by protected Host setup.
 * Read failures propagate; they never turn an active handoff into normal boot. */
export function loadCoordinatorStartupFence(identity: CoordinatorStartupIdentity) {
  const current = StartupIdentitySchema.parse(identity);
  try {
    lstatSync(current.stateDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const journal = new FileBootstrapRequestJournal(current.stateDirectory);
  const admission = coordinatorStartupAdmission(journal.readPromoted(), current);
  if (admission.kind === "ordinary") return undefined;
  const expected = admission.request;
  if (!expected.execution) throw new BootstrapRequestConflict("Startup generation is missing");
  return {
    generation: expected.execution.generation,
    released: () => coordinatorStartupReleased(journal.readPromoted(), current, expected),
  };
}
