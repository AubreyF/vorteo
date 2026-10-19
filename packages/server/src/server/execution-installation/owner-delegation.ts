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
});
export type OwnerDelegation = z.infer<typeof OwnerDelegationSchema>;

const NO_DELEGATION: OwnerDelegation = {
  version: 1,
  delegatedRequesterPrefixes: [],
  hostUpdateServiceRestart: false,
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
  return parsed.success ? parsed.data : NO_DELEGATION;
}

const ACTIVE_STATUSES: ReadonlySet<RestartJob["status"]> = new Set([
  "pending",
  "approved",
  "running",
]);

/**
 * Requester labels are free text, so only Host-agent requests can be delegated.
 * A batch is delegated only when every remaining contribution is.
 */
export function delegatedHandler(job: RestartJob, prefixes: readonly string[]): string | null {
  if (!prefixes.length || !ACTIVE_STATUSES.has(job.status)) return null;
  const requests = job.sourceBatch
    ? job.sourceBatch.contributions.filter((item) => item.status !== "superseded")
    : [job];
  const delegated = ({ requestedBy, requester }: Pick<RestartJob, "requestedBy" | "requester">) =>
    requestedBy === "host-agent" &&
    requester !== undefined &&
    prefixes.some((prefix) => requester.startsWith(prefix));
  const [first] = requests;
  if (!first || !requests.every(delegated)) return null;
  return first.requester ?? null;
}
