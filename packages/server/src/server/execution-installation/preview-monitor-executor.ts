import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { PreviewMonitorSelectionSchema } from "@getpaseo/protocol/preview-monitor-maintenance";
import type {
  PreviewMonitorConfiguration,
  PreviewMonitorJob,
  PreviewMonitorPlan,
} from "@getpaseo/protocol/preview-monitor-maintenance";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
} from "./coordinator-bootstrap-artifact.js";
import { InstallationRestarts } from "./restarts.js";
import { parseLifecycleJournal } from "./lifecycle-journal.js";
import { verifyPreviewMonitorPreparation } from "./preview-monitor-maintenance.js";

export interface MonitorCommand {
  executable: string;
  args: string[];
  input?: string;
}
export async function monitorCommand(command: MonitorCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let size = 0;
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Monitor transport timed out; inspect before recovery"));
    }, 30_000);
    const fail = (error: Error) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(error);
      }
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) {
        child.kill();
        fail(new Error("Monitor reply exceeded limit"));
      } else output += chunk.toString("utf8");
    });
    // Never include command input or container stderr in owner-visible errors.
    child.stderr.resume();
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Monitor transport failed; inspect before recovery"));
      else resolve(output);
    });
    child.stdin.end(command.input);
  });
}

interface MonitorContext {
  installationId: string;
  configuration: PreviewMonitorConfiguration;
  writableMountRoots(): Promise<readonly string[]>;
}
interface MonitorTools {
  command: typeof monitorCommand;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Only protected coordinator configuration constructs this transport. No service control. */
export function createPreviewMonitorExecutor(
  context: MonitorContext,
  tools: MonitorTools = { command: monitorCommand },
) {
  const config = context.configuration;
  async function protectedTools() {
    const mounts = await context.writableMountRoots();
    const worker = await readBootstrapPreparedFile(config.worker, mounts);
    await verifyExecutable(config.recovery.node, mounts);
    const journal = await readBootstrapPreparedFile(config.recovery.journal, mounts);
    await readBootstrapPreparedFile(config.recovery.queue, mounts);
    void journal;
    return { mounts, worker };
  }
  async function assertContainer() {
    const id = await tools.command({
      executable: config.docker,
      args: [
        "--host",
        `unix://${config.socket}`,
        "inspect",
        "--format",
        "{{.Id}}",
        config.containerId,
      ],
    });
    if (id.trim() !== config.containerId)
      throw new Error("Preview monitor immutable container changed");
  }
  async function invoke(operation: "inspect" | "replace", request?: object): Promise<unknown> {
    const { worker } = await protectedTools();
    await assertContainer();
    const output = await tools.command({
      executable: config.docker,
      args: [
        "--host",
        `unix://${config.socket}`,
        "exec",
        "--user",
        "0:0",
        "-i",
        config.containerId,
        "/usr/bin/python3",
        "-I",
        "-c",
        worker.toString("utf8") + `\ncoordinator_main(${JSON.stringify(config.containerId)})\n`,
      ],
      input: JSON.stringify({ operation, ...(request ? { request } : {}) }),
    });
    await assertContainer();
    const reply = JSON.parse(output) as { ok?: boolean; result?: unknown };
    if (reply.ok !== true)
      throw new Error(
        "Preview monitor execution is uncertain; inspect retained receipt. Never replay or roll back automatically.",
      );
    return reply.result;
  }
  async function monitorCompatible(): Promise<boolean> {
    try {
      await protectedTools();
      // Exercise the running reader and the retained executable's actual reader.
      // A marker string alone cannot establish journal compatibility.
      const probe = [compatibilityProbe(context.installationId, config.containerId)];
      const parsed = parseLifecycleJournal(probe);
      const selected = new InstallationRestarts(
        {
          read: () => parsed,
          write: () => {
            throw new Error("Compatibility probe cannot persist");
          },
        },
        {
          restart: async () => {
            throw new Error("Compatibility probe cannot dispatch");
          },
        },
        Date.now,
        {},
        { fenced: true },
      );
      if (selected.listMonitors().length !== 1 || selected.list().length !== 0) return false;
      const program = `const m=await import(${JSON.stringify(config.recovery.journal.path)});const q=await import(${JSON.stringify(config.recovery.queue.path)});const jobs=m.parseLifecycleJournal(JSON.parse(process.argv[1]));const queue=new q.InstallationRestarts({read:()=>jobs,write:()=>{throw Error("probe cannot persist");}},{restart:async()=>{throw Error("probe cannot dispatch");}},Date.now,{}, {fenced:true});if(queue.listMonitors().length!==1||queue.list().length!==0)throw Error("incompatible monitor queue");process.stdout.write("monitor-journal-v1");`;
      const output = await tools.command({
        executable: config.recovery.node.path,
        args: [
          "--input-type=module",
          "-e",
          program,
          JSON.stringify([compatibilityProbe(context.installationId, config.containerId)]),
        ],
      });
      await protectedTools();
      return output === "monitor-journal-v1";
    } catch {
      return false;
    }
  }
  async function validateMonitorPlan(plan: PreviewMonitorPlan) {
    if (!(await monitorCompatible()))
      throw new Error(
        "Selected and recovery coordinator journal readers must support monitor records",
      );
    if (!plan.ancestrySha256)
      throw new Error("Preview monitor requires reviewed directory ancestry");
    const observed = PreviewMonitorSelectionSchema.parse(await invoke("inspect"));
    if (observed.ancestrySha256 !== plan.ancestrySha256)
      throw new Error("Reviewed monitor directory ancestry changed");
    return verifyPreviewMonitorPreparation(plan, {
      installationId: context.installationId,
      containerId: config.containerId,
      containerHome: config.home,
      writableMountRoots: await context.writableMountRoots(),
      observed,
    });
  }
  async function installMonitor(job: PreviewMonitorJob): Promise<string> {
    if (
      job.status !== "running" ||
      job.stage !== "dispatch_pending" ||
      hash(JSON.stringify(job.plan)) !== job.planSha256
    )
      throw new Error("Monitor execution requires exact dispatched request");
    const { candidate, previous } = await validateMonitorPlan(job.plan);
    const receipt = (await invoke("replace", {
      id: job.id,
      revision: job.revision,
      planSha256: job.planSha256,
      containerId: config.containerId,
      destination: job.plan.destination,
      ancestrySha256: job.plan.ancestrySha256,
      beforeSha256: job.plan.expected.sha256,
      candidateSha256: job.plan.candidate.sha256,
      candidateBase64: candidate.toString("base64"),
      previousBase64: previous.toString("base64"),
    })) as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      id: job.id,
      revision: job.revision,
      planSha256: job.planSha256,
      containerId: config.containerId,
      destination: job.plan.destination,
      beforeSha256: job.plan.expected.sha256,
      candidateSha256: job.plan.candidate.sha256,
      displacedSha256: job.plan.expected.sha256,
      displacedPath: `/home/paseo/.local/bin/.paseo-preview.${job.id}.staged`,
      status: "installed",
      phase: "verified",
    }))
      if (receipt?.[key] !== value)
        throw new Error("Monitor installation receipt changed; inspection required");
    // A fresh full-path inspection follows the worker's durable commit/receipt.
    const observed = PreviewMonitorSelectionSchema.parse(await invoke("inspect"));
    if (
      observed.sha256 !== job.plan.candidate.sha256 ||
      observed.ancestrySha256 !== job.plan.ancestrySha256 ||
      observed.uid !== 0 ||
      observed.gid !== 0 ||
      observed.mode !== 0o755
    )
      throw new Error("Selected monitor changed after commit; inspection required");
    return "Preview monitor replaced and verified. Host and Dev agents keep running.";
  }
  return {
    monitorCompatible,
    inspectMonitor: async () => {
      if (!(await monitorCompatible()))
        throw new Error("Monitor journal compatibility unavailable");
      return PreviewMonitorSelectionSchema.parse(await invoke("inspect"));
    },
    validateMonitorPlan: async (plan: PreviewMonitorPlan) => {
      await validateMonitorPlan(plan);
    },
    installMonitor,
  };
}

