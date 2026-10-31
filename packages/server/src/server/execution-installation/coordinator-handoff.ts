import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import {
  InstallationSnapshotSchema,
  type SnapshotRestoreStatus,
} from "@getpaseo/protocol/installation-upgrades";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { ManagedServicesSchema, type ServiceControl } from "./service-control.js";
import {
  executeRestore,
  planRestore,
  type InstallationSnapshots,
  type RestorePorts,
} from "./snapshots.js";

/**
 * The coordinator cannot restart or restore itself from inside its own process:
 * its service manager stops it first. It writes one of these plans and starts a
 * detached helper (coordinator-handoff-main.js from the running release), which
 * performs the plan, waits for the coordinator to answer, rolls back on timeout and
 * records the outcome for whichever coordinator starts next.
 */
const HealthSchema = z.strictObject({
  url: z.url(),
  installationId: z.string().uuid(),
  /** The coordinator that wrote the plan. Ready means a different process answered. */
  previousPid: z.number().int().positive(),
});

export const CoordinatorSwapPlanSchema = z.strictObject({
  kind: z.literal("coordinator-swap"),
  id: z.string().uuid(),
  releaseLink: z.string().startsWith("/"),
  previous: z.string().startsWith("/"),
  next: z.string().startsWith("/"),
  services: ManagedServicesSchema,
  health: HealthSchema,
  outcomeFile: z.string().startsWith("/"),
  timeoutMs: z.number().int().positive(),
});
export type CoordinatorSwapPlan = z.infer<typeof CoordinatorSwapPlanSchema>;

export const RestorePlanSchema = z.strictObject({
  kind: z.literal("restore"),
  id: z.string().uuid(),
  snapshotRoot: z.string().startsWith("/"),
  snapshotId: InstallationSnapshotSchema.shape.id,
  services: ManagedServicesSchema,
  health: HealthSchema,
  statusFile: z.string().startsWith("/"),
  timeoutMs: z.number().int().positive(),
});
export type RestorePlan = z.infer<typeof RestorePlanSchema>;

export const HandoffPlanSchema = z.discriminatedUnion("kind", [
  CoordinatorSwapPlanSchema,
  RestorePlanSchema,
]);
export type HandoffPlan = z.infer<typeof HandoffPlanSchema>;

export const HandoffOutcomeSchema = z.strictObject({
  id: z.string().uuid(),
  status: z.enum(["succeeded", "rolled-back", "failed"]),
  detail: z.string(),
  finishedAt: z.string().datetime(),
});
export type HandoffOutcome = z.infer<typeof HandoffOutcomeSchema>;

