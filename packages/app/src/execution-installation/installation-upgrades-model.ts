import {
  SNAPSHOT_PART_LABELS,
  UPGRADE_STEP_LABELS,
  type InstallationSnapshot,
  type InstallationUpgrade,
  type SnapshotList,
  type SnapshotPartKind,
  type UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";

// Pure views of safety snapshots and release upgrades for Installation controls and the
// update section. The coordinator owns every decision; these only describe its replies.

export function snapshotReasonLabel(snapshot: InstallationSnapshot): string {
  if (snapshot.reason === "upgrade")
    return snapshot.release ? `Before upgrade to ${snapshot.release}` : "Before upgrade";
  if (snapshot.reason === "restore") return "Before restore";
  return "Taken by owner";
}

export function snapshotPartsSummary(snapshot: InstallationSnapshot): string {
  return snapshot.parts.map((part) => SNAPSHOT_PART_LABELS[part.kind]).join(", ");
}

/** Newest first. Snapshot ids sort by creation time, so ties keep a stable order. */
export function sortedSnapshots(list: SnapshotList): InstallationSnapshot[] {
  return list.snapshots.toSorted((left, right) => right.id.localeCompare(left.id));
}

export interface SnapshotRestorePlan {
  /** Exactly the parts the confirmation names, sent back as the restore request. */
  parts: SnapshotPartKind[];
  title: string;
  message: string;
}

export function snapshotRestorePlan(
  snapshot: InstallationSnapshot,
  hasDev: boolean,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): SnapshotRestorePlan {
  const replaced = snapshot.parts
    .map((part) => `${SNAPSHOT_PART_LABELS[part.kind]}: ${part.source}`)
    .join("\n");
  const services = hasDev
    ? "the coordinator, the Host daemon and the Dev container"
    : "the coordinator and the Host daemon";
  const agents = hasDev ? "Running agents on the Host and in Dev" : "Running agents on the Host";
  return {
    parts: snapshot.parts.map((part) => part.kind),
    title: `Restore the snapshot from ${formatTime(snapshot.createdAt)}?`,
    message: `This replaces:\n${replaced}\n\nVorteo stops ${services}, replaces these parts, then starts them again. ${agents} are interrupted, and this interface disconnects for a minute or two.`,
  };
}

export type RestoreProgress = "waiting" | "reload" | "failed";

/**
 * Where a restore this interface started stands. The coordinator restarts during a restore,
 * so failed queries are expected; once it answers again without a running restore, reload.
 */
export function restoreProgress(
  list: SnapshotList | null | undefined,
  restoreId: string,
  coordinatorWasUnreachable: boolean,
): RestoreProgress {
  const restore = list?.restore;
  if (restore?.id === restoreId) {
    if (restore.status === "succeeded") return "reload";
    if (restore.status === "failed") return "failed";
    return "waiting";
  }
  return list && coordinatorWasUnreachable && restore?.status !== "running" ? "reload" : "waiting";
}

const ACTIVE_UPGRADE_STATUSES = new Set<InstallationUpgrade["status"]>([
  "pending",
  "approved",
  "running",
]);

export function upgradeIsActive(upgrade: InstallationUpgrade): boolean {
  return ACTIVE_UPGRADE_STATUSES.has(upgrade.status);
}

function newestUpgrades(status: UpgradeStatus): InstallationUpgrade[] {
  return status.upgrades.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** The upgrade waiting for approval or in progress. The coordinator runs one at a time. */
export function activeUpgrade(
  status: UpgradeStatus | null | undefined,
): InstallationUpgrade | null {
  if (!status) return null;
  return newestUpgrades(status).find(upgradeIsActive) ?? null;
}

/** The newest upgrade that ended, shown until another one starts. */
export function latestFinishedUpgrade(
  status: UpgradeStatus | null | undefined,
): InstallationUpgrade | null {
  if (!status) return null;
  return newestUpgrades(status).find((upgrade) => !upgradeIsActive(upgrade)) ?? null;
}

/**
 * The release to offer, or null. Offers need a coordinator that supports upgrades, a newer
 * published release and no upgrade already waiting or running.
 */
export function upgradeOffer(input: {
  status: UpgradeStatus | null | undefined;
  latestRelease: string | undefined;
  updateAvailable: boolean;
}): string | null {
  const { status, latestRelease } = input;
  if (!status?.available || !latestRelease || !input.updateAvailable) return null;
  if (status.current?.release === latestRelease) return null;
  if (activeUpgrade(status)) return null;
  return latestRelease;
}

export function upgradeApprovalText(hasDev: boolean): string {
  return hasDev
    ? "Approval takes a safety snapshot, then restarts the Host daemon, replaces the installation coordinator and recreates the Dev container. Running agents are interrupted."
    : "Approval takes a safety snapshot, then restarts the Host daemon and replaces the installation coordinator. Running agents are interrupted.";
}

const UPGRADE_STATUS_LABELS: Record<InstallationUpgrade["status"], string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  running: "Upgrading",
  succeeded: "Upgraded",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function upgradeStatusLabel(upgrade: InstallationUpgrade): string {
  return UPGRADE_STATUS_LABELS[upgrade.status];
}

export interface UpgradeStepRow {
  name: InstallationUpgrade["steps"][number]["name"];
  label: string;
  status: InstallationUpgrade["steps"][number]["status"];
  detail: string;
}

export function upgradeStepRows(upgrade: InstallationUpgrade): UpgradeStepRow[] {
  return upgrade.steps.map((step) => ({
    name: step.name,
    label: UPGRADE_STEP_LABELS[step.name],
    status: step.status,
    detail: step.detail,
  }));
}
