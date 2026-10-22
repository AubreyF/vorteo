import { expect, test } from "vitest";
import {
  ProviderSecretsAuthority,
  ProviderSecretsUnsupportedError,
  type ProviderSecretsPolicy,
  type ProviderSecretsState,
} from "./provider-secrets-authority.js";
import {
  providerSecretsDeliveryDigest,
  type ProviderSecretsDelivery,
} from "./provider-secrets-delivery.js";

const KEY = `sk-synthetic-${"a".repeat(32)}`;
const OTHER = `sk-synthetic-${"b".repeat(32)}`;
const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const LABELS: Record<string, { kind: "host" | "container"; label: string }> = {
  host: { kind: "host", label: "Host" },
  dev: { kind: "container", label: "Dev container" },
};

function fixture(
  environments: Record<string, Record<string, Record<string, string> | undefined>> = {
    host: { openai: { OPENAI_API_KEY: KEY, OPENAI_BASE_URL: "https://local" } },
    dev: { openai: {} },
  },
) {
  const state = {
    persisted: [] as ProviderSecretsState,
    policy: {
      revision: 1,
      removed: false,
      targets: [
        { serverId: "host", providerId: "openai", excluded: false },
        { serverId: "dev", providerId: "openai", excluded: false },
      ],
    } as ProviderSecretsPolicy,
    deliveries: [] as ProviderSecretsDelivery[],
    gate: null as Promise<void> | null,
    offline: new Set<string>(),
    unsupported: new Set<string>(),
    conflicts: {} as Record<string, string[]>,
  };
  const authority = new ProviderSecretsAuthority({
    installationId: INSTALLATION,
    read: () => state.persisted,
    persist: (next) => {
      state.persisted = structuredClone(next);
    },
    definitions: () => (state.policy.removed ? [] : ["openai"]),
    policy: () => structuredClone(state.policy),
    environment: (serverId) => LABELS[serverId],
    readEnvironment: async (serverId) => {
      if (state.offline.has(serverId)) throw Error("offline");
      return environments[serverId] ?? {};
    },
    deliver: async (delivery) => {
      if (state.unsupported.has(delivery.serverId)) throw new ProviderSecretsUnsupportedError();
      if (state.offline.has(delivery.serverId)) throw Error("offline");
      if (state.gate) await state.gate;
      state.deliveries.push(structuredClone(delivery));
      const { values: _values, overwrite: _overwrite, ...scope } = delivery;
      return {
        ...scope,
        digest: providerSecretsDeliveryDigest(delivery),
        phase: "applied",
        conflicts: state.conflicts[delivery.serverId] ?? [],
      };
    },
    now: () => new Date("2026-10-22T00:00:00.000Z"),
  });
  return { state, authority };
}

test("imports a key found in one environment and delivers it everywhere", async () => {
  const f = fixture();
  await f.authority.reconcile();
  const status = f.authority.status("openai");
  expect(status.ready).toBe(true);
  expect(status.secrets).toEqual([
    {
      name: "OPENAI_API_KEY",
      last4: KEY.slice(-4),
      updatedAt: "2026-10-22T00:00:00.000Z",
      source: "imported",
    },
  ]);
  expect(status.environments.map((item) => item.status)).toEqual(["delivered", "delivered"]);
  expect(f.state.deliveries.map((item) => [item.serverId, item.values])).toEqual([
    ["host", { OPENAI_API_KEY: KEY }],
    ["dev", { OPENAI_API_KEY: KEY }],
  ]);
  // Imported values never force replacement of a differing local copy.
  expect(f.state.deliveries.every((item) => item.overwrite.length === 0)).toBe(true);
  expect(JSON.stringify(status)).not.toContain(KEY);
  // Non-secret configuration such as base URLs is never imported.
  expect(JSON.stringify(f.state.persisted)).not.toContain("https://local");
});

test("reports differing values as a conflict and adopts neither", async () => {
  const f = fixture({
    host: { openai: { OPENAI_API_KEY: KEY } },
    dev: { openai: { OPENAI_API_KEY: OTHER } },
  });
  await f.authority.reconcile();
  let status = f.authority.status("openai");
  expect(status.secrets).toEqual([]);
  expect(status.conflicts).toEqual([{ name: "OPENAI_API_KEY", serverIds: ["dev", "host"] }]);
  expect(JSON.stringify(status)).not.toContain(OTHER);
  // Setting the key resolves the conflict and replaces both copies.
  await f.authority.set("openai", "OPENAI_API_KEY", OTHER);
  await f.authority.reconcile();
  status = f.authority.status("openai");
  expect(status.conflicts).toEqual([]);
  expect(status.ready).toBe(true);
  expect(f.state.deliveries.at(-1)).toMatchObject({ overwrite: ["OPENAI_API_KEY"] });
});

