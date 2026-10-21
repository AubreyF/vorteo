import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CoordinatorBootstrapRequestSchema,
  type CoordinatorBootstrapRequest,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  StandingMaintenanceProposalSchema,
  type StandingMaintenanceProposal,
} from "@getpaseo/protocol/installation-enrollment";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  FileEnrollmentJournal,
  enrollmentManifestDigest,
  evaluateStandingProposal,
} from "./maintenance/authorization.js";

const NativeEvidenceSchema = z.strictObject({
  requestId: z.uuid(),
  requestRevision: z.uuid(),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  identitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.string().datetime(),
});
export type StandingBootstrapNativeVerifier = (
  request: CoordinatorBootstrapRequest,
  proposal: StandingMaintenanceProposal,
) => Promise<z.infer<typeof NativeEvidenceSchema> & { assertCurrent(): void }>;

/** Native callers supply their independent verifier, never a request-supplied
 * digest. This function has no process effects and inserts a new policy decision
 * into the existing visible coordinator request under shared lifecycle exclusion. */
export async function approveStandingBootstrap(input: {
  request: CoordinatorBootstrapRequest;
  proposal: StandingMaintenanceProposal;
  grantRevision: string;
  verify: StandingBootstrapNativeVerifier;
}) {
  const request = CoordinatorBootstrapRequestSchema.parse(input.request);
  const proposal = StandingMaintenanceProposalSchema.parse(input.proposal);
  if (
    request.status !== "pending" ||
    request.execution ||
    request.standingAuthority ||
    request.enrollment ||
    request.automaticSubmission
  )
    throw new BootstrapRequestConflict("Standing approval requires a new pending proposal");
  const enrollment = new FileEnrollmentJournal(request.plan.state.directory);
  evaluateStandingProposal({
    state: enrollment.read(),
    grantRevision: input.grantRevision,
    proposal,
  });
  const evidence = await verifyEvidence(request, proposal, input.verify);
  const journal = new FileBootstrapRequestJournal(request.plan.state.directory);
  return journal.withRecoveryTransaction((records, replace) => {
    requireExactRequest(records, request);
    const state = enrollment.readUnderLifecycleLock();
    const decision = evaluateStandingProposal({
      state,
      grantRevision: input.grantRevision,
      proposal,
    });
    if (state.status !== "enrolled")
      throw new BootstrapRequestConflict("Standing enrollment is absent");
    requireCurrentEvidence(evidence);
    const now = Date.now();
    const approved = CoordinatorBootstrapRequestSchema.parse({
      ...request,
      revision: randomUUID(),
      status: "approved",
      decisionAt: new Date(now).toISOString(),
      standingAuthority: {
        grantId: decision.grantId,
        grantRevision: decision.grantRevision,
        manifestSha256: enrollmentManifestDigest(state.grant.manifest),
        proposal,
        nativeEvidenceSha256: evidence.evidenceSha256,
        decidedAt: new Date(now).toISOString(),
        dispatchAfter: new Date(now + 30_000).toISOString(),
      },
    });
    replace(records.map((item) => (item.id === request.id ? approved : item)));
    return approved;
  });
}

/** Persist one launch reservation before spawning. A lost reply is not a new
 * opportunity to dispatch: the same reservation must be observed, never replayed. */
export async function reserveStandingBootstrapLaunch(input: {
  request: CoordinatorBootstrapRequest;
  verify: StandingBootstrapNativeVerifier;
}) {
  const request = CoordinatorBootstrapRequestSchema.parse(input.request);
  if (
    request.status !== "approved" ||
    !request.standingAuthority ||
    request.standingDispatch ||
    request.execution
  )
    throw new BootstrapRequestConflict("Standing launch is already reserved or unavailable");
  if (Date.now() < Date.parse(request.standingAuthority.dispatchAfter))
    throw new BootstrapRequestConflict(
      "Standing coordinator cancellation interval has not elapsed",
    );
  const evidence = await verifyEvidence(request, request.standingAuthority.proposal, input.verify);
  const journal = new FileBootstrapRequestJournal(request.plan.state.directory);
  return journal.withRecoveryTransaction((records, replace) => {
    requireExactRequest(records, request);
    requireCurrentEvidence(evidence);
    const next = CoordinatorBootstrapRequestSchema.parse({
      ...request,
      revision: randomUUID(),
      standingDispatch: {
        approvedRevision: request.revision,
        requestedAt: new Date(Date.now()).toISOString(),
        nativeEvidenceSha256: evidence.evidenceSha256,
      },
    });
    replace(records.map((item) => (item.id === request.id ? next : item)));
    return next;
  });
}

async function verifyEvidence(
  request: CoordinatorBootstrapRequest,
  proposal: StandingMaintenanceProposal,
  verify: StandingBootstrapNativeVerifier,
) {
  const inspected = await verify(structuredClone(request), structuredClone(proposal));
  const { assertCurrent, ...receipt } = inspected;
  if (typeof assertCurrent !== "function")
    throw new BootstrapRequestConflict("Native evidence requires a final custody recheck");
  const evidence = NativeEvidenceSchema.parse(receipt);
  if (
    evidence.requestId !== request.id ||
    evidence.requestRevision !== request.revision ||
    evidence.planSha256 !== request.planSha256 ||
    evidence.identitySha256 !== proposal.identitySha256 ||
    evidence.sourceCommit !== request.plan.candidate.sourceCommit ||
    evidence.artifactSha256 !== request.plan.candidate.artifactSha256
  )
    throw new BootstrapRequestConflict(
      "Native evidence differs from the standing coordinator proposal",
    );
  requireFreshEvidence(evidence);
  return { ...evidence, assertCurrent };
}
/** Recheck protected file/selection identities under the lifecycle lock. Native
 * inspection itself happens before the lock; this closure must not perform
 * asynchronous work, acquire another lock, or initiate lifecycle effects. */
function requireCurrentEvidence(
  evidence: z.infer<typeof NativeEvidenceSchema> & { assertCurrent(): void },
) {
  requireFreshEvidence(evidence);
  if (evidence.assertCurrent() !== undefined)
    throw new BootstrapRequestConflict("Native custody recheck must complete synchronously");
}
function requireFreshEvidence(evidence: z.infer<typeof NativeEvidenceSchema>) {
  const elapsed = Date.now() - Date.parse(evidence.observedAt);
  if (elapsed < 0 || elapsed > 30_000)
    throw new BootstrapRequestConflict("Standing native evidence is stale");
}
function requireExactRequest(
  records: CoordinatorBootstrapRequest[],
  request: CoordinatorBootstrapRequest,
) {
  if (
    !isDeepStrictEqual(
      records.find((item) => item.id === request.id),
      request,
    )
  )
    throw new BootstrapRequestConflict(
      "Standing coordinator request changed during native validation",
    );
}
