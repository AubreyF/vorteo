import type { ProviderUsageListPayload } from "./types";

/** A failed account fetch must not erase its last successful observation. Removed accounts stay removed. */
export function retainLastKnownUsage(
  next: ProviderUsageListPayload,
  previous: ProviderUsageListPayload | undefined,
): ProviderUsageListPayload {
  return {
    ...next,
    providers: next.providers.map((usage) => {
      const known = previous?.providers.find((entry) => entry.providerId === usage.providerId);
      const setupToken = usage.details?.some((detail) => detail.id === "claude-setup-token");
      if (
        known?.authRecovery &&
        usage.status !== "available" &&
        !usage.authRecovery &&
        !setupToken
      ) {
        return {
          ...usage,
          authRecovery: known.authRecovery,
          fetchedAt: usage.fetchedAt ?? next.fetchedAt,
        };
      }
      if (!usage.authRecovery && usage.status === "error" && known?.status === "available") {
        return {
          ...known,
          fetchedAt: known.fetchedAt ?? previous?.fetchedAt,
          refreshError: "Account usage refresh failed",
        };
      }
      return { ...usage, fetchedAt: usage.fetchedAt ?? next.fetchedAt };
    }),
  };
}
