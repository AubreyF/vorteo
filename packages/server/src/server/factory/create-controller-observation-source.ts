import { isDeepStrictEqual } from "node:util";
import { parseQuotaGovernorPolicy } from "@getpaseo/protocol/quota-governor";
import {
  AccountingContractSchema,
  satisfiesAccountingContract,
} from "../agent/quota-reserve/governor-accounting-contract.js";
import { combineQuotaPolicies } from "../agent/quota-reserve/governor-policy.js";
import type { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import type { FactoryControllerObservationSource } from "./controller-observation-provider.js";

/** Capture the existing account contract without configuring it or sampling usage. */
export async function createFactoryControllerObservationSource(input: {
  source: FactoryControllerObservationSource;
  store: Pick<QuotaGovernorStore, "accountingContract">;
}): Promise<FactoryControllerObservationSource> {
  const { source, store } = input;
  const captured = { ...source };
  const configuredPolicy = parseQuotaGovernorPolicy(structuredClone(source.policy));
  const readContract = store.accountingContract;

  function assertCurrent(): void {
    captured.authority.assertCurrent();
    captured.authentication.assertCurrent();
    const sourceChanged = (
      Object.keys(captured) as Array<keyof FactoryControllerObservationSource>
    ).some((key) => source[key] !== captured[key]);
    if (
      sourceChanged ||
      !isDeepStrictEqual(source.policy, configuredPolicy) ||
      store.accountingContract !== readContract
    )
      throw new Error("Factory startup observation source or account reader changed.");
  }

  assertCurrent();
  const current = await readContract.call(store, configuredPolicy.account);
  assertCurrent();
  if (current === null)
    throw new Error("Factory observation requires a current native account contract.");
  const contract = AccountingContractSchema.parse(structuredClone(current));
  if (!satisfiesAccountingContract(contract, configuredPolicy))
    throw new Error("Factory observation policy differs from the native account contract.");
  const policy = contract.envelope
    ? combineQuotaPolicies(contract.envelope, configuredPolicy)
    : configuredPolicy;

  async function assertContract(): Promise<void> {
    assertCurrent();
    const latest = await readContract.call(store, configuredPolicy.account);
    assertCurrent();
    if (!isDeepStrictEqual(latest, contract))
      throw new Error(
        "Factory native account contract changed; observation requires reconciliation.",
      );
  }

  return {
    ...captured,
    authority: { identity: captured.authority.identity, assertCurrent },
    policy,
    async readLifecycle() {
      await assertContract();
      const lifecycle = await captured.readLifecycle();
      await assertContract();
      return lifecycle;
    },
    async readAccountObservation() {
      await assertContract();
      const observation = await captured.readAccountObservation();
      await assertContract();
      return observation;
    },
  };
}
