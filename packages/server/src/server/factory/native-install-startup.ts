import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import type { GovernedScheduleRuntime } from "../schedule/governed-runtime.js";
import { createFactoryControllerObservationSource } from "./create-controller-observation-source.js";
import {
  createNativeFactoryInstallAdapter,
  nativeFactoryInstallAdapterOrigin,
  type NativeFactoryInstallAdapter,
} from "./native-install-adapter.js";

type InstallDependencies = Parameters<typeof createNativeFactoryInstallAdapter>[0];
export type FactoryInstallStartupOptions = Pick<
  InstallDependencies,
  "runtime" | "source" | "provider" | "profileId" | "assertReconciled" | "controls"
>;
interface StartupDependencies extends Omit<
  InstallDependencies,
  keyof FactoryInstallStartupOptions
> {
  store: Pick<QuotaGovernorStore, "accountingContract">;
  canDispatch(): boolean;
}
const startupAdapters = new WeakSet<NativeFactoryInstallAdapter>();

export function isNativeFactoryStartupAdapter(adapter: NativeFactoryInstallAdapter): boolean {
  return startupAdapters.has(adapter) && nativeFactoryInstallAdapterOrigin(adapter) !== null;
}

export class FactoryInstallStartupChangedError extends Error {
  constructor() {
    super("Factory installation startup owner or dispatch boundary changed.");
    this.name = "FactoryInstallStartupChangedError";
  }
}

/** Construct against existing native state. Does not attach, bind, configure or start anything. */
export function createNativeFactoryInstallStartup(deps: StartupDependencies) {
  const captured = { ...deps };
  return async (options: FactoryInstallStartupOptions): Promise<NativeFactoryInstallAdapter> => {
    const owner: FactoryInstallStartupOptions = {
      runtime: options.runtime,
      source: options.source,
      provider: options.provider,
      profileId: options.profileId,
      assertReconciled: options.assertReconciled,
      controls: options.controls,
    };
    const source = await createFactoryControllerObservationSource({
      source: owner.source,
      store: captured.store,
    });
    let adapter: NativeFactoryInstallAdapter;
    function assertReconciled(): void {
      owner.assertReconciled();
      const changedDependencies = (Object.keys(captured) as Array<keyof StartupDependencies>).some(
        (key) => deps[key] !== captured[key],
      );
      const changedOwner = (Object.keys(owner) as Array<keyof FactoryInstallStartupOptions>).some(
        (key) => options[key] !== owner[key],
      );
      if (
        changedDependencies ||
        changedOwner ||
        !captured.canDispatch() ||
        owner.runtime.factoryInstallation !== adapter
      )
        throw new FactoryInstallStartupChangedError();
    }
    adapter = createNativeFactoryInstallAdapter({
      ...captured,
      ...owner,
      source,
      assertReconciled,
    });
    startupAdapters.add(adapter);
    return adapter;
  };
}

export interface NativeFactoryInstaller {
  projectId: string;
  adapter: NativeFactoryInstallAdapter;
}

/** Capture once after the retained runtime returns. Reload cannot substitute another installer. */
export function createNativeFactoryInstallerResolver(
  runtime: GovernedScheduleRuntime | undefined,
  serverId: string,
  canDispatch: () => boolean,
): () => NativeFactoryInstaller | null {
  const adapter = runtime?.factoryInstallation;
  const origin = adapter && nativeFactoryInstallAdapterOrigin(adapter);
  if (
    !runtime ||
    !adapter ||
    !isNativeFactoryStartupAdapter(adapter) ||
    !origin ||
    origin.runtime !== runtime ||
    origin.serverId !== serverId
  )
    return () => null;
  const installer = Object.freeze({ projectId: origin.projectId, adapter });
  return () => {
    const current = nativeFactoryInstallAdapterOrigin(adapter);
    if (
      runtime.factoryInstallation !== adapter ||
      !current ||
      current.runtime !== runtime ||
      current.serverId !== serverId ||
      current.projectId !== origin.projectId
    )
      throw new FactoryInstallStartupChangedError();
    return canDispatch() ? installer : null;
  };
}
