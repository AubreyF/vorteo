import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { NativeHelperArtifactError } from "./native-helper-artifact.js";

import { NativeHelperProcessIdentitySchema as NativeHelperIdentitySchema } from "@getpaseo/protocol/native-helper-maintenance";
export { NativeHelperIdentitySchema };
const StatusSchema = z.strictObject({
  ok: z.literal(true),
  code: z.string().regex(/^safari_permission_-?\d+$/),
  protocolVersion: z.literal(2),
  process: NativeHelperIdentitySchema,
});
export type NativeHelperIdentity = z.infer<typeof NativeHelperIdentitySchema>;
export interface NativeHelperProcess {
  pid: number;
  uid: number;
  executable: string;
  startedAt: string;
}
export interface NativeHelperReadiness {
  readStatus(): Promise<unknown>;
  inspectProcess(pid: number): Promise<NativeHelperProcess>;
  expectedExecutable: string;
  expectedUid: number;
  previous?: NativeHelperIdentity;
}

const execute = promisify(execFile);
export async function inspectNativeHelperProcess(pid: number): Promise<NativeHelperProcess> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647)
    throw new NativeHelperArtifactError("Invalid helper process identity");
  const result = await execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=,lstart=,comm="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16384,
  });
  const match = result.stdout
    .trim()
    .match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\/[^\n]+)$/);
  if (!match) throw new NativeHelperArtifactError("Cannot inspect the helper process");
  return { pid, uid: Number(match[1]), startedAt: match[2]!, executable: match[3]! };
}

/** Status must use the signature-verified, authenticated client. Two observations
 * reject exit/replacement during readiness rather than accepting a stale reply. */
export async function verifyNativeHelperReadiness(
  options: NativeHelperReadiness,
): Promise<NativeHelperIdentity> {
  const first = StatusSchema.parse(await options.readStatus()).process;
  const before = await options.inspectProcess(first.pid);
  const second = StatusSchema.parse(await options.readStatus()).process;
  const after = await options.inspectProcess(second.pid);
  const sameInstance =
    first.pid === second.pid &&
    first.instanceId === second.instanceId &&
    first.executable === second.executable;
  const stableProcess = before.pid === after.pid && before.startedAt === after.startedAt;
  if (!sameInstance || !stableProcess)
    throw new NativeHelperArtifactError("Helper process changed during readiness verification");
  for (const observed of [before, after]) {
    if (
      observed.pid !== first.pid ||
      observed.uid !== options.expectedUid ||
      observed.executable !== options.expectedExecutable ||
      first.executable !== options.expectedExecutable
    )
      throw new NativeHelperArtifactError("Running helper does not match the selected executable");
  }
  if (options.previous?.instanceId === first.instanceId)
    throw new NativeHelperArtifactError("Previous helper instance is still running");
  return first;
}
