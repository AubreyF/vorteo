import { expect, test } from "vitest";
import {
  ClaudeSetupDeliveryService,
  type ClaudeSetupDeliveryReceipt,
} from "./claude-setup-delivery.js";
import type { ClaudeSetupToken } from "../../agent/providers/claude/setup-token-store.js";

const delivery = {
  installationId: "11111111-1111-4111-8111-111111111111",
  serverId: "dev",
  definitionId: "claude-one",
  providerId: "claude-account-one",
  revision: 1,
  policyRevision: 5,
  credential: { version: 1, accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`, createdAt: 1 },
};
function fixture() {
  const state: {
    receipt: ClaudeSetupDeliveryReceipt | null;
    token: ClaudeSetupToken | null;
    authorized: boolean;
    failStore: boolean;
  } = { receipt: null, token: null, authorized: true, failStore: false };
  const ports = {
    read: () => state.receipt,
    persist: (receipt: ClaudeSetupDeliveryReceipt) => {
      state.receipt = receipt;
    },
    store: async (credential: ClaudeSetupToken | null) => {
      if (state.failStore) throw Error("secret must not escape");
      state.token = credential;
    },
    authorize: async () => {
      if (!state.authorized) throw Error("excluded");
    },
  };
  return { state, ports, service: new ClaudeSetupDeliveryService(ports) };
}

test("identical retries recover after persistence failure, including a new service instance", async () => {
  const f = fixture();
  f.state.failStore = true;
  await expect(f.service.apply(delivery)).rejects.toThrow("synchronization is pending");
  expect(f.state.receipt?.phase).toBe("pending");
  expect(JSON.stringify(f.state.receipt)).not.toContain(delivery.credential.accessToken);
  f.state.failStore = false;
  const resumed = new ClaudeSetupDeliveryService(f.ports);
  expect((await resumed.apply(delivery)).phase).toBe("applied");
  expect(f.state.token).toEqual(delivery.credential);
});

test("revocation tombstone prevents stale delivery and changed same-generation payloads", async () => {
  const f = fixture();
  await f.service.apply(delivery);
  await expect(
    f.service.apply({ ...delivery, credential: { ...delivery.credential, createdAt: 2 } }),
  ).rejects.toThrow();
  await f.service.apply({ ...delivery, revision: 2, credential: null });
  expect(f.state.token).toBeNull();
  await expect(new ClaudeSetupDeliveryService(f.ports).apply(delivery)).rejects.toThrow();
  expect(f.state.receipt?.active).toBe(false);
});

test("rechecks authority after write and denies wrong binding or extra refresh fields", async () => {
  const f = fixture();
  await f.service.apply(delivery);
  await expect(f.service.apply({ ...delivery, revision: 2, serverId: "other" })).rejects.toThrow();
  await expect(
    f.service.apply({ ...delivery, credential: { ...delivery.credential, refreshToken: "never" } }),
  ).rejects.toThrow();
  f.ports.store = async (credential) => {
    f.state.token = credential;
    f.state.authorized = false;
  };
  await expect(f.service.apply({ ...delivery, revision: 2 })).rejects.toThrow();
  expect(f.state.receipt?.phase).toBe("pending");
});
