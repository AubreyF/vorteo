import { existsSync, readFileSync } from "node:fs";
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