export function readHandoffOutcome(file: string): HandoffOutcome | null {
  if (!existsSync(file)) return null;
  return HandoffOutcomeSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const HealthReplySchema = z.object({
  installationId: z.string(),
  pid: z.number().int().optional(),
  bootstrap: z.object({ fenced: z.boolean().optional() }).optional(),
});

export interface HandoffPorts {
  services: ServiceControl;
  now(): Date;
  sleep(ms: number): Promise<void>;
  fetchHealth(url: string): Promise<unknown>;
}

/** Polls coordinator health until a new, unfenced process of this installation answers. */
export async function waitForCoordinator(
  health: z.infer<typeof HealthSchema>,
  timeoutMs: number,
  ports: Pick<HandoffPorts, "now" | "sleep" | "fetchHealth">,
  previousPid: number | null = health.previousPid,
): Promise<void> {
  const deadline = ports.now().getTime() + timeoutMs;
  while (ports.now().getTime() < deadline) {
    try {
      const reply = HealthReplySchema.parse(await ports.fetchHealth(health.url));
      if (
        reply.installationId === health.installationId &&
        !reply.bootstrap?.fenced &&
        reply.pid !== undefined &&
        reply.pid !== previousPid
      )
        return;
    } catch {
      // Not answering yet.
    }
    await ports.sleep(1000);
  }
  throw new Error(`The coordinator did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

/** Repoints a release symlink atomically. */
export function pointLink(link: string, target: string): void {
  const temporary = path.join(path.dirname(link), `.${path.basename(link)}.${process.pid}.next`);
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}

export interface SwapPorts extends HandoffPorts {
  readLink(link: string): string;
  pointLink(link: string, target: string): void;
}

/**
 * Selects the new coordinator release and restarts the service. If the new
 * coordinator does not answer in time, selects the previous release again and
 * restarts once more.
 */
export async function runCoordinatorSwap(
  plan: CoordinatorSwapPlan,
  ports: SwapPorts,
): Promise<HandoffOutcome> {
  const finish = (status: HandoffOutcome["status"], detail: string): HandoffOutcome => ({
    id: plan.id,
    status,
    detail,
    finishedAt: ports.now().toISOString(),
  });
  const current = ports.readLink(plan.releaseLink);
  if (current !== plan.previous && current !== plan.next)
    return finish("failed", "The coordinator release link changed. Nothing was replaced.");
  ports.pointLink(plan.releaseLink, plan.next);
  try {
    await ports.services.restart("coordinator");
    await waitForCoordinator(plan.health, plan.timeoutMs, ports);
    return finish("succeeded", `The coordinator now runs ${plan.next}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ports.pointLink(plan.releaseLink, plan.previous);
    try {
      await ports.services.restart("coordinator");
      await waitForCoordinator(plan.health, plan.timeoutMs, ports, null);
      return finish(
        "rolled-back",
        `The new coordinator failed (${reason}). The previous coordinator is running again.`,
      );
    } catch (rollbackError) {
      const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      return finish(
        "failed",
        `The new coordinator failed (${reason}), and the previous one did not come back (${detail}). Start it with the vorteo repair command.`,
      );
    }
  }
}

export interface RestoreHandoffPorts extends HandoffPorts {
  snapshots: Pick<InstallationSnapshots, "read" | "storedParts">;
  importDocker: RestorePorts["snapshot"]["importDocker"];
  writeStatus(status: SnapshotRestoreStatus): void;
}

export async function runRestore(
  plan: RestorePlan,
  ports: RestoreHandoffPorts,
): Promise<SnapshotRestoreStatus> {
  const startedAt = ports.now().toISOString();
  let status: SnapshotRestoreStatus = {
    id: plan.id,
    snapshotId: plan.snapshotId,
    status: "running",
    step: "Starting",
    detail: "",
    startedAt,
    updatedAt: startedAt,
  };
  const update = (changes: Partial<SnapshotRestoreStatus>) => {
    status = { ...status, ...changes, updatedAt: ports.now().toISOString() };
    ports.writeStatus(status);
  };
  update({});
  try {
    const parts = ports.snapshots.storedParts(ports.snapshots.read(plan.snapshotId));
    await executeRestore({
      restoreId: plan.id,
      parts,
      steps: planRestore(parts, plan.services.dev !== undefined),
      ports: {
        services: ports.services,
        snapshot: { importDocker: ports.importDocker },
        verifyCoordinator: () => waitForCoordinator(plan.health, plan.timeoutMs, ports, null),
        progress: (step) => update({ step }),
      },
    });
    update({ status: "succeeded", detail: `Restored snapshot ${plan.snapshotId}.` });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    update({
      status: "failed",
      detail: `Restore failed and the replaced files were put back: ${detail}`,
    });
  }
  return status;
}

/** Starts the helper outside the coordinator's process group, cgroup and lifetime. */
export function launchHandoff(input: {
  node: string;
  helper: string;
  planFile: string;
  logFile: string;
  plan: HandoffPlan;
}): void {
  writePrivateFileAtomicSync(input.planFile, JSON.stringify(input.plan, null, 2));
  const systemd = "systemdService" in input.plan.services.coordinator;
  // systemd stops every process in a unit's cgroup, detached or not, so the helper
  // runs as its own transient user unit. launchd stops only the job's process group.
  const [command, args] = systemd
    ? [
        "/usr/bin/systemd-run",
        [
          "--user",
          "--collect",
          "--quiet",
          `--unit=vorteo-handoff-${input.plan.id}`,
          `--property=StandardOutput=append:${input.logFile}`,
          `--property=StandardError=append:${input.logFile}`,
          input.node,
          input.helper,
          input.planFile,
        ],
      ]
    : [input.node, [input.helper, input.planFile]];
  const log = openSync(input.logFile, "a", 0o600);
  try {
    const child = spawn(command, args, { detached: !systemd, stdio: ["ignore", log, log] });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function readCurrentLink(link: string): string {
  return path.resolve(path.dirname(link), readlinkSync(link));
}