test("waits for every environment before a one-time import", async () => {
  const f = fixture();
  f.state.offline.add("dev");
  await f.authority.reconcile();
  expect(f.state.persisted).toEqual([]);
  expect(f.authority.status("openai").environments[1]).toMatchObject({
    status: "pending",
    message: "Checking existing keys in Dev container",
  });
  f.state.offline.delete("dev");
  await f.authority.reconcile();
  expect(f.authority.status("openai").ready).toBe(true);
  // Later local keys are not re-imported.
  await f.authority.clear("openai", "OPENAI_API_KEY");
  await f.authority.reconcile();
  expect(f.authority.status("openai").secrets).toEqual([]);
});

test("reports pending, failed, unsupported and conflicting environments", async () => {
  const f = fixture({ host: { openai: {} }, dev: { openai: {} } });
  await f.authority.reconcile();
  await f.authority.set("openai", "OPENAI_API_KEY", KEY);
  expect(f.authority.status("openai").environments).toEqual([
    { serverId: "host", kind: "host", status: "pending", message: "Reaching Host" },
    { serverId: "dev", kind: "container", status: "pending", message: "Reaching Dev container" },
  ]);
  f.state.unsupported.add("dev");
  await f.authority.reconcile();
  let status = f.authority.status("openai");
  expect(status.ready).toBe(false);
  expect(status.environments[0]!.status).toBe("delivered");
  expect(status.environments[1]).toMatchObject({
    status: "failed",
    message: "Update Dev container to receive shared keys.",
  });
  f.state.unsupported.delete("dev");
  f.state.conflicts.dev = ["OPENAI_API_KEY"];
  await f.authority.reconcile();
  status = f.authority.status("openai");
  expect(status.environments[1]).toMatchObject({ status: "failed", conflicts: ["OPENAI_API_KEY"] });
});

test("withdraws from newly excluded environments and discards removed definitions", async () => {
  const f = fixture();
  await f.authority.reconcile();
  f.state.policy = {
    ...f.state.policy,
    revision: 2,
    targets: [
      { serverId: "host", providerId: "openai", excluded: false },
      { serverId: "dev", providerId: "openai", excluded: true },
    ],
  };
  await f.authority.reconcile();
  expect(f.state.deliveries.at(-1)).toMatchObject({ serverId: "dev", values: {} });
  const status = f.authority.status("openai");
  expect(status.environments[1]!.status).toBe("excluded");
  expect(status.ready).toBe(true);

  f.state.policy = {
    revision: 3,
    removed: true,
    targets: f.state.policy.targets.map((target) => ({ ...target, excluded: true })),
  };
  await f.authority.reconcile();
  expect(f.state.deliveries.slice(-2).map((item) => item.values)).toEqual([{}, {}]);
  expect(JSON.stringify(f.state.persisted)).not.toContain(KEY);
  await expect(f.authority.set("openai", "OPENAI_API_KEY", KEY)).rejects.toThrow();
});

test("short values do not reveal their last characters", async () => {
  const f = fixture({ host: { openai: {} }, dev: { openai: {} } });
  await f.authority.set("openai", "SHORT_TOKEN", "abc123");
  expect(f.authority.status("openai").secrets[0]!.last4).toBeNull();
  await expect(f.authority.set("openai", "CODEX_HOME", "/elsewhere")).rejects.toThrow();
});

test("saves complete while a slow environment holds a delivery, then deliver the new generation", async () => {
  const f = fixture({ host: { openai: {} }, dev: { openai: {} } });
  await f.authority.reconcile();
  await f.authority.set("openai", "OPENAI_API_KEY", KEY);
  let release!: () => void;
  f.state.gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = f.authority.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await f.authority.set("openai", "OPENAI_API_KEY", OTHER);
  f.state.gate = null;
  release();
  await slow;
  // The stale generation's receipt does not mark the new generation delivered.
  expect(f.authority.status("openai").ready).toBe(false);
  await f.authority.reconcile();
  expect(f.authority.status("openai").ready).toBe(true);
  expect(f.state.deliveries.at(-1)!.values).toEqual({ OPENAI_API_KEY: OTHER });
});
