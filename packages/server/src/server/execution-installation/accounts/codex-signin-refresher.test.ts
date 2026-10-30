import { expect, it, vi } from "vitest";
import { CodexSignInRefresher } from "./codex-signin-refresher.js";
import {
  codexProjectionDigest,
  type CodexSignInProjectionDelivery,
  type CodexSignInProjectionReceipt,
} from "./codex-signin-delivery.js";
import type { CodexHostGrant } from "./codex-signin-host.js";
import type { HostRefreshPolicy } from "./host-owned-refresher.js";

const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function harness(options: { excluded?: boolean } = {}) {
  let now = 1_000_000_000_000;
  let state: unknown = [];
  let policy: HostRefreshPolicy = {
    revision: 1,
    removed: false,
    targets: [
      { serverId: "dev", providerId: "codex-account-x", excluded: options.excluded ?? false },
    ],
  };
  let grant: CodexHostGrant | null = {
    accessToken: "synthetic-access-1",
    idToken: "synthetic-id-1",
    accountId: "workspace-1",
    hasRefreshToken: true,
    expiresAt: now + 10 * DAY,
    lastRefresh: new Date(now).toISOString(),
  };
  let online = true;
  let tokens = 1;
  const deliveries: CodexSignInProjectionDelivery[] = [];
  const persisted: string[] = [];
  // The official Host Codex rotates the grant and saves it in its own CODEX_HOME.
  const refresh = vi.fn(async () => {
    tokens += 1;
    grant = {
      ...grant!,
      accessToken: `synthetic-access-${tokens}`,
      expiresAt: now + 10 * DAY,
      lastRefresh: new Date(now).toISOString(),
    };
  });
  const create = () =>
    new CodexSignInRefresher({
      installationId: INSTALLATION,
      read: () => state,
      persist: (next) => {
        state = structuredClone(next);
        persisted.push(JSON.stringify(next));
      },
      policy: () => policy,
      grant: async () => grant,
      refresh,
      deliver: async (delivery): Promise<CodexSignInProjectionReceipt> => {
        if (!online) throw new Error("Dev is offline");
        deliveries.push(structuredClone(delivery));
        const { access, ...slot } = delivery;
        return {
          ...slot,
          digest: codexProjectionDigest(access),
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
    setGrant: (value: CodexHostGrant | null) => {
      grant = value;
    },
    grant: () => grant,
    setPolicy: (value: HostRefreshPolicy) => {
      policy = value;
    },
    policy: () => policy,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

it("delivers the Host grant to Dev without its refresh token and persists no token", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", { email: "owner@example.com", orgId: "workspace-1" });
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();
  expect(h.deliveries).toEqual([
    expect.objectContaining({
      serverId: "dev",
      generation: 1,
      rotation: 1,
      access: expect.objectContaining({
        accessToken: "synthetic-access-1",
        idToken: "synthetic-id-1",
        accountId: "workspace-1",
      }),
    }),
  ]);
  expect(Object.keys(h.deliveries[0]!.access!)).not.toContain("refreshToken");
  expect(refresher.status("one")).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com", orgId: "workspace-1" },
    environments: [{ serverId: "dev", status: "ready" }],
  });
  for (const saved of h.persisted) expect(saved).not.toContain("synthetic-");
  // A restarted coordinator resumes from the same secret-free state.
  expect(h.create().status("one")).toEqual(refresher.status("one"));
});

it("refreshes on the Host inside the expiry lead and delivers the rotation to Dev", async () => {
  const h = harness();
  h.setGrant({ ...h.grant()!, expiresAt: 1_000_000_000_000 + 60 * MINUTE });
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();
  h.advance(31 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.deliveries.at(-1)).toMatchObject({
    rotation: 2,
    access: { accessToken: "synthetic-access-2" },
  });
  expect(refresher.status("one").refresh).toMatchObject({ outcome: "refreshed" });
});

it("refreshes a day before Codex itself would consider the sign-in stale", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(7 * DAY - 10 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();
  h.advance(10 * MINUTE);
  await refresher.reconcile();
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.deliveries.at(-1)).toMatchObject({ access: { accessToken: "synthetic-access-2" } });
});

it("never refreshes without a Host refresh token or while every Dev target is excluded", async () => {
  const h = harness();
  h.setGrant({ ...h.grant()!, hasRefreshToken: false, expiresAt: 1_000_000_000_000 + MINUTE });
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.refresh).not.toHaveBeenCalled();

  const excluded = harness({ excluded: true });
  const idle = excluded.create();
  await idle.connected("one", null);
  excluded.advance(8 * DAY);
  await idle.reconcile();
  expect(excluded.refresh).not.toHaveBeenCalled();
  expect(excluded.deliveries).toEqual([expect.objectContaining({ access: null })]);
  expect(idle.status("one").environments).toEqual([{ serverId: "dev", status: "excluded" }]);
});

it("keeps an offline Dev pending and resumes without a second sign-in", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  h.setOnline(false);
  await refresher.reconcile();
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "pending" }]);
  h.setOnline(true);
  h.advance(30_000);
  await refresher.reconcile();
  expect(h.deliveries).toHaveLength(1);
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "ready" }]);
});

it("withdraws Dev on sign-out and asks for sign-in when the Host grant disappears", async () => {
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
  await refresher.signedOut("one");
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(refresher.status("one")).toMatchObject({ signedIn: false });
});

it("withdraws a newly excluded Dev under a new policy rotation", async () => {
  const h = harness();
  const refresher = h.create();
  await refresher.connected("one", null);
  await refresher.reconcile();
  h.setPolicy({
    revision: 2,
    removed: false,
    targets: [{ serverId: "dev", providerId: "codex-account-x", excluded: true }],
  });
  await refresher.reconcile();
  expect(h.deliveries.at(-1)).toMatchObject({ policyRevision: 2, rotation: 2, access: null });
  expect(refresher.status("one").environments).toEqual([{ serverId: "dev", status: "excluded" }]);
});
