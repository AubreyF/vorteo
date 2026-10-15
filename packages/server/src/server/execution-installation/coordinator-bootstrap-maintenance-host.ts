import { approveEnrolledBootstrap } from "./coordinator-bootstrap-maintenance-dispatch.js";
import { enrollmentManifestDigest } from "./maintenance/authorization.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  CoordinatorBootstrapPreparationSchema,
  CoordinatorBootstrapDecisionSchema,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, coordinatorPlanDigest } from "./coordinator-bootstrap.js";
import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import type { BootstrapReviewService } from "./coordinator-bootstrap-session.js";
import { createDispatchingBootstrapReview } from "./coordinator-bootstrap-launch.js";
import {
  createBootstrapReviewService,
  BootstrapAdmissionSetupSchema,
  readPrivateBootstrapConfiguration,
} from "./coordinator-bootstrap-host.js";
import { readProvisionedMaintenance } from "./coordinator-bootstrap-maintenance-provisioning.js";
import { verifyRenewalPlan } from "./coordinator-bootstrap-renewal.js";
import { createNativeBootstrapServiceReader } from "./coordinator-bootstrap-service.js";

/** Restrict every exposed action to the single admitted review. Automatic
 * submission/reconciliation and unrelated cancellation are deliberately absent. */
export function bindMaintenanceReview(
  service: BootstrapReviewService,
  binding: { requestId: string; planSha256: string },
): BootstrapReviewService {
  const assertId = (id: string) => {
    if (id !== binding.requestId)
      throw new BootstrapRequestConflict("Maintenance admission belongs to another request");
  };
  const list = () => {
    const own = service.list().filter((request) => request.id === binding.requestId);
    if (
      own.some(
        (request) =>
          request.planSha256 !== binding.planSha256 ||
          request.automaticApproval ||
          request.automaticSubmission ||
          request.automaticDispatch,
      )
    )
      throw new BootstrapRequestConflict("Admitted manual maintenance request changed");
    return own;
  };
  return {
    available: true,
    list,
    prepare: async (value) => {
      const input = CoordinatorBootstrapPreparationSchema.parse(value);
      assertId(input.id);
      if (coordinatorPlanDigest(input.plan) !== binding.planSha256)
        throw new BootstrapRequestConflict("Maintenance preparation changed its admitted plan");
      return service.prepare(input);
    },
    decide: async (value, password) => {
      const decision = CoordinatorBootstrapDecisionSchema.parse(value);
      assertId(decision.id);
      if (decision.planSha256 !== binding.planSha256)
        throw new BootstrapRequestConflict("Maintenance decision changed its admitted plan");
      if (list().length !== 1)
        throw new BootstrapRequestConflict("Exact admitted maintenance review is unavailable");
      return service.decide(decision, password);
    },
  };
}

/** The pinned controller can construct a review, not replay an existing decision.
 * Only the shared exact owner-decision path below starts the managed executor. */
export async function createProvisionedMaintenanceReview(input: {
  installationRoot: string;
  admissionSha256: string;
  enrollmentSha256?: string;
}): Promise<
  BootstrapReviewService & {
    activateEnrollment?: () => Promise<
      import("@getpaseo/protocol/coordinator-bootstrap").CoordinatorBootstrapRequest
    >;
  }
> {
  const initial = await readProvisionedMaintenance(input);
  const setup = {
    ...initial.runner,
    maintenance: {
      installationRoot: input.installationRoot,
      admissionSha256: input.admissionSha256,
    },
  };
  const admission = BootstrapAdmissionSetupSchema.parse(
    readPrivateBootstrapConfiguration(setup.admissionSetupFile, process.getuid!()),
  );
  const verifySetup = async () => {
    const current = await readProvisionedMaintenance(input);
    if (!isDeepStrictEqual(initial, current))
      throw new BootstrapRequestConflict(
        "Maintenance context changed; inspect its retained review",
      );
    const expectedModule = path.join(
      initial.receipt.runtime.directory,
      "packages/server/dist/server/server/execution-installation/coordinator-bootstrap-maintenance-host.js",
    );
    if (
      fileURLToPath(import.meta.url) !== expectedModule ||
      (await realpath(process.execPath)) !== setup.node.path
    )
      throw new BootstrapRequestConflict("Maintenance controller is outside its admitted runtime");
    const args = [
      setup.node.path,
      setup.entrypoint.path,
      input.installationRoot,
      "maintenance-control",
      input.admissionSha256,
      ...(input.enrollmentSha256 ? [input.enrollmentSha256] : []),
    ];
    const reader = await createNativeBootstrapServiceReader({
      ...admission,
      writableMountRoots: current.writableMountRoots,
    });
    const processIdentity = ProcessObservationSchema.parse(
      await reader.inspectProcess(process.pid),
    );
    if (
      !isDeepStrictEqual(process.argv, args) ||
      processIdentity.uid !== process.getuid!() ||
      processIdentity.executable !== setup.node.path ||
      processIdentity.argumentsSha256 !==
        createHash("sha256").update(JSON.stringify(args)).digest("hex")
    )
      throw new BootstrapRequestConflict(
        "Maintenance controller identity differs from its admission",
      );
    return current.writableMountRoots;
  };
  await verifySetup();
  const requests = await createBootstrapReviewService(setup.admissionSetupFile, setup.daemonId, {
    setup: { ...admission, configurationFile: setup.renewal!.configuration.path },
    verify: async (plan) => {
      await verifySetup();
      await verifyRenewalPlan(setup, plan);
    },
  });
  const service = createDispatchingBootstrapReview({
    setup,
    setupFile: path.join(
      input.installationRoot,
      "maintenance-admissions",
      input.admissionSha256,
      "runner.json",
    ),
    requests,
    verifySetup,
    enrollment: input.enrollmentSha256 !== undefined,
  });
  const bound = bindMaintenanceReview(service, initial.receipt);
  if (!input.enrollmentSha256) return bound;
  return {
    ...bound,
    activateEnrollment: async () => {
      const { readMaintenanceEnrollmentReview } =
        await import("./coordinator-bootstrap-maintenance-controller.js");
      const review = await readMaintenanceEnrollmentReview(
        path.join(input.installationRoot, "maintenance-admissions", input.admissionSha256),
        input.enrollmentSha256!,
        input.admissionSha256,
        initial.receipt.installationId,
      );
      await verifySetup();
      if (
        review.manifest.targets.find((target) => target.target === "coordinator")
          ?.identitySha256 !== initial.coordinatorIdentitySha256
      )
        throw new BootstrapRequestConflict("Native coordinator identity differs from enrollment");
      const pending = await bound.prepare({
        id: initial.receipt.requestId,
        plan: initial.plan,
        reason: "Activate the exact coordinator step under the recorded installation enrollment.",
      });
      const approved = approveEnrolledBootstrap({
        request: pending,
        admissionSha256: input.admissionSha256,
        review: {
          id: review.id,
          revision: review.revision,
          manifestSha256: enrollmentManifestDigest(review.manifest),
        },
      });
      return service.dispatchEnrolled(approved);
    },
  };
}
