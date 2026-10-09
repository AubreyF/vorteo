import { isDeepStrictEqual } from "node:util";
import { QuotaObservationSchema } from "@getpaseo/protocol/quota-governor";
import { captureFactoryQuotaPolicy } from "./quota-policy.mjs";

export class FactoryExecutionObservationUncertainError extends Error {
  constructor(cause) {
    super(
      "Factory execution estimate may have persisted; reconcile the same native account before reading again",
      { cause },
    );
    this.name = "FactoryExecutionObservationUncertainError";
    this.writeAttempted = true;
  }
}

/** Execution accounting only. Snapshot readers must use the existing nonmutating cache. */
export function createFactoryObservationReader(input) {
  const { authority, client, authentication, store, quotaPolicy, readRawObservation } = input;
  const originalPolicy = structuredClone(quotaPolicy);
  const policy = captureFactoryQuotaPolicy(quotaPolicy);
  const generation = authentication.authenticationGeneration;
  if (typeof generation !== "string" || !generation)
    throw new Error("Factory execution observation requires captured authentication");
  const ownerCurrent = authority.assertCurrent;
  const clientCurrent = client.assertCurrent;
  const authenticationCurrent = authentication.assertCurrent;
  const observe = store.observeEstimatedUsage;
  let pending;
  let uncertain;

  function assertCaptured() {
    if (
      input.authority !== authority ||
      input.client !== client ||
      input.authentication !== authentication ||
      input.store !== store ||
      input.quotaPolicy !== quotaPolicy ||
      input.readRawObservation !== readRawObservation ||
      authority.assertCurrent !== ownerCurrent ||
      client.assertCurrent !== clientCurrent ||
      authentication.assertCurrent !== authenticationCurrent ||
      store.observeEstimatedUsage !== observe ||
      authentication.authenticationGeneration !== generation ||
      !isDeepStrictEqual(quotaPolicy, originalPolicy)
    )
      throw new Error("Factory execution observation binding changed");
  }
  function assertCurrent() {
    assertCaptured();
    ownerCurrent.call(authority);
    assertCaptured();
    clientCurrent.call(client);
    assertCaptured();
    authenticationCurrent.call(authentication);
    assertCaptured();
  }
  assertCurrent();

  return function readObservation() {
    if (uncertain) return Promise.reject(uncertain);
    assertCurrent();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(async () => {
        assertCurrent();
        const raw = await readRawObservation();
        assertCurrent();
        const observation = QuotaObservationSchema.parse(raw);
        if (observation.status !== "available") return observation;
        if (!isDeepStrictEqual(observation.account, policy.account))
          throw new Error("Factory telemetry account changed");
        const estimate = policy.estimatedHourly;
        assertCurrent();
        try {
          const saved = await observe.call(store, {
            observation,
            authenticationGeneration: generation,
            bucketId: estimate.bucketId,
            windowId: estimate.windowId,
            maxObservationAgeSeconds: policy.maxObservationAgeSeconds,
          });
          assertCurrent();
          const retained = QuotaObservationSchema.parse(saved);
          if (retained.status === "available") {
            const measurement = retained.estimatedHourlyUsage;
            if (
              !isDeepStrictEqual(retained.account, policy.account) ||
              !measurement ||
              measurement.authenticationGeneration !== generation ||
              measurement.bucketId !== estimate.bucketId ||
              measurement.windowId !== estimate.windowId ||
              measurement.observedAt !== observation.observedAt ||
              retained.observedAt !== observation.observedAt
            )
              throw new Error("Factory native estimate binding changed");
          }
          assertCurrent();
          return retained;
        } catch (error) {
          uncertain = new FactoryExecutionObservationUncertainError(error);
          throw uncertain;
        }
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
