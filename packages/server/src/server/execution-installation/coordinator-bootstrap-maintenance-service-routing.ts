import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MaintenanceServiceExecutorEvidenceSchema } from "@getpaseo/protocol/maintenance-service";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  createNativeMaintenanceServiceExecutor,
  resolveNativeMaintenanceRoleSetup,
} from "./coordinator-bootstrap-maintenance-service-producer.js";
import { readBoundedMaintenanceInspection } from "./coordinator-bootstrap-maintenance-service-native.js";
import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceExecutor } from "./maintenance/service-execution.js";

type Role = "maintenance-controller" | "recovery-launcher";
interface RouterInput {
  installationId: string;
  stateDirectory: string;
  mode?: "replacement-only" | "linked-controller-recovery";
  launcherReplacement?: "enabled";
  launcherRecovery?: "enabled";
  /** Protected read-only tools, separate from current effect discovery/cache. */
  observeRetained?: (
    request: MaintenanceServiceJob,
    reservation: NonNullable<MaintenanceServiceJob["reservation"]>,
    role: Role,
  ) => ReturnType<MaintenanceServiceExecutor["observe"]>;
}
interface Construction {
  role: Role;
  pending: Promise<MaintenanceServiceExecutor>;
  expired: boolean;
}

/** Role selection supplies tools to the existing queue. It does not select jobs,
 * grant authority, reserve generations or fall back after a native call fails. */
export async function createNativeMaintenanceServiceRouter(
  input: RouterInput,
  construct: (role: Role) => Promise<MaintenanceServiceExecutor> = async (role) => {
    const selected = await resolveNativeMaintenanceRoleSetup({ ...input, target: role });
    return createNativeMaintenanceServiceExecutor({ ...selected, executorTarget: role });
  },
): Promise<MaintenanceServiceExecutor> {
  const recovery = input.mode === "linked-controller-recovery";
  const primary: Role = recovery ? "recovery-launcher" : "maintenance-controller";
  const producers = new Map<Role, MaintenanceServiceExecutor>();
  let construction: Construction | undefined;
  let retryAfter = 0;
  let dispatching = false;
  let reading = false;

  function begin(role: Role): Construction {
    if (construction || dispatching || reading || Date.now() < retryAfter)
      throw new BootstrapRequestConflict("Native service construction is unavailable; defer");
    const expiresAt = performance.now() + 25_000;
    const attempt: Construction = {
      role,
      expired: false,
      pending: Promise.resolve()
        .then(() => construct(role))
        .then((producer) => {
          if (attempt.expired || performance.now() >= expiresAt)
            throw new BootstrapRequestConflict("Native service construction expired; defer");
          producers.set(role, producer);
          return producer;
        })
        .finally(() => {
          if (construction === attempt) construction = undefined;
          if (!producers.has(role)) retryAfter = Date.now() + 5000;
        }),
    };
    construction = attempt;
    return attempt;
  }

  async function acquire(role: Role): Promise<MaintenanceServiceExecutor> {
    if (construction && construction.role !== role)
      throw new BootstrapRequestConflict("Another native service constructor is active; defer");
    const cached = producers.get(role);
    if (cached) return cached;
    const attempt = construction ?? begin(role);
    if (attempt.expired)
      throw new BootstrapRequestConflict("Native service constructor has not settled; defer");
    try {
      return await readBoundedMaintenanceInspection(() => attempt.pending, {
        timeoutMs: 25_000,
        detail: "Native service construction timed out; defer",
      });
    } catch (error) {
      attempt.expired = true;
      throw error;
    }
  }

  // The server owns initial discovery's deadline and keeps this promise in
  // flight until settlement. Returning a timeout here would permit another
  // router to start a duplicate constructor while the first still reads files.
  if (!input.observeRetained) await begin(primary).pending;

  function readNative<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (reading || dispatching || construction)
      throw new BootstrapRequestConflict(
        "Native service reader or dispatch is still active; defer",
      );
    reading = true;
    // A caller deadline cannot abandon an artifact reader. Retain exclusion
    // until the underlying callback settles, and discard its late result.
    return Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return read();
      })
      .finally(() => {
        reading = false;
      });
  }

  function effectRole(request: MaintenanceServiceJob): Role {
    const launcherReplacement =
      input.launcherReplacement === "enabled" &&
      request.target === "recovery-launcher" &&
      request.operation === "replacement";
    const launcherRecovery =
      input.launcherRecovery === "enabled" &&
      recovery &&
      request.target === "recovery-launcher" &&
      request.operation !== "replacement";
    if (request.target !== "maintenance-controller" && !launcherReplacement && !launcherRecovery)
      throw new BootstrapRequestConflict("Launcher maintenance readiness is not accepted");
    if (launcherRecovery) {
      if (!request.proposal.recoveryOf)
        throw new BootstrapRequestConflict("Launcher recovery requires recovery linkage");
      return "maintenance-controller";
    }
    if (request.operation === "replacement") {
      if (request.proposal.recoveryOf)
        throw new BootstrapRequestConflict("Replacement cannot carry recovery linkage");
      return "maintenance-controller";
    }
    if (!recovery || !request.proposal.recoveryOf)
      throw new BootstrapRequestConflict("Linked controller recovery is not enabled");
    return "recovery-launcher";
  }

  return {
    operations: recovery ? ["replacement", "recovery", "rollback"] : ["replacement"],
    inspect: (request) =>
      readBoundedMaintenanceInspection(
        async (signal) => {
          if (dispatching)
            throw new BootstrapRequestConflict("Native service dispatch is still active; defer");
          const role = effectRole(request);
          if (request.reservation && reservedRole(request, true) !== role)
            throw new BootstrapRequestConflict("Reserved executor role differs from inspection");
          const producer = await acquire(role);
          if (construction)
            throw new BootstrapRequestConflict(
              "Native service construction is still active; defer",
            );
          return readNative(signal, () => producer.inspect(request));
        },
        { timeoutMs: 25_000, detail: "Native service inspection timed out; defer" },
      ),
    execute: async (request, reservation) => {
      const role = effectRole(request);
      if (!isDeepStrictEqual(request.reservation, reservation))
        throw new BootstrapRequestConflict("Reserved dispatch generation changed");
      if (reservedRole(request, true) !== role)
        throw new BootstrapRequestConflict("Reserved executor role differs from dispatch");
      const producer = producers.get(role);
      if (!producer || construction || dispatching || reading)
        throw new BootstrapRequestConflict("Reserved native executor is unavailable; observe only");
      // Execution never constructs or substitutes a producer after reservation.
      dispatching = true;
      const dispatched = Promise.resolve()
        .then(() => producer.execute(request, reservation))
        .finally(() => {
          dispatching = false;
        });
      return readBoundedMaintenanceInspection(() => dispatched, {
        timeoutMs: 25_000,
        detail: "Native service dispatch outcome is uncertain; observe only",
      });
    },
    observe: (request, reservation) =>
      readBoundedMaintenanceInspection(
        async (signal) => {
          if (!isDeepStrictEqual(request.reservation, reservation))
            throw new BootstrapRequestConflict("Retained observation generation changed");
          const role = reservedRole(request, false);
          if (input.observeRetained)
            return readNative(signal, () =>
              input.observeRetained!(request, reservation, role ?? primary),
            );
          // Consumed legacy observation keeps its original proof requirements.
          // It may use cached tools, never construct a substitute or gain effects.
          const producer = role ? await acquire(role) : producers.get(primary);
          if (!producer)
            throw new BootstrapRequestConflict("Retained observation tools are unavailable");
          return readNative(signal, () => producer.observe(request, reservation));
        },
        { timeoutMs: 30_000, detail: "Retained native observation timed out; defer" },
      ),
  };
}

