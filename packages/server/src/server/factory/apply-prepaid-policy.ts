import { isDeepStrictEqual } from "node:util";
import {
  parseQuotaGovernorPolicy,
  type QuotaGovernorPolicy,
  type QuotaObservation,
} from "@getpaseo/protocol/quota-governor";
import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";

interface ApplicationInput {
  store: Pick<QuotaGovernorStore, "accountingContract" | "configureAccountPolicy">;
  policy: QuotaGovernorPolicy;
  authorization: NonNullable<QuotaGovernorPolicy["prepaidAuthorization"]>;
  assertCurrent(): void;
  assertReconciled(): Promise<void>;
  readObservation(): Promise<QuotaObservation>;
  nowMs(): number;
}

interface ApplicationRequest {
  operationId: string;
  expectedRevision: string;
}

export class FactoryPrepaidApplicationError extends Error {
  constructor(
    readonly operationId: string,
    readonly state: "refused" | "uncertain",
    cause: unknown,
  ) {
    super(`Factory prepaid policy ${state}; retain operation ${operationId}.`, { cause });
    this.name = "FactoryPrepaidApplicationError";
  }
}

/** Trusted owner only. The injected grant is never supplied by a child schedule or RPC. */
export function createFactoryPrepaidPolicyApplication(input: ApplicationInput) {
  const captured = { ...input };
  const policy = parseQuotaGovernorPolicy(structuredClone(input.policy));
  const authorization = structuredClone(input.authorization);
  const candidate = parseQuotaGovernorPolicy({ ...policy, prepaidAuthorization: authorization });
  const readContract = captured.store.accountingContract;
  const configure = captured.store.configureAccountPolicy;
  let active = false;
  let retained: ApplicationRequest | null = null;
  const assertSource = () => {
    if (
      input.store !== captured.store ||
      input.assertCurrent !== captured.assertCurrent ||
      input.assertReconciled !== captured.assertReconciled ||
      input.readObservation !== captured.readObservation ||
      input.nowMs !== captured.nowMs ||
      captured.store.accountingContract !== readContract ||
      captured.store.configureAccountPolicy !== configure ||
      !isDeepStrictEqual(input.policy, policy) ||
      !isDeepStrictEqual(input.authorization, authorization)
    )
      throw new Error("Factory account policy source changed.");
  };
  const guard = () => {
    captured.assertCurrent();
    assertSource();
    const now = captured.nowMs();
    captured.assertCurrent();
    assertSource();
    if (
      !Number.isFinite(now) ||
      now < Date.parse(authorization.startsAt) ||
      now >= Date.parse(authorization.expiresAt)
    )
      throw new Error("Factory prepaid owner authorization is inactive.");
  };
  guard();
  return async (request: ApplicationRequest) => {
    const invocation = { ...request };
    if (
      typeof invocation.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        invocation.operationId,
      ) ||
      typeof invocation.expectedRevision !== "string" ||
      !invocation.expectedRevision
    )
      throw new FactoryPrepaidApplicationError(
        invocation.operationId,
        "refused",
        new Error("Invalid account policy invocation."),
      );
    if (retained)
      throw new FactoryPrepaidApplicationError(
        retained.operationId,
        "uncertain",
        new Error("Reconcile the retained account policy invocation before another dispatch."),
      );
    if (active)
      throw new FactoryPrepaidApplicationError(
        invocation.operationId,
        "refused",
        new Error("Account policy application is already running."),
      );
    let dispatched = false;
    active = true;
    try {
      guard();
      await captured.assertReconciled();
      guard();
      const current = await readContract.call(captured.store, policy.account);
      guard();
      if (!current || current.revision !== invocation.expectedRevision)
        throw new Error("Factory account contract changed or is unavailable.");
      if (current.envelope && !isDeepStrictEqual(current.envelope, policy))
        throw new Error("Factory parent policy differs; reload its exact envelope.");
      const readObservation = async () => {
        guard();
        const observation = structuredClone(await captured.readObservation());
        guard();
        return observation;
      };
      guard();
      dispatched = true;
      const result = await configure.call(captured.store, {
        policy: structuredClone(candidate),
        expectedRevision: invocation.expectedRevision,
        readObservation,
      });
      guard();
      if (result.kind === "deferred") {
        const held = {
          kind: "held" as const,
          operationId: invocation.operationId,
          reason: result.reason,
        };
        guard();
        return held;
      }
      const persisted = await readContract.call(captured.store, policy.account);
      guard();
      if (
        !isDeepStrictEqual(persisted, result.contract) ||
        !isDeepStrictEqual(result.contract.envelope, candidate)
      )
        throw new Error("Factory account policy result differs from native persisted state.");
      const applied = {
        kind: "applied" as const,
        operationId: invocation.operationId,
        contract: structuredClone(result.contract),
      };
      guard();
      return applied;
    } catch (cause) {
      if (dispatched) retained = invocation;
      throw new FactoryPrepaidApplicationError(
        invocation.operationId,
        dispatched ? "uncertain" : "refused",
        cause,
      );
    } finally {
      active = false;
    }
  };
}
