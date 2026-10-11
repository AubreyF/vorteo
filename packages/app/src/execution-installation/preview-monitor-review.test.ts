import { expect, test } from "vitest";
import { monitorActionDisabledReason, monitorReviewSummary } from "./preview-monitor-review";
const state = { busy: false, unlocked: true };
test("manual review and cancellation track exact stage", () => {
  expect(
    monitorActionDisabledReason({ status: "pending", stage: "prepared" }, "approve", state),
  ).toBeNull();
  expect(
    monitorActionDisabledReason({ status: "pending", stage: "preparing" }, "approve", state),
  ).toBeTruthy();
  expect(
    monitorActionDisabledReason({ status: "approved", stage: "prepared" }, "cancel", state),
  ).toBeNull();
  expect(
    monitorActionDisabledReason({ status: "running", stage: "dispatch_pending" }, "cancel", state),
  ).toBeTruthy();
  expect(
    monitorActionDisabledReason({ status: "pending", stage: "prepared" }, "approve", {
      ...state,
      unlocked: false,
    }),
  ).toContain("Unlock");
  expect(
    monitorActionDisabledReason({ status: "pending", stage: "prepared" }, "cancel", {
      ...state,
      busy: true,
    }),
  ).toContain("Wait");
});
test("uncertainty never offers replay or rollback", () => {
  expect(monitorReviewSummary({ status: "failed", stage: "recovery_required" })).toContain(
    "Never replay or roll back automatically",
  );
});
