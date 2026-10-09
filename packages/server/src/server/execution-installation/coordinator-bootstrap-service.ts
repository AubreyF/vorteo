import { createHash } from "node:crypto";
import { z } from "zod";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

const ProcessObservationSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  startIdentity: z.string().regex(/^\d+:\d+$/),
  argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.string().startsWith("/"),
});

export interface BootstrapServiceReader {
  readService(service: string): Promise<string>;
  inspectProcess(pid: number): Promise<unknown>;
}

export async function verifyLoadedBootstrapService(input: {
  plan: CoordinatorBootstrapPlan;
  hostUid: number;
  configurationFile: string;
  reader: BootstrapServiceReader;
}): Promise<void> {
  for (let observation = 0; observation < 2; observation++) {
    const launchctlOutput = await input.reader.readService(input.plan.service);
    const pid = loadedCoordinatorPid(input.plan.service, launchctlOutput);
    // Do not inspect an unexpected process merely because a service changed.
    if (pid !== input.plan.expectedProcess.pid)
      throw new BootstrapRequestConflict("Loaded coordinator PID changed during verification");
    const process = await input.reader.inspectProcess(pid);
    verifyBootstrapServiceIdentity({ ...input, launchctlOutput, process });
  }
  const finalService = await input.reader.readService(input.plan.service);
  if (loadedCoordinatorPid(input.plan.service, finalService) !== input.plan.expectedProcess.pid)
    throw new BootstrapRequestConflict("Loaded coordinator PID changed during verification");
}

/** Read only the top-level PID from launchctl's service record. Nested resource
 * records and incomplete or ambiguous output cannot identify the coordinator. */
export function loadedCoordinatorPid(service: string, output: string): number {
  if (!output.startsWith(`${service} = {\n`) || !output.trimEnd().endsWith("\n}"))
    throw new BootstrapRequestConflict("Loaded coordinator service identity does not match");
  const pids = [...output.matchAll(/^\tpid = ([1-9]\d*)$/gm)];
  if (pids.length !== 1)
    throw new BootstrapRequestConflict("Loaded coordinator PID is missing or ambiguous");
  const pid = Number(pids[0]?.[1]);
  if (!Number.isSafeInteger(pid))
    throw new BootstrapRequestConflict("Loaded coordinator PID is invalid");
  return pid;
}

/** The output and kernel observation come from trusted read-only Host collectors.
 * File integrity, protected paths and a second observation still gate dispatch. */
export function verifyBootstrapServiceIdentity(input: {
  plan: CoordinatorBootstrapPlan;
  launchctlOutput: string;
  process: unknown;
  hostUid: number;
  configurationFile: string;
}): void {
  const observation = ProcessObservationSchema.parse(input.process);
  const pid = loadedCoordinatorPid(input.plan.service, input.launchctlOutput);
  const expected = input.plan.expectedProcess;
  const matchesProcess =
    pid === expected.pid &&
    observation.pid === pid &&
    observation.bootId === expected.bootId &&
    observation.startIdentity === expected.startIdentity &&
    observation.argumentsSha256 === expected.argumentsSha256;
  if (!matchesProcess)
    throw new BootstrapRequestConflict("Loaded coordinator process changed since preparation");
  if (observation.uid !== input.hostUid || observation.parentPid !== 1)
    throw new BootstrapRequestConflict("Coordinator is not owned by the Host launch service");
  const argumentsDigest = createHash("sha256")
    .update(
      JSON.stringify([
        input.plan.previous.node.path,
        input.plan.previous.entrypoint.path,
        input.configurationFile,
      ]),
    )
    .digest("hex");
  const matchesLauncher =
    observation.executable === input.plan.previous.node.path &&
    observation.argumentsSha256 === argumentsDigest;
  if (!matchesLauncher)
    throw new BootstrapRequestConflict("Running coordinator does not match the prepared launcher");
}