function reservedRole(request: MaintenanceServiceJob, effects: boolean): Role | undefined {
  const reservation = request.reservation;
  if (!reservation) throw new BootstrapRequestConflict("Native reservation is missing");
  const matches = request.evidence.filter(
    (entry) => entry.sha256 === reservation.nativeEvidenceSha256,
  );
  if (matches.length > 1)
    throw new BootstrapRequestConflict("Reserved executor evidence is ambiguous");
  const record = matches[0]?.record;
  if (
    record &&
    (createHash("sha256").update(JSON.stringify(record)).digest("hex") !==
      reservation.nativeEvidenceSha256 ||
      record.requestId !== request.id ||
      record.planSha256 !== reservation.planSha256 ||
      record.identitySha256 !== reservation.identitySha256 ||
      record.sourceCommit !== reservation.sourceCommit ||
      record.artifactSha256 !== reservation.artifactSha256)
  )
    throw new BootstrapRequestConflict("Reserved executor evidence changed");
  if (!record?.executor) {
    if (effects || !request.effectIntent)
      throw new BootstrapRequestConflict("Reserved executor proof is unavailable");
    return undefined;
  }
  const executor = MaintenanceServiceExecutorEvidenceSchema.parse(record.executor);
  if (executor.native.bootId !== record.native.bootId)
    throw new BootstrapRequestConflict("Reserved executor boot differs from target evidence");
  return executor.target;
}
