import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { CapturedQuotaExecutionClient } from "../agent/agent-sdk-types.js";
import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import type { QuotaScheduleExecution } from "./quota-preflight.js";
import { isAbsolute } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { NativeFactoryObservationProvider } from "../factory/observation-service.js";
import type { attachFactoryControllerObservation } from "../factory/attach-controller-observation.js";
import type { createFactoryControllerObservationSource } from "../factory/create-controller-observation-source.js";
import type { createNativeFactoryInstallStartup } from "../factory/native-install-startup.js";
import type { NativeFactoryInstallAdapter } from "../factory/native-install-adapter.js";

import type { createFactoryCoordinatorBinder } from "../factory/create-coordinator-binder.js";

export interface GovernedScheduleRuntimeContext {
  hostId: string;
  paseoHome: string;
  store: QuotaGovernorStore;
  readObservation(providerId: string): Promise<QuotaObservation>;
  captureClient(providerId: string): CapturedQuotaExecutionClient;
  /** Explicit adoption operation, never invoked merely by loading a runtime. */
  factoryCoordinators?: { bind: ReturnType<typeof createFactoryCoordinatorBinder> };
  /** Optional native startup APIs. Never passed to workers or through plugin RPC. */
  factoryObservation?: {
    createSource: typeof createFactoryControllerObservationSource;
    attach: typeof attachFactoryControllerObservation;
  };
  /** Constructor only. Caller supplies the same retained owner and explicit reconciliation permit. */
  factoryInstallation?: { create: ReturnType<typeof createNativeFactoryInstallStartup> };
}

/** Trusted host integration only. No runtime factory or callback enters worker RPC configuration. */
export interface GovernedScheduleRuntime extends QuotaScheduleExecution {
  /** Optional read-only projection from this same retained controller owner. */
  factoryObservation?: NativeFactoryObservationProvider;
  /** Native adapter from this runtime's startup context; never created by plugin reload or RPC. */
  factoryInstallation?: NativeFactoryInstallAdapter;
  /** Bind authentication and persist estimated accounting before preflight admission. */
  readObservation(providerId: string): Promise<QuotaObservation>;
  /** Revoke synchronously, then settle captured work or reject with retained recovery custody. */
  stop(): Promise<void>;
}

export type CreateGovernedScheduleRuntime = (
  context: GovernedScheduleRuntimeContext,
) => Promise<GovernedScheduleRuntime>;

function isFactory(value: unknown): value is CreateGovernedScheduleRuntime {
  return typeof value === "function";
}

function isRuntime(value: unknown): value is GovernedScheduleRuntime {
  if (typeof value !== "object" || value === null) return false;
  return ["reconcile", "reconcilePreparation", "prepare", "readObservation", "stop"].every(
    (name) => typeof Reflect.get(value, name) === "function",
  );
}

/** Startup-only host code, loaded by the supervised daemon worker, never by a schedule. */
export async function loadGovernedScheduleRuntimeFactory(
  modulePath: string | undefined,
): Promise<CreateGovernedScheduleRuntime | undefined> {
  if (modulePath === undefined) return undefined;
  if (!isAbsolute(modulePath) || !modulePath.endsWith(".mjs")) {
    throw new Error("Governed runtime requires an absolute installed .mjs module path.");
  }
  const owner = process.getuid?.();
  const info = await lstat(modulePath);
  if (
    owner === undefined ||
    !info.isFile() ||
    info.uid !== owner ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(modulePath)) !== modulePath
  ) {
    throw new Error("Governed runtime requires an owner-controlled physical module.");
  }
  // This is trusted daemon code, not a sandbox or a package-signature check.
  // Its entire installation, dependencies and parents must be outside worker writes.
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  const factory =
    typeof loaded === "object" && loaded !== null
      ? Reflect.get(loaded, "createGovernedScheduleRuntime")
      : undefined;
  if (!isFactory(factory)) throw new Error("Governed runtime factory export is missing.");
  return async (context) => {
    const runtime: unknown = await factory(context);
    if (!isRuntime(runtime)) throw new Error("Governed runtime lifecycle contract is incomplete.");
    return runtime;
  };
}
