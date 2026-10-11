import { createHash } from "node:crypto";
import path from "node:path";
import { readBootstrapPreparedFile } from "./coordinator-bootstrap-artifact.js";

import { PreviewMonitorPlanSchema } from "@getpaseo/protocol/preview-monitor-maintenance";
export { PreviewMonitorPlanSchema };

export interface PreviewMonitorAdmission {
  installationId: string;
  containerId: string;
  containerHome: string;
  writableMountRoots: readonly string[];
  // Collected by trusted Host inspection, never taken from the submitted plan.
  observed: {
    containerId: string;
    destination: string;
    canonicalPath: string;
    sha256: string;
    uid: number;
    gid: number;
    mode: number;
    regularFile: boolean;
    links: number;
    ancestrySha256: string;
  };
}

/** Read-only admission, to be repeated before dispatch by the tracked coordinator.
 * The signed macOS helper's installer and automatic daemon approval do not apply. */
export async function verifyPreviewMonitorPreparation(
  input: unknown,
  admission: PreviewMonitorAdmission,
) {
  const plan = PreviewMonitorPlanSchema.parse(input);
  if (plan.installationId !== admission.installationId)
    throw new Error("Preview monitor plan belongs to another installation");
  if (plan.containerId !== admission.containerId)
    throw new Error("Preview monitor plan belongs to another container");
  const home = admission.containerHome;
  if (!path.posix.isAbsolute(home) || path.posix.normalize(home) !== home)
    throw new Error("Preview monitor requires a canonical protected container home");
  const destination = path.posix.join(home, ".local/bin/paseo-preview");
  if (plan.destination !== destination)
    throw new Error("Preview monitor plan must use its fixed destination");
  const observed = admission.observed;
  const sameTarget =
    observed.containerId === plan.containerId && observed.destination === destination;
  const safeFile =
    observed.canonicalPath === destination && observed.regularFile && observed.links === 1;
  if (!sameTarget || !safeFile)
    throw new Error("Preview monitor target is missing, aliased or belongs to another container");
  if (observed.ancestrySha256 !== plan.ancestrySha256)
    throw new Error("Reviewed monitor directory ancestry changed");
  const expected = plan.expected;
  const sameSelection = observed.sha256 === expected.sha256;
  const sameOwnership = observed.uid === expected.uid && observed.gid === expected.gid;
  if (!sameSelection || !sameOwnership || observed.mode !== expected.mode)
    throw new Error("Preview monitor selection, ownership or mode changed");
  if (plan.previous.sha256 !== expected.sha256)
    throw new Error("Preview monitor rollback must retain the exact current bytes");
  if (plan.candidate.path === plan.previous.path || plan.candidate.sha256 === plan.previous.sha256)
    throw new Error(
      "Preview monitor replacement requires distinct candidate and rollback artifacts",
    );
  const candidate = await readBootstrapPreparedFile(plan.candidate, admission.writableMountRoots);
  const previous = await readBootstrapPreparedFile(plan.previous, admission.writableMountRoots);
  const planSha256 = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  return { plan, planSha256, candidate, previous };
}
