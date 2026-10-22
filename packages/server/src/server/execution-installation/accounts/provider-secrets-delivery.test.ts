import { expect, test } from "vitest";
import {
  ProviderSecretsDeliveryService,
  providerSecretsDeliveryDigest,
  type ProviderSecretsJournal,
} from "./provider-secrets-delivery.js";

const KEY = `sk-synthetic-${"a".repeat(32)}`;
const OTHER = `sk-synthetic-${"b".repeat(32)}`;
const delivery = {
  installationId: "11111111-1111-4111-8111-111111111111",
  serverId: "dev",
  definitionId: "openai",
  providerId: "openai-local",
  revision: 1,
  policyRevision: 5,
  values: { OPENAI_API_KEY: KEY },
  overwrite: [] as string[],
};

function fixture(env: Record<string, string> | null = { OPENAI_BASE_URL: "https://local" }) {
  const state: {
    journal: ProviderSecretsJournal | null;
    env: Record<string, string> | null;
    authorized: boolean;
    writes: number;
  } = { journal: null, env, authorized: true, writes: 0 };
  const ports = {
    read: () => state.journal,
    persist: (journal: ProviderSecretsJournal) => {
      state.journal = journal;
    },
    readEnv: () => (state.env ? { ...state.env } : null),
    writeEnv: (next: Record<string, string>) => {
      state.writes += 1;
      state.env = next;
    },
    authorize: async () => {
      if (!state.authorized) throw Error("excluded");
    },
  };
  return { state, service: new ProviderSecretsDeliveryService(ports) };
}

test("writes values beside local env and journals digests only", async () => {
  const f = fixture();
  const receipt = await f.service.apply(delivery);
  expect(receipt).toMatchObject({ phase: "applied", conflicts: [], revision: 1 });
  expect(receipt.digest).toBe(providerSecretsDeliveryDigest(delivery));
  expect(f.state.env).toEqual({ OPENAI_BASE_URL: "https://local", OPENAI_API_KEY: KEY });
  expect(JSON.stringify(f.state.journal)).not.toContain(KEY);
  expect(JSON.stringify(receipt)).not.toContain(KEY);
  // Identical retries are idempotent and do not rewrite configuration.
  await f.service.apply(delivery);
  expect(f.state.writes).toBe(1);
});

test("withdraws only names it delivered and leaves locally changed values", async () => {
  const f = fixture();
  await f.service.apply({
    ...delivery,
    values: { OPENAI_API_KEY: KEY, OTHER_TOKEN: OTHER },
  });
  f.state.env!.OTHER_TOKEN = "changed-locally-value";
  await f.service.apply({ ...delivery, revision: 2, values: {} });
  expect(f.state.env).toEqual({
    OPENAI_BASE_URL: "https://local",
    OTHER_TOKEN: "changed-locally-value",
  });
});

test("never silently replaces a differing local value unless the owner set it", async () => {
  const f = fixture({ OPENAI_API_KEY: OTHER });
  const imported = await f.service.apply(delivery);
  expect(imported.conflicts).toEqual(["OPENAI_API_KEY"]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: OTHER });
  const owned = await f.service.apply({ ...delivery, revision: 2, overwrite: ["OPENAI_API_KEY"] });
  expect(owned.conflicts).toEqual([]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: KEY });
  // Once delivered, later canonical changes replace the delivered value without a conflict.
  const rotated = await f.service.apply({
    ...delivery,
    revision: 3,
    values: { OPENAI_API_KEY: OTHER },
  });
  expect(rotated.conflicts).toEqual([]);
  expect(f.state.env).toEqual({ OPENAI_API_KEY: OTHER });
});

test("rejects stale generations, unauthorized values and missing bindings", async () => {
  const f = fixture();
  await f.service.apply({ ...delivery, revision: 3 });
  await expect(f.service.apply(delivery)).rejects.toThrow("synchronization is pending");
  f.state.authorized = false;
  await expect(f.service.apply({ ...delivery, revision: 4 })).rejects.toThrow();
  const missing = fixture(null);
  await expect(missing.service.apply(delivery)).rejects.toThrow();
  // Withdrawal from a binding that no longer exists succeeds without writing.
  await expect(missing.service.apply({ ...delivery, values: {} })).resolves.toMatchObject({
    phase: "applied",
  });
  expect(missing.state.writes).toBe(0);
});

test("refuses names that are not secrets", async () => {
  const f = fixture();
  await expect(
    f.service.apply({ ...delivery, values: { CODEX_HOME: "/elsewhere" } }),
  ).rejects.toThrow();
  expect(f.state.writes).toBe(0);
});
