import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, CoordinatorBootstrapRequests } from "./coordinator-bootstrap.js";
import {
  verifyLoadedBootstrapService,
  verifyBootstrapReplacement,
  verifyBootstrapServiceIdentity,
  type NativeBootstrapServiceReader,
} from "./coordinator-bootstrap-service.js";

import {
  inspectBootstrapState,
  preserveBootstrapState,
  verifyBootstrapState,
} from "./coordinator-bootstrap-state.js";
import { selectBootstrapLauncher } from "./coordinator-bootstrap-selection.js";
import {
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";

const execute = promisify(execFile);

export interface BootstrapNativeCommand {
  run(args: readonly string[]): Promise<void>;
}
const nativeCommand: BootstrapNativeCommand = {
  async run(args) {
    await execute("/bin/launchctl", [...args], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10_000,
      maxBuffer: 8192,
    });
  },
};

interface NativeLifecycleContext {
  requests: CoordinatorBootstrapRequests;
  reader: NativeBootstrapServiceReader;
  configurationFile: string;
  launcherFile: string;
  readHealth(): Promise<unknown>;
  writableMountRoots(): Promise<readonly string[]>;
  /** Must verify the inherited native ownership lock before each operation. */
  requireOwnership(): Promise<void>;
}

/** Called only by the tracked executor or its generation-bound watchdog. The
 * command capability is supplied by trusted Host setup, never by a request. */
export function createBootstrapNativeLifecycle(
  context: NativeLifecycleContext,
  command: BootstrapNativeCommand = nativeCommand,
) {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid === undefined)
    throw new BootstrapRequestConflict("Native Host lifecycle control required");
  const requireStage = async (
    request: CoordinatorBootstrapRequest,
    stage: CoordinatorBootstrapStage,
  ) => {
    await context.requireOwnership();
    const current = context.requests.list().find((item) => item.id === request.id);
    if (
      !request.execution ||
      !current?.execution ||
      current.status !== "approved" ||
      current.revision !== request.revision ||
      current.planSha256 !== request.planSha256 ||
      current.execution.generation !== request.execution.generation ||
      current.execution.stage !== stage
    )
      throw new BootstrapRequestConflict(
        "Native bootstrap operation lost exact dispatch ownership",
      );
  };
  const verify = (request: CoordinatorBootstrapRequest) =>
    verifyLoadedBootstrapService({
      plan: request.plan,
      hostUid: uid,
      configurationFile: context.configurationFile,
      reader: context.reader,
    });
  const waitFor = async (check: () => Promise<void>) => {
    // This bounded observer belongs to a visible claimed lifecycle request.
    // A timeout is failure, never proof of exit and never a reason to retry a signal.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await check();
        return;
      } catch (error) {
        if (attempt === 39) throw error;
      }
      await setTimeout(50);
    }
  };
  const verifyState = async (request: CoordinatorBootstrapRequest, stopped: boolean) => {
    const observation = stopped
      ? await context.reader.inspectStoppedProcess(request.plan.expectedProcess.pid)
      : await context.reader.inspectRunningProcess(request.plan.expectedProcess.pid);
    const { stopped: _state, ...identity } = observation;
    const { childPids: _children, ...processIdentity } =
      "childPids" in identity ? identity : { ...identity, childPids: undefined };
    verifyBootstrapServiceIdentity({
      plan: request.plan,
      hostUid: uid,
      configurationFile: context.configurationFile,
      launchctlOutput: await context.reader.readService(request.plan.service),
      process: processIdentity,
    });
  };
  return {
    async inspectFrozen(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "freeze_pending");
      await verifyState(request, true);
      const stopped = await context.reader.inspectStoppedProcess(request.plan.expectedProcess.pid);
      const restartJournal = await inspectBootstrapState({
        request,
        writableMountRoots: await context.writableMountRoots(),
      });
      await verifyState(request, true);
      return { restartJournal, childPids: stopped.childPids };
    },
    async preserveTransfer(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "frozen");
      await verifyState(request, true);
      const stopped = await context.reader.inspectStoppedProcess(request.plan.expectedProcess.pid);
      await preserveBootstrapState({
        request,
        writableMountRoots: await context.writableMountRoots(),
        childPids: stopped.childPids,
      });
      await requireStage(request, "frozen");
      await verifyState(request, true);
    },
    async verifyReplacement(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "verifying");
      const roots = await context.writableMountRoots();
      await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
      await verifyBootstrapReplacement({
        plan: request.plan,
        generation: request.execution!.generation,
        hostUid: uid,
        reader: context.reader,
        readHealth: context.readHealth,
      });
      await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
      await readBootstrapPreparedFile(
        { path: context.launcherFile, sha256: request.plan.candidate.launcher.sha256 },
        roots,
      );
      await verifyBootstrapState({ request, writableMountRoots: roots });
      await requireStage(request, "verifying");
      if (JSON.stringify(await context.writableMountRoots()) !== JSON.stringify(roots))
        throw new BootstrapRequestConflict("Writable mounts changed during readiness verification");
    },
    async select(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "selection_pending");
      await context.reader.verifyProcessExited(request.plan.expectedProcess.pid);
      await context.reader.verifyServiceAbsent(request.plan.service);
      const roots = await context.writableMountRoots();
      await selectBootstrapLauncher({
        plan: request.plan,
        launcherFile: context.launcherFile,
        configurationFile: context.configurationFile,
        writableMountRoots: roots,
        authorizeSelection: async () => {
          await requireStage(request, "selection_pending");
          if (JSON.stringify(await context.writableMountRoots()) !== JSON.stringify(roots))
            throw new BootstrapRequestConflict("Writable mounts changed before selection");
          await context.reader.verifyProcessExited(request.plan.expectedProcess.pid);
          await context.reader.verifyServiceAbsent(request.plan.service);
        },
      });
    },
    async start(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "start_pending");
      await context.reader.verifyProcessExited(request.plan.expectedProcess.pid);
      await context.reader.verifyServiceAbsent(request.plan.service);
      const roots = await context.writableMountRoots();
      await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
      await readBootstrapPreparedFile(
        { path: context.launcherFile, sha256: request.plan.candidate.launcher.sha256 },
        roots,
      );
      await requireStage(request, "start_pending");
      if (JSON.stringify(await context.writableMountRoots()) !== JSON.stringify(roots))
        throw new BootstrapRequestConflict("Writable mounts changed before startup");
      await command.run(["bootstrap", `gui/${uid}`, context.launcherFile]);
    },
    async freeze(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "freeze_pending");
      await verify(request);
      await requireStage(request, "freeze_pending");
      await command.run(["kill", "SIGSTOP", request.plan.service]);
      await waitFor(() => verifyState(request, true));
    },
    async resumePrevious(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "resume_pending");
      await verify(request);
      await requireStage(request, "resume_pending");
      await command.run(["kill", "SIGCONT", request.plan.service]);
      await waitFor(() => verifyState(request, false));
    },
    async unload(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "unload_pending");
      await verify(request);
      const stopped = await context.reader.inspectStoppedProcess(request.plan.expectedProcess.pid);
      if (stopped.childPids.length)
        throw new BootstrapRequestConflict("Coordinator still has preparation children");
      await verifyBootstrapState({
        request,
        writableMountRoots: await context.writableMountRoots(),
      });
      await requireStage(request, "unload_pending");
      await command.run(["bootout", request.plan.service]);
      await waitFor(async () => {
        await context.reader.verifyProcessExited(request.plan.expectedProcess.pid);
        await context.reader.verifyServiceAbsent(request.plan.service);
      });
    },
  };
}
