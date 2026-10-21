import type {
  EnrollmentTarget,
  InstallationEnrollmentStatus,
} from "@getpaseo/protocol/installation-enrollment";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export const maintenanceTargetLabels: Record<EnrollmentTarget, string> = {
  host: "Host",
  "container-daemon": "Dev",
  coordinator: "Coordinator",
  supervisor: "Supervisor",
  "maintenance-controller": "Maintenance controller",
  "recovery-launcher": "Recovery launcher",
};

interface MaintenanceHeadline {
  label: string;
  variant: StatusBadgeVariant;
  explanation: string;
}

/** Authority, recorded migration and current service health answer different questions. */
export function maintenanceHeadline(status: InstallationEnrollmentStatus): MaintenanceHeadline {
  if (status.activation === "recovery-required")
    return {
      label: "Recovery required",
      variant: "error",
      explanation:
        "An installation step did not verify completion. Its retained outcome must be reconciled before another step can start.",
    };
  if (status.activation === "unconfirmed")
    return {
      label: "Verifying outcome",
      variant: "warning",
      explanation:
        "A dispatched step has no verified result yet. The same step will not be dispatched again.",
    };
  if (status.services.some((service) => service.readiness === "blocked"))
    return {
      label: "Service needs attention",
      variant: "error",
      explanation:
        "A current service observation reports a problem. See the affected service below.",
    };
  if (status.authority === "not-enrolled")
    return {
      label: "Not activated",
      variant: "muted",
      explanation:
        "Unattended maintenance has not been activated. Existing approval rules remain in effect.",
    };
  if (status.authority === "revoked")
    return {
      label: "Maintenance revoked",
      variant: "muted",
      explanation:
        "The saved maintenance grant is revoked. Already dispatched work may only complete its authorized stabilization.",
    };
  if (status.authority === "paused")
    return {
      label: "Maintenance paused",
      variant: "muted",
      explanation:
        "New automatic maintenance is paused. Service readiness is shown separately below.",
    };
  if (status.activation === "pending")
    return {
      label: "Activation pending",
      variant: "warning",
      explanation:
        "The enrollment decision is recorded. Installation steps still need to complete and verify their results.",
    };
  if (!status.services.length || status.services.some((service) => service.readiness === "unknown"))
    return {
      label: "Readiness unverified",
      variant: "warning",
      explanation:
        "Activation receipts are retained, but current readiness has not been verified for every service.",
    };
  return {
    label: "Ready",
    variant: "success",
    explanation:
      "Activation is verified and every enrolled service has a fresh readiness observation.",
  };
}

/** Old servers and expired observations supply historical receipts, never live health. */
export function currentMaintenanceStatus(
  status: InstallationEnrollmentStatus,
  now: number,
): InstallationEnrollmentStatus {
  const deadline = Date.parse(status.validUntil ?? "");
  const checkedAt = Date.parse(status.checkedAt);
  if (Number.isFinite(deadline) && now >= checkedAt && now < deadline) return status;
  return {
    ...status,
    services: status.services.map((service) => ({
      ...service,
      readiness: "unknown",
      reason: "Last known observation has expired. Refresh to verify current readiness.",
      selectedSource: null,
    })),
  };
}
