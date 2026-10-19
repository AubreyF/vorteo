import { expect, test } from "vitest";
import { groupInstallationProviders } from "./shared-providers-model";

test("groups duplicate environment runtimes but preserves distinct accounts even with matching names", () => {
  const family = groupInstallationProviders([
    {
      id: "host/default",
      providerType: "codex",
      bindings: { host: "codex" },
      policy: { enabled: true },
    },
    {
      id: "dev/default",
      providerType: "codex",
      bindings: { dev: "codex" },
      policy: { enabled: false },
    },
    {
      id: "account/one",
      providerType: "codex",
      accountId: "one",
      bindings: { host: "first", dev: "second" },
      policy: { label: "Same name" },
    },
    {
      id: "account/two",
      providerType: "codex",
      accountId: "two",
      bindings: { host: "third" },
      policy: { label: "Same name" },
    },
    { id: "retired", providerType: "other", bindings: {}, policy: {}, removed: true },
  ]);
  expect(family).toHaveLength(1);
  expect(family[0].accounts.map((entry) => entry.id)).toEqual([
    "default/codex",
    "account/one",
    "account/two",
  ]);
  expect(family[0].accounts[0].definitions.map((entry) => entry.id)).toEqual([
    "host/default",
    "dev/default",
  ]);
  expect(family[0].enabled).toBe(true);
});
