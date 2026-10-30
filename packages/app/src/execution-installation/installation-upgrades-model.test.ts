import { describe, expect, it } from "vitest";
import type {
  InstallationSnapshot,
  InstallationUpgrade,
  SnapshotList,
  UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";
import {
  activeUpgrade,
  latestFinishedUpgrade,
  restoreProgress,
  snapshotPartsSummary,
  snapshotReasonLabel,
  snapshotRestorePlan,
  sortedSnapshots,
  upgradeApprovalText,
  upgradeOffer,
  upgradeStepRows,
} from "./installation-upgrades-model";

const snapshot: InstallationSnapshot = {
  version: 1,
  id: "20261030T120000Z",
  createdAt: "2026-10-30T12:00:00.000Z",
  reason: "upgrade",
  release: "release-942",
  parts: [
    { kind: "coordinator-state", source: "/var/vorteo/coordinator", files: 4, bytes: 100 },
    { kind: "dev-home", source: "docker:vorteo-dev:/home/dev", files: 9, bytes: 900 },
  ],
};

const restoreId = "6f1d7c2e-3c1b-4b8f-9d0a-1e2f3a4b5c6d";
function list(current: SnapshotList["restore"]): SnapshotList {
  return { available: true, detail: "", retention: 5, snapshots: [snapshot], restore: current };
}
function restoreStatus(status: "running" | "succeeded" | "failed", id = restoreId) {
  return {
    id,
    snapshotId: snapshot.id,
    status,
    step: "restart",
    detail: "",
    startedAt: snapshot.createdAt,
    updatedAt: snapshot.createdAt,
  };
}

function upgrade(
  status: InstallationUpgrade["status"],
  createdAt: string,
  release = "release-942",
): InstallationUpgrade {
  return {
    id: "0b6c9f4e-6c39-4e6e-9f6e-7a5d3c2b1a00",
    revision: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    release,
    sourceCommit: "a".repeat(40),
    previousCommit: null,
    createdAt,
    status,
    detail: "",
    steps: [{ name: "snapshot", status: "succeeded", detail: "20261030T120000Z" }],
  };
}

function upgrades(
  entries: InstallationUpgrade[],
  release: string | null = "release-941",
): UpgradeStatus {
  return {
    available: true,
    detail: "",
    repository: "terran-labs/vorteo",
    current: { sourceCommit: "b".repeat(40), release },
    container: true,
    upgrades: entries,
  };
}

describe("safety snapshots", () => {
  it("names the reason and every part", () => {
    expect(snapshotReasonLabel(snapshot)).toBe("Before upgrade to release-942");
    expect(snapshotReasonLabel({ ...snapshot, reason: "owner" })).toBe("Taken by owner");
    expect(snapshotPartsSummary(snapshot)).toBe(
      "Installation coordinator state, Dev container home",
    );
  });

  it("sorts newest first", () => {
    const older = { ...snapshot, id: "20261029T120000Z" };
    expect(
      sortedSnapshots({ ...list(null), snapshots: [older, snapshot] }).map((entry) => entry.id),
    ).toEqual([snapshot.id, older.id]);
  });

  it("confirms exactly the parts it will send, with their sources", () => {
    const plan = snapshotRestorePlan(snapshot, true, () => "Oct 30");
    expect(plan.parts).toEqual(["coordinator-state", "dev-home"]);
    expect(plan.title).toBe("Restore the snapshot from Oct 30?");
    expect(plan.message).toContain("Installation coordinator state: /var/vorteo/coordinator");
    expect(plan.message).toContain("Dev container home: docker:vorteo-dev:/home/dev");
    expect(plan.message).toContain("Running agents on the Host and in Dev are interrupted");
    expect(plan.message).toContain("disconnects for a minute or two");
  });

  it("leaves Dev out of the warning on a Host-only installation", () => {
    const plan = snapshotRestorePlan(snapshot, false, () => "Oct 30");
    expect(plan.message).toContain("the coordinator and the Host daemon");
    expect(plan.message).not.toContain("in Dev");
  });

  it("reloads only once the coordinator answers after the restore", () => {
    expect(restoreProgress(list(restoreStatus("running")), restoreId, false)).toBe("waiting");
    expect(restoreProgress(undefined, restoreId, true)).toBe("waiting");
    expect(restoreProgress(list(restoreStatus("succeeded")), restoreId, false)).toBe("reload");
    expect(restoreProgress(list(restoreStatus("failed")), restoreId, true)).toBe("failed");
    // A restarted coordinator that no longer reports the restore still means it is back.
    expect(restoreProgress(list(null), restoreId, true)).toBe("reload");
    expect(restoreProgress(list(null), restoreId, false)).toBe("waiting");
    expect(restoreProgress(list(restoreStatus("running", "other")), restoreId, true)).toBe(
      "waiting",
    );
  });
});

describe("release upgrades", () => {
  it("finds the active and the latest finished upgrade", () => {
    const failed = upgrade("failed", "2026-10-29T00:00:00.000Z");
    const pending = upgrade("pending", "2026-10-30T00:00:00.000Z");
    expect(activeUpgrade(upgrades([failed, pending]))).toBe(pending);
    expect(latestFinishedUpgrade(upgrades([failed, pending]))).toBe(failed);
    expect(activeUpgrade(upgrades([failed]))).toBeNull();
    expect(activeUpgrade(null)).toBeNull();
  });

  it("offers a newer release only when the coordinator supports upgrades and none is active", () => {
    const input = { latestRelease: "release-942", updateAvailable: true };
    expect(upgradeOffer({ ...input, status: upgrades([]) })).toBe("release-942");
    expect(upgradeOffer({ ...input, status: null })).toBeNull();
    expect(upgradeOffer({ ...input, status: { ...upgrades([]), available: false } })).toBeNull();
    expect(upgradeOffer({ ...input, status: upgrades([], "release-942") })).toBeNull();
    expect(upgradeOffer({ ...input, updateAvailable: false, status: upgrades([]) })).toBeNull();
    expect(
      upgradeOffer({
        ...input,
        status: upgrades([upgrade("running", "2026-10-30T00:00:00.000Z")]),
      }),
    ).toBeNull();
  });

  it("explains approval with and without Dev", () => {
    expect(upgradeApprovalText(true)).toContain("recreates the Dev container");
    expect(upgradeApprovalText(false)).not.toContain("Dev");
    expect(upgradeApprovalText(false)).toContain("takes a safety snapshot");
  });

  it("labels each step", () => {
    expect(upgradeStepRows(upgrade("running", "2026-10-30T00:00:00.000Z"))).toEqual([
      {
        name: "snapshot",
        label: "Take a safety snapshot",
        status: "succeeded",
        detail: "20261030T120000Z",
      },
    ]);
  });
});
