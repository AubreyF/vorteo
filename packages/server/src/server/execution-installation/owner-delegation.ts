import { createHash } from "node:crypto";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { RestartRequestError } from "./restarts.js";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";

/**
 * Owner delegation lives beside the coordinator's other protected state, never in a
 * browser or a guest-writable mount. A missing or unreadable file delegates nothing.
 */
const OwnerDelegationSchema = z.strictObject({
  version: z.literal(1),
  /** Host-agent requester labels the owner trusts to handle requests, matched by prefix. */
  delegatedRequesterPrefixes: z.array(z.string().min(1).max(100)).max(20),
  /** Lets an automatically approved Host source update replace the supervisor. */
  hostUpdateServiceRestart: z.boolean(),
  /** Separate owner grant for exact, authenticated Host maintenance requests. */
  maintenanceApprovedAfter: z.string().datetime().nullable().optional(),
  maintenanceChangedAt: z.string().datetime().optional(),
  /** How long an unapproved delegated request may wait before the owner is prompted. */
  graceMinutes: z.number().int().min(1).max(60).optional(),
});
type StoredOwnerDelegation = z.infer<typeof OwnerDelegationSchema>;
export type OwnerDelegation = Omit<StoredOwnerDelegation, "graceMinutes"> & {
  graceMinutes: number;
};

const DEFAULT_GRACE_MINUTES = 15;
const NO_DELEGATION: OwnerDelegation = {
  version: 1,
  delegatedRequesterPrefixes: [],
  hostUpdateServiceRestart: false,
  graceMinutes: DEFAULT_GRACE_MINUTES,
};

export function readOwnerDelegation(stateDir: string): OwnerDelegation {
  const file = path.join(stateDir, "owner-delegation.json");
  if (!existsSync(file)) return NO_DELEGATION;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return NO_DELEGATION;
  }
  const parsed = OwnerDelegationSchema.safeParse(value);
  if (!parsed.success) return NO_DELEGATION;
  return { ...parsed.data, graceMinutes: parsed.data.graceMinutes ?? DEFAULT_GRACE_MINUTES };
}

export type Delegation =
  | { state: "handling"; requester: string }
  /** The delegate has not approved it in time, so the owner is prompted again. */
  | { state: "overdue"; requester: string };

const ACTIVE_STATUSES: ReadonlySet<RestartJob["status"]> = new Set([
  "pending",
  "approved",
  "running",
]);

/**
 * Display only. Requester prefixes are not authentication: a Host-agent credential
 * can submit any label, and approval never reads it. A matching label can hide the
 * owner prompt only while the request is automatically approved, already running, or
 * pending within the grace window; after that the normal prompt returns.
 * Dev requests are never delegated. A batch is delegated only when every remaining
 * contribution is.
 */
export function delegatedHandler(
  job: RestartJob,
  delegation: Pick<OwnerDelegation, "delegatedRequesterPrefixes" | "graceMinutes">,
  now: number,
): Delegation | null {
  const prefixes = delegation.delegatedRequesterPrefixes;
  if (!prefixes.length || !ACTIVE_STATUSES.has(job.status)) return null;
  const requests = job.sourceBatch
    ? job.sourceBatch.contributions.filter((item) => item.status !== "superseded")
    : [job];
  const delegated = ({ requestedBy, requester }: Pick<RestartJob, "requestedBy" | "requester">) =>
    requestedBy === "host-agent" &&
    requester !== undefined &&
    prefixes.some((prefix) => requester.startsWith(prefix));
  const [first] = requests;
  if (!first?.requester || !requests.every(delegated)) return null;
  const requester = first.requester;
  const withinGrace =
    job.status === "pending" && now - Date.parse(job.createdAt) < delegation.graceMinutes * 60_000;
  if (job.automaticApproval || job.status === "running" || withinGrace)
    return { state: "handling", requester };
  return job.status === "pending" ? { state: "overdue", requester } : null;
}

/** Requester labels never confer execution authority. Read the separate protected
 * owner grant on admission and dispatch so revocation takes effect immediately. */
function readMaintenanceDelegation(stateDir: string) {
  const parent = lstatSync(stateDir);
  if (
    realpathSync(stateDir) !== path.resolve(stateDir) ||
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o022) !== 0
  )
    throw new RestartRequestError("Maintenance delegation directory is not protected.");
  const file = path.join(stateDir, "owner-delegation.json");
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { revision: null, stored: NO_DELEGATION };
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 ||
      before.size > 16_384
    )
      throw new RestartRequestError("Maintenance delegation file is not protected.");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(file);
    const currentParent = lstatSync(stateDir);
    if (
      !(["dev", "ino", "size", "ctimeMs"] as const).every(
        (key) => before[key] === after[key] && current[key] === after[key],
      ) ||
      !(["dev", "ino"] as const).every((key) => currentParent[key] === parent[key]) ||
      realpathSync(stateDir) !== path.resolve(stateDir)
    )
      throw new RestartRequestError("Maintenance delegation changed while reading.");
    return {
      revision: createHash("sha256").update(bytes).digest("hex"),
      stored: OwnerDelegationSchema.parse(JSON.parse(bytes.toString("utf8"))),
    };
  } finally {
    closeSync(descriptor);
  }
}

export function maintenanceDelegationActivation(stateDir: string): string | null {
  try {
    return readMaintenanceDelegation(stateDir).stored.maintenanceApprovedAfter ?? null;
  } catch {
    // Unreadable or replaced authority never enables maintenance.
    return null;
  }
}

const MaintenanceDelegationChangeSchema = z.strictObject({
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  enabled: z.boolean(),
});

export function maintenanceDelegationStatus(stateDir: string) {
  const { revision, stored } = readMaintenanceDelegation(stateDir);
  const activatedAt = stored.maintenanceApprovedAfter ?? null;
  return { revision, activatedAt, enabled: activatedAt !== null };
}

/** Called only by the owner-authenticated route. It grants no new executor or target. */
export function changeMaintenanceDelegation(stateDir: string, input: unknown) {
  const change = MaintenanceDelegationChangeSchema.parse(input);
  const { revision, stored } = readMaintenanceDelegation(stateDir);
  if (change.expectedRevision !== revision)
    throw new RestartRequestError("Maintenance delegation changed. Refresh before saving.");
  if (Boolean(stored.maintenanceApprovedAfter) === change.enabled)
    return maintenanceDelegationStatus(stateDir);
  const file = path.join(stateDir, "owner-delegation.json");
  const changedAt = new Date(
    Math.max(Date.now(), Date.parse(stored.maintenanceChangedAt ?? "1970-01-01T00:00:00Z") + 1),
  ).toISOString();
  writePrivateFileAtomicSync(
    file,
    JSON.stringify({
      ...stored,
      maintenanceChangedAt: changedAt,
      maintenanceApprovedAfter: change.enabled ? changedAt : null,
    }),
  );
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return maintenanceDelegationStatus(stateDir);
}
