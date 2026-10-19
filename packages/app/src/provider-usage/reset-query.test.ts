import { expect, test } from "vitest";
import { resetProviderIds, providerResetQueryOptions } from "./reset-query";
import { resetPresentation } from "./reset-state";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";

test("loads each configured account's credits when shared profiles use the disabled family provider", async () => {
  const accounts = ["codex-primary", "codex-secondary", "codex-third"];
  const providers = resetProviderIds([
    { provider: "codex", enabled: false },
    ...accounts.map((provider) => ({ provider, enabled: true })),
  ]);
  expect(providers).toEqual(accounts);
  const reads: string[] = [];
  for (const providerId of providers) {
    const options = providerResetQueryOptions({
      serverId: "dev",
      providerId,
      clientGeneration: 1,
      enabled: true,
      poll: true,
      client: {
        async readProviderReset(id) {
          reads.push(id);
          const view: ProviderResetView = {
            providerId: id,
            fetchedAt: new Date().toISOString(),
            snapshot: {
              status: "available",
              accountId: id,
              accountLabel: null,
              availableCount: 1,
              credits: null,
            },
            canRedeem: true,
            operation: null,
          };
          return { requestId: id, view };
        },
      },
    });
    expect(options.queryKey).toEqual(["providerReset", "dev", providerId, 1]);
    const current = await options.queryFn();
    expect(
      resetPresentation({
        supported: true,
        connected: true,
        open: false,
        current,
        positiveOnly: true,
      }),
    ).toMatchObject({ visible: true, showBadge: true, badge: "1 reset" });
  }
  expect(reads).toEqual(accounts);
});

test("waits for the account catalog and excludes disabled accounts", () => {
  expect(resetProviderIds(undefined)).toEqual([]);
  expect(resetProviderIds([{ provider: "codex-primary", enabled: false }])).toEqual([]);
});
