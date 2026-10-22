import { providerUsageCopy } from "./copy";
import type { ProviderUsageListPayload, ProviderUsageView } from "./types";
import { toErrorMessage } from "@/utils/error-messages";

interface UsageViewInput {
  hasHost: boolean;
  connected: boolean;
  supported: boolean;
  data: ProviderUsageListPayload | undefined;
  fetching: boolean;
  error: unknown;
}

export function providerUsageView(input: UsageViewInput): ProviderUsageView {
  let refreshError: string | undefined;
  if (!input.connected) refreshError = providerUsageCopy.hostUnavailable;
  else if (!input.supported) refreshError = providerUsageCopy.hostUpgradeRequired;
  else if (input.error) refreshError = toErrorMessage(input.error);
  if (input.hasHost && input.data) {
    return { kind: "ready", payload: input.data, isRefreshing: input.fetching, refreshError };
  }
  if (!input.hasHost || refreshError) {
    return { kind: "error", message: refreshError ?? providerUsageCopy.hostUnavailable };
  }
  return { kind: "loading" };
}
