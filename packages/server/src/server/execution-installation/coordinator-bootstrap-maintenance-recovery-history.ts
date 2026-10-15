import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import { FileBootstrapRequestJournal } from "./coordinator-bootstrap-journal.js";
import { readProtectedDocument } from "./coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  MaintenanceRecoveryPlanSchema,
  inspectMaintenanceRecoveryPlan,
  inspectMaintenanceRecoveryPredecessorPlan,
} from "./coordinator-bootstrap-maintenance-recovery-plan.js";
import { verifyMaintenanceRecoveryPredecessor } from "./coordinator-bootstrap-maintenance-recovery-proof.js";

/** Read-only chain proof. A new claim must call assertCurrent under the shared
 * lifecycle lock and independently recheck native custody before effects. */
export async function inspectNativeMaintenanceRecoveryHistory(input: {
  stateDirectory: string;
  plan: unknown;
  account: { uid: number; home: string };
  reader: Parameters<typeof verifyMaintenanceRecoveryPredecessor>[0]["reader"];
  signal: AbortSignal;
  currentBoot?: Parameters<typeof verifyMaintenanceRecoveryPredecessor>[0]["currentBoot"];
}) {
  const initial = inspectMaintenanceRecoveryPlan(input.plan, input.account);
  const journal = new FileBootstrapRequestJournal(input.stateDirectory);
  const snapshot = journal.readLifecycle();
  const seen = new Set<string>();
  const files: Array<() => void> = [];
  const ancestors: Awaited<ReturnType<typeof verifyMaintenanceRecoveryPredecessor>>[] = [];
  let current = initial;
  for (;;) {
    input.signal.throwIfAborted();
    const link = current.plan.recoveryOf;
    if (seen.has(link.requestId) || seen.size >= initial.predecessor.plan.retryLimit)
      throw new BootstrapRequestConflict(
        "Recovery history is cyclic or exceeds its retained retry budget",
      );
    seen.add(link.requestId);
    const matches = snapshot.filter((job) => job.id === link.requestId);
    if (matches.length !== 1)
      throw new BootstrapRequestConflict("Recovery immediate predecessor is missing or ambiguous");
    const file = path.join(
      initial.identity.installationRoot,
      "maintenance-services",
      initial.identity.target,
      "plans",
      `${link.planSha256}.json`,
    );
    const assertFile = retainServiceFiles([file]);
    const value: unknown = JSON.parse((await readProtectedDocument(file)).toString("utf8"));
    assertFile();
    files.push(assertFile);
    inspectMaintenanceRecoveryPredecessorPlan(current, value, input.account);
    const proof = await verifyMaintenanceRecoveryPredecessor({
      retained: matches[0],
      plan: value,
      account: input.account,
      recoveryOf: link,
      reader: input.reader,
      currentBoot: input.currentBoot,
    });
    input.signal.throwIfAborted();
    ancestors.push(proof);
    const wrapper = MaintenanceRecoveryPlanSchema.safeParse(value);
    if (!wrapper.success) break;
    current = inspectMaintenanceRecoveryPlan(wrapper.data, input.account);
  }
  const assertCurrent = () => {
    input.signal.throwIfAborted();
    for (const assertFile of files) assertFile();
    for (const ancestor of ancestors) ancestor.assertExit();
    if (!isDeepStrictEqual(snapshot, journal.readLifecycle()))
      throw new BootstrapRequestConflict(
        "Recovery history changed during native exit verification",
      );
  };
  assertCurrent();
  return { plan: initial, ancestors, assertCurrent };
}
