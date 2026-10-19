import { parseQuotaGovernorPolicy } from "@getpaseo/protocol/quota-governor";

/** Capture installation-owned limits; the native governor validates and enforces them. */
export function captureFactoryQuotaPolicy(policy) {
  const captured = parseQuotaGovernorPolicy(structuredClone(policy));
  if (!Number.isSafeInteger(captured.maxObservationAgeSeconds) || !captured.estimatedHourly)
    throw new Error("Factory host quota requires bounded account consumption and fresh telemetry");
  return captured;
}
