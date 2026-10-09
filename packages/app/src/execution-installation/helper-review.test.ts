import { helperReviewFixture } from "./helper-review.fixture";
import { helperRollbackSummary } from "./helper-review";
import { lockedMaintenanceSummary } from "./helper-review";
import { expect, test } from "vitest";
import { helperActionDisabledReason, helperReviewSummary } from "./helper-review";

const unlocked = { busy: false, unlocked: true };
const pending = { status: "pending", stage: "prepared" } as const;

test("helper approval explains locked controls and in-flight actions", () => {
  expect(helperActionDisabledReason(pending, "approve", { ...unlocked, unlocked: false })).toBe(
    "Unlock Installation controls to review this helper request.",
  );
  expect(helperActionDisabledReason(pending, "approve", { ...unlocked, busy: true })).toBe(
    "Wait for the current action to finish, then refresh its result.",
  );
  expect(helperActionDisabledReason(pending, "approve", unlocked)).toBeNull();
});

test("preparation blocks approval but keeps cancellation available", () => {
  const preparing = { status: "pending", stage: "preparing" } as const;
  expect(helperActionDisabledReason(preparing, "approve", unlocked)).toBe(
    "Artifact checks are still running. Approval becomes available when they pass.",
  );
  expect(helperActionDisabledReason(preparing, "cancel", unlocked)).toBeNull();
  expect(
    helperActionDisabledReason({ ...pending, status: "approved" }, "cancel", unlocked),
  ).toBeNull();
});

test("dispatch prevents cancellation and failure does not become an install approval", () => {
  expect(
    helperActionDisabledReason({ status: "running", stage: "installing" }, "cancel", unlocked),
  ).toBe("This request has dispatched or finished. Inspect its result before preparing recovery.");
  const failed = { status: "failed", stage: "recovery_required" } as const;
  expect(helperActionDisabledReason(failed, "approve", unlocked)).toBe(
    "This request is no longer awaiting approval. Refresh its status and review any replacement request.",
  );
  expect(helperActionDisabledReason(failed, "verify-installed", unlocked)).toBeNull();
  expect(helperActionDisabledReason(pending, "verify-installed", unlocked)).toBe(
    "Verification is available only for an interrupted installation that needs recovery.",
  );
});

test("recovery copy preserves the failed history and distinguishes rollback", () => {
  expect(
    helperReviewSummary({
      operation: "native-helper-install",
      status: "failed",
      stage: "recovered",
    }),
  ).toBe("The installed helper is verified. The earlier failure remains in history.");
  expect(helperReviewSummary({ ...pending, operation: "native-helper-rollback" })).toBe(
    "Restore the reviewed helper release. Host and Dev agents keep running; browser permissions stay unchanged.",
  );
});

test("locked controls retain helper-only pending and recovery status without private details", () => {
  const idle = { requested: 0, queued: 0, running: 0 };
  expect(lockedMaintenanceSummary(idle)).toBeNull();
  expect(
    lockedMaintenanceSummary({
      ...idle,
      nativeHelper: { requested: 1, queued: 0, running: 0, recovery: 1 },
    }),
  ).toBe(
    "0 requested · 0 queued · 0 restarting. 2 helper maintenance requests need attention. Unlock controls to review details.",
  );
});

test("rollback review identifies the retained selected release even without an older backup", () => {
  expect(helperRollbackSummary(helperReviewFixture.plan)).toContain("First installation");
  const previous = {
    ...helperReviewFixture.plan.candidate,
    sourceCommit: "c".repeat(40),
    artifactSha256: "d".repeat(64),
  };
  const plan = { ...helperReviewFixture.plan, previous, retainedRollback: null };
  expect(helperRollbackSummary(plan)).toBe(
    `Retained rollback source: ${previous.sourceCommit}\nRollback artifact: ${previous.artifactSha256}`,
  );
});
