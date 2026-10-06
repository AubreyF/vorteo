import { expect, it } from "vitest";
import { quotaReading } from "./quota-reading";
import { retainLastKnownUsage } from "./usage-cache";
import { selectedPresetPresentation } from "../agent-profiles/selected-preset-presentation";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";

const healthy: ProviderUsageListPayload = {
  requestId: "test",
  fetchedAt: new Date(0).toISOString(),
  providers: [
    {
      providerId: "account-one",
      displayName: "Account one",
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", remainingPct: 80 }],
    },
  ],
};
const rejected: ProviderUsageListPayload = {
  ...healthy,
  providers: [
    {
      ...healthy.providers[0],
      status: "error",
      windows: [],
      authRecovery: { instructions: "Sign in to account one." },
    },
  ],
};

it("shows rejection instead of cached usage and clears it after recovery", () => {
  const failed = retainLastKnownUsage(rejected, healthy);
  const view: ProviderUsageView = { kind: "ready", payload: failed, isRefreshing: false };
  expect(quotaReading(view, "account-one", 0).statusLabel).toBe("Account disconnected");
  expect(quotaReading(view, "account-one", 0).remaining).toBeNull();
  expect(quotaReading(view, "another-account", 0).authRecovery).toBeUndefined();
  const transient = {
    ...rejected,
    providers: [{ ...rejected.providers[0], authRecovery: undefined }],
  };
  expect(retainLastKnownUsage(transient, failed).providers[0].authRecovery).toEqual(
    rejected.providers[0].authRecovery,
  );
  const recovered = retainLastKnownUsage(healthy, failed);
  expect(quotaReading({ ...view, payload: recovered }, "account-one", 0).remaining).toBe(80);
  expect(recovered.providers[0].authRecovery).toBeUndefined();
});
it("shows the selected account warning in Vorteo", () => {
  const result = selectedPresetPresentation({
    view: { kind: "ready", payload: rejected, isRefreshing: false },
    now: 0,
    selectedProfileId: "one",
    definitions: [{ id: "one", name: "One", provider: "account-one" }],
  });
  expect(result.showWarning).toBe(true);
  expect(result.showRing).toBe(false);
  expect(result.accessibilityLabel.includes("account disconnected")).toBe(true);
});
it("does not mistake transient failure or missing usage for an account disconnect", () => {
  const unavailable: ProviderUsageListPayload = {
    ...healthy,
    providers: [{ ...healthy.providers[0], status: "unavailable", windows: [] }],
  };
  const reading = quotaReading(
    { kind: "ready", payload: unavailable, isRefreshing: false },
    "account-one",
    0,
  );
  expect(reading.authRecovery).toBeUndefined();
  expect(reading.statusLabel).toBe("Usage unavailable");
});