function compatibilityProbe(installationId: string, containerId: string): PreviewMonitorJob {
  const plan: PreviewMonitorPlan = {
    version: 1,
    operation: "preview-monitor-replace",
    installationId,
    sourceCommit: "a".repeat(40),
    containerId,
    destination: "/home/paseo/.local/bin/paseo-preview",
    candidate: { path: "/protected/candidate", sha256: "b".repeat(64) },
    previous: { path: "/protected/previous", sha256: "c".repeat(64) },
    expected: { sha256: "c".repeat(64), uid: 0, gid: 0, mode: 0o755 },
    ancestrySha256: "d".repeat(64),
  };
  return {
    target: "preview-monitor",
    operation: plan.operation,
    id: "00000000-0000-4000-8000-000000000001",
    revision: "00000000-0000-4000-8000-000000000002",
    requestedBy: "host-agent",
    reason: "Journal compatibility probe",
    createdAt: "2026-10-11T00:00:00.000Z",
    plan,
    planSha256: hash(JSON.stringify(plan)),
    status: "pending",
    stage: "prepared",
    detail: "Compatibility only",
  };
}

/** Executables exceed the protected JSON document bound. Stream their exact bytes. */
async function verifyExecutable(
  file: { path: string; sha256: string },
  mounts: readonly string[],
): Promise<void> {
  await assertBootstrapPathsProtected([file.path], mounts);
  if ((await realpath(file.path)) !== file.path)
    throw new Error("Recovery executable must be canonical");
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const identity = (s: import("node:fs").BigIntStats) =>
    [s.dev, s.ino, s.uid, s.gid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid!()) ||
      (before.mode & 0o022n) !== 0n ||
      (before.mode & 0o100n) === 0n ||
      before.size > 512n * 1024n * 1024n
    )
      throw new Error("Recovery executable requires protected owner and mode");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    if (
      digest.digest("hex") !== file.sha256 ||
      identity(before) !== identity(await handle.stat({ bigint: true })) ||
      identity(before) !== identity(await lstat(file.path, { bigint: true }))
    )
      throw new Error("Recovery executable changed");
  } finally {
    await handle.close();
  }
}
