import { ProcessObservationSchema } from "./coordinator-bootstrap-process.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import type {
  CoordinatorBootstrapRequest,
  CoordinatorBootstrapStage,
} from "@getpaseo/protocol/coordinator-bootstrap";
import {
  BootstrapRequestConflict,
  BootstrapCoordinatorBusy,
  CoordinatorBootstrapRequests,
  bootstrapRecoveryRelease,
} from "./coordinator-bootstrap.js";
import {
  loadedCoordinatorPid,
  isStoppedBootstrapCandidate,
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
import {
  restoreBootstrapLauncher,
  selectBootstrapLauncher,
} from "./coordinator-bootstrap-selection.js";
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

function isOriginalBootstrapService(
  request: CoordinatorBootstrapRequest,
  service: string | null,
): boolean {
  return (
    service !== null &&
    !isStoppedBootstrapCandidate(request.plan, service) &&
    loadedCoordinatorPid(request.plan.service, service) === request.plan.expectedProcess.pid
  );
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
    const deadline = performance.now() + 15_000;
    for (;;) {
      try {
        await check();
        return;
      } catch (error) {
        if (performance.now() >= deadline) throw error;
      }
      await setTimeout(50);
    }
  };
  const resumeBusyPrevious = async (
    request: CoordinatorBootstrapRequest,
    roots: readonly string[],
    error: unknown,
  ): Promise<never> => {
    if (!(error instanceof BootstrapCoordinatorBusy)) throw error;
    await readBootstrapPreparedFile(
      {
        path: context.launcherFile,
        sha256: request.plan.previous.launcher.sha256,
      },
      roots,
    );
    await verify(request);
    await verifyState(request, true);
    await requireStage(request, "rollback_pending");
    await command.run(["kill", "SIGCONT", request.plan.service]);
    await waitFor(() => verifyState(request, false));
    // The durable rollback attempt forbids another automatic attempt.
    // Availability lets existing work settle, but is not restart safety.
    throw new BootstrapRequestConflict(
      "The previous coordinator is running, but maintenance remains unresolved. " +
        "A new approved update is required to restore restart-safe operation.",
    );
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
      await waitFor(() =>
        verifyBootstrapReplacement({
          plan: request.plan,
          generation: request.execution!.generation,
          hostUid: uid,
          reader: context.reader,
          readHealth: context.readHealth,
        }),
      );
      await verifyBootstrapReleaseArtifacts(request.plan.candidate, roots);
      await readBootstrapPreparedFile(
        {
          path: context.launcherFile,
          sha256: request.plan.candidate.launcher.sha256,
        },
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
        {
          path: context.launcherFile,
          sha256: request.plan.candidate.launcher.sha256,
        },
        roots,
      );
      await requireStage(request, "start_pending");
      if (JSON.stringify(await context.writableMountRoots()) !== JSON.stringify(roots))
        throw new BootstrapRequestConflict("Writable mounts changed before startup");
      await command.run(["bootstrap", `gui/${uid}`, context.launcherFile]);
    },
    async restorePrevious(request: CoordinatorBootstrapRequest) {
      await requireStage(request, "rollback_pending");
      const roots = await context.writableMountRoots();
      const recovery = bootstrapRecoveryRelease(request.plan);
      await verifyBootstrapReleaseArtifacts(recovery, roots);
      let service: string | null = null;
      try {
        service = await context.reader.readService(request.plan.service);
      } catch {
        await context.reader.verifyServiceAbsent(request.plan.service);
      }
      const originalLoaded = isOriginalBootstrapService(request, service);
      if (request.plan.automaticRecovery !== "restore-compatible" || !originalLoaded)
        await verifyBootstrapState({ request, writableMountRoots: roots });
      if (service !== null && isStoppedBootstrapCandidate(request.plan, service)) {
        await readBootstrapPreparedFile(
          {
            path: context.launcherFile,
            sha256: request.plan.candidate.launcher.sha256,
          },
          roots,
        );
        await requireStage(request, "rollback_pending");
        if (
          !isStoppedBootstrapCandidate(
            request.plan,
            await context.reader.readService(request.plan.service),
          )
        )
          throw new BootstrapRequestConflict("Stopped coordinator started during recovery");
        await command.run(["bootout", request.plan.service]);
        await waitFor(() => context.reader.verifyServiceAbsent(request.plan.service));
        service = null;
      }
      if (service !== null) {
        const pid = loadedCoordinatorPid(request.plan.service, service);
        if (pid === request.plan.expectedProcess.pid) {
          // An interrupted bootout may have left the original writer frozen.
          // Resume only that exact process; never start another writer beside it.
          await verify(request);
          await readBootstrapPreparedFile(
            {
              path: context.launcherFile,
              sha256: request.plan.previous.launcher.sha256,
            },
            roots,
          );
          await requireStage(request, "rollback_pending");
          if (request.plan.automaticRecovery === "restore-compatible") {
            // Promotion makes the old executable unable to restart. Never call
            // resuming it durable recovery. Preserve the same frozen writer fence.
            try {
              await verifyState(request, true);
            } catch {
              await verifyState(request, false);
              await requireStage(request, "rollback_pending");
              await verify(request);
              await command.run(["kill", "SIGSTOP", request.plan.service]);
              await waitFor(() => verifyState(request, true));
            }
            const stopped = await context.reader.inspectStoppedProcess(pid);
            try {
              // Preservation validates the complete journal before classifying busy
              // work. Other failures must never authorize a resume.
              await preserveBootstrapState({
                request,
                writableMountRoots: roots,
                childPids: stopped.childPids,
              });
            } catch (error) {
              await resumeBusyPrevious(request, roots, error);
            }
            await requireStage(request, "rollback_pending");
            await verifyState(request, true);
            await command.run(["bootout", request.plan.service]);
            await waitFor(async () => {
              await context.reader.verifyProcessExited(pid);
              await context.reader.verifyServiceAbsent(request.plan.service);
            });
          } else {
            await command.run(["kill", "SIGCONT", request.plan.service]);
            await waitFor(async () => {
              await verifyState(request, false);
              const health = await context.readHealth();
              if (
                !health ||
                typeof health !== "object" ||
                !("installationId" in health) ||
                health.installationId !== request.plan.installationId
              )
                throw new BootstrapRequestConflict("Resumed coordinator health identity changed");
            });
            await requireStage(request, "rollback_pending");
            return;
          }
        } else {
          const observed = ProcessObservationSchema.parse(await context.reader.inspectProcess(pid));
          const candidate = request.plan.candidate;
          const digest = createHash("sha256")
            .update(
              JSON.stringify([
                candidate.node.path,
                candidate.entrypoint.path,
                candidate.configuration.path,
              ]),
            )
            .digest("hex");
          if (
            observed.uid !== uid ||
            observed.parentPid !== 1 ||
            observed.bootId !== request.plan.expectedProcess.bootId ||
            observed.executable !== candidate.node.path ||
            observed.argumentsSha256 !== digest
          )
            throw new BootstrapRequestConflict("Rollback refuses an unrelated loaded coordinator");
          await requireStage(request, "rollback_pending");
          if (
            !isDeepStrictEqual(observed, await context.reader.inspectProcess(pid)) ||
            loadedCoordinatorPid(
              request.plan.service,
              await context.reader.readService(request.plan.service),
            ) !== pid
          )
            throw new BootstrapRequestConflict("Rollback candidate identity changed");
          await command.run(["bootout", request.plan.service]);
          await waitFor(async () => {
            await context.reader.verifyProcessExited(pid);
            await context.reader.verifyServiceAbsent(request.plan.service);
          });
        }
      }
      await context.reader.verifyProcessExited(request.plan.expectedProcess.pid);
      const authorizeSelection = async () => {
        await requireStage(request, "rollback_pending");
        await context.reader.verifyServiceAbsent(request.plan.service);
        if (JSON.stringify(await context.writableMountRoots()) !== JSON.stringify(roots))
          throw new BootstrapRequestConflict("Writable mounts changed during rollback");
      };
      await restoreBootstrapLauncher({
        plan: request.plan,
        launcherFile: context.launcherFile,
        configurationFile: context.configurationFile,
        writableMountRoots: roots,
        authorizeSelection,
      });
      await verifyBootstrapState({ request, writableMountRoots: roots });
      await authorizeSelection();
      await command.run(["bootstrap", `gui/${uid}`, context.launcherFile]);
      await waitFor(async () => {
        const output = await context.reader.readService(request.plan.service);
        const pid = loadedCoordinatorPid(request.plan.service, output);
        const observed = ProcessObservationSchema.parse(await context.reader.inspectProcess(pid));
        if (observed.bootId !== request.plan.expectedProcess.bootId)
          throw new BootstrapRequestConflict("Host boot changed during recovery");
        verifyBootstrapServiceIdentity({
          plan: {
            ...request.plan,
            previous: recovery,
            expectedProcess: observed,
          },
          launchctlOutput: output,
          process: observed,
          hostUid: uid,
          configurationFile:
            request.plan.automaticRecovery === "restore-compatible"
              ? recovery.configuration.path
              : context.configurationFile,
        });
        const health = await context.readHealth();
        if (
          !health ||
          typeof health !== "object" ||
          !("installationId" in health) ||
          health.installationId !== request.plan.installationId
        )
          throw new BootstrapRequestConflict("Restored coordinator health identity changed");
        if (
          !isDeepStrictEqual(observed, await context.reader.inspectProcess(pid)) ||
          loadedCoordinatorPid(
            request.plan.service,
            await context.reader.readService(request.plan.service),
          ) !== pid
        )
          throw new BootstrapRequestConflict("Restored coordinator changed during readiness");
      });
      await requireStage(request, "rollback_pending");
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
