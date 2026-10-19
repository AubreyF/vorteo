import type { GovernedScheduleRuntime } from "../schedule/governed-runtime.js";
import type { NativeFactoryObservationProvider } from "./observation-service.js";
import {
  FactoryControllerObservationProvider,
  type FactoryControllerObservationSource,
} from "./controller-observation-provider.js";

interface Attachment {
  source: FactoryControllerObservationSource;
  observation: NativeFactoryObservationProvider;
}

const attachments = new WeakMap<GovernedScheduleRuntime, Attachment>();

/** Called once by the retained startup owner after its final shutdown wrapper is installed. */
export function attachFactoryControllerObservation(input: {
  runtime: GovernedScheduleRuntime;
  source: FactoryControllerObservationSource;
}): NativeFactoryObservationProvider {
  const { runtime, source } = input;
  const existing = attachments.get(runtime);
  if (existing) {
    if (existing.source !== source) throw new Error("Factory observation source already attached.");
    existing.observation.assertCurrent();
    return existing.observation;
  }
  const stopDescriptor = Object.getOwnPropertyDescriptor(runtime, "stop");
  const hasObservation = "factoryObservation" in runtime;
  const stopIsWritable = stopDescriptor?.writable === true && "value" in stopDescriptor;
  if (!Object.isExtensible(runtime) || hasObservation || !stopIsWritable)
    throw new Error(
      "Factory observation requires an unattached runtime with its final stop method.",
    );

  const retained = new FactoryControllerObservationProvider(source);
  const originalStop = runtime.stop;
  let revoked = false;

  function assertCurrent(): void {
    if (revoked || runtime.stop !== stop || runtime.factoryObservation !== observation)
      throw new Error("Factory observation runtime stopped or lifecycle replaced.");
    retained.assertCurrent();
  }

  // Revocation is synchronous. Failed settlement leaves observation revoked and
  // preserves the original stop method's error and subsequent retry behavior.
  function stop(): Promise<void> {
    revoked = true;
    return originalStop.call(runtime);
  }

  const observation = Object.freeze<NativeFactoryObservationProvider>({
    binding: retained.binding,
    assertCurrent,
    async snapshot(request) {
      assertCurrent();
      const value = await retained.snapshot(request);
      assertCurrent();
      return value;
    },
    async receipts(request) {
      assertCurrent();
      const value = await retained.receipts(request);
      assertCurrent();
      return value;
    },
  });
  Object.defineProperties(runtime, {
    stop: { ...stopDescriptor, value: stop },
    factoryObservation: {
      value: observation,
      enumerable: true,
      writable: false,
      configurable: false,
    },
  });
  attachments.set(runtime, { source, observation });
  observation.assertCurrent();
  return observation;
}
