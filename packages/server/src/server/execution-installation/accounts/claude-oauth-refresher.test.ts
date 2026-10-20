import { expect, it, vi } from "vitest";
import { ClaudeOAuthRefresher, type ClaudeOAuthPolicy } from "./claude-oauth-refresher.js";
import {
  accessProjectionDigest,
  type ClaudeOAuthProjectionDelivery,
  type ClaudeOAuthProjectionReceipt,
} from "./claude-oauth-delivery.js";
import type { ClaudeOAuthGrant } from "./claude-oauth-host.js";

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const MINUTE = 60_000;

function harness(options: { excluded?: boolean } = {}) {
  let now = 1_000_000_000_000;
  let state: unknown = [];
  let policy: ClaudeOAuthPolicy = {
    revision: 1,
    removed: false,
    targets: [
      { serverId: "dev", providerId: "claude-account-x", excluded: options.excluded ?? false },
    ],
  };
  let grant: ClaudeOAuthGrant | null = {
    accessToken: "synthetic-access-1",
    hasRefreshToken: true,
    expiresAt: now + 60 * MINUTE,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  };
  let online = true;
  let tokens = 1;
  const deliveries: ClaudeOAuthProjectionDelivery[] = [];
  const persisted: string[] = [];
  // Option A: the official CLI rotates the token under its own locks.
  const refresh = vi.fn(async () => {
    tokens += 1;
    grant = { ...grant!, accessToken: `synthetic-access-${tokens}`, expiresAt: now + 60 * MINUTE };
  });
  const create = () =>
    new ClaudeOAuthRefresher({
      installationId: INSTALLATION,
      read: () => state,
      persist: (next) => {
        state = structuredClone(next);
        persisted.push(JSON.stringify(next));
      },
      policy: () => policy,
      grant: async () => grant,
      refresh,
      deliver: async (delivery): Promise<ClaudeOAuthProjectionReceipt> => {
        if (!online) throw new Error("Dev is offline");
        deliveries.push(structuredClone(delivery));
        const { access, ...slot } = delivery;
        return {
          ...slot,
          digest: accessProjectionDigest(access),
          phase: "applied",
          active: access !== null,
        };
      },
      now: () => now,
    });
  return {
    create,
    deliveries,
    persisted,
    refresh,
    advance: (ms: number) => {
      now += ms;
    },
    setGrant: (value: ClaudeOAuthGrant | null) => {
      grant = value;
    },
    grant: () => grant,
    setPolicy: (value: ClaudeOAuthPolicy) => {
      policy = value;
    },
    policy: () => policy,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

it("projects the Host grant without refreshing far from expiry and never persists a token", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", { email: "owner@example.com", orgId: "org-1" });
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.deliveries).toHaveLength(1);
  expect(h.deliveries[0]).toMatchObject({
    generation: 1,
    rotation: 1,
    access: { accessToken: "synthetic-access-1", scopes: ["user:inference", "user:profile"] },
  });
  expect(Object.keys(h.deliveries[0]!.access!)).not.toContain("refreshToken");
  expect(refresher.status("one")).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com" },
    environments: [{ serverId: "dev", status: "ready" }],
  });
  // An idle reconcile delivers nothing and leaves state untouched.
  const writes = h.persisted.length;
  await refresher.reconcile();
  expect(h.deliveries).toHaveLength(1);
  expect(h.persisted).toHaveLength(writes);
  for (const saved of h.persisted) expect(saved).not.toContain("synthetic-access");
  // A restarted coordinator resumes from the same secret-free state.
  expect(h.create().status("one")).toEqual(refresher.status("one"));
});

it("refreshes once inside the lead window and delivers the new token as a new rotation", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(56 * MINUTE + 30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.deliveries.at(-1)).toMatchObject({
    rotation: 2,
    access: { accessToken: "synthetic-access-2" },
  });
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
});

it("never refreshes without a refresh token or while every Dev target is excluded", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setGrant({ ...h.grant()!, hasRefreshToken: false });
  h.advance(57 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();

  const excluded = harness({ excluded: true });
  const idle = excluded.create();
  await idle.connected("one", null);
  excluded.advance(57 * MINUTE);
  await idle.reconcile();
  expect(excluded.refresh).not.toHaveBeenCalled();
  expect(excluded.deliveries).toEqual([expect.objectContaining({ access: null })]);
  expect(idle.status("one").environments).toEqual([{ serverId: "dev", status: "excluded" }]);
});

it("keeps an offline Dev pending and retries the same rotation from a fresh Host read", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  h.setOnline(false);
  await refresher.reconcile();
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "pending" }]);
  h.setOnline(true);
  await refresher.reconcile();
  expect(h.deliveries).toEqual([
    expect.objectContaining({
      rotation: 1,
      access: expect.objectContaining({ expiresAt: expect.any(Number) }),
    }),
  ]);
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "ready" }]);
});

it("withdraws Dev and asks for sign-in when the Host grant disappears", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setGrant(null);
  h.advance(6 * MINUTE);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ rotation: 2, access: null });
  expect(refresher.status("one")).toMatchObject({
    needsSignIn: true,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
});

it("starts a new generation that withdraws Dev on sign-out, and another on reconnect", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  await refresher.signedOut("one");
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(refresher.status("one")).toMatchObject({
    signedIn: false,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
  await refresher.connected("one", null);
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 3, rotation: 1 });
});

it("re-delivers under a new rotation after a policy change", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setPolicy({ ...h.policy(), revision: 2 });
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ policyRevision: 2, rotation: 2 });
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "ready" }]);
});

it("records a failed refresh and retries it after a minute", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.refresh.mockRejectedValueOnce(new Error("CLI unavailable"));
  h.advance(57 * MINUTE);
  await refresher.reconcile();
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "failed" });
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  h.advance(31_000);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(2);
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
});
