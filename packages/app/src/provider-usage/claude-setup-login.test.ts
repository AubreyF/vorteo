import { beforeEach, expect, test, vi } from "vitest";
import { claudeFullSignInAvailable, claudeSetupRequest } from "./claude-setup-login";
import { requestInstallationSettings } from "@/execution-installation/settings";
import {
  InstallationRequestFailed,
  InstallationRouteUnavailable,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
vi.mock("@/execution-installation/settings", () => ({ requestInstallationSettings: vi.fn() }));
vi.mock("@/execution-installation/client", () => ({
  requestInstallationOwner: vi.fn(),
  InstallationRouteUnavailable: class extends Error {},
  InstallationRequestFailed: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
  OwnerAccessExpired: class extends Error {},
}));
const read = vi.mocked(requestInstallationSettings);
const request = vi.mocked(requestInstallationOwner);
beforeEach(() => {
  vi.resetAllMocks();
});
function settings(definitions: unknown[]) {
  read.mockResolvedValue({ settings: { providerDefinitions: definitions } } as Awaited<
    ReturnType<typeof requestInstallationSettings>
  >);
}
const account = {
  id: "shared-one",
  providerType: "claude",
  bindings: { host: "claude-one", dev: "claude-one" },
  policy: { label: "Same label" },
};

test("Host and Dev submit the exact same installation connection without a credential payload", async () => {
  settings([
    account,
    { ...account, id: "other", bindings: { host: "claude-other", dev: "claude-other" } },
  ]);
  request.mockResolvedValue({
    status: "starting",
    attemptId: "11111111-1111-4111-8111-111111111111",
  });
  await claudeSetupRequest("host", "claude-one", "start");
  await claudeSetupRequest("dev", "claude-one", "start");
  expect(request.mock.calls).toEqual([
    ["claude/setup-token/start", "", { definitionId: "shared-one" }],
    ["claude/setup-token/start", "", { definitionId: "shared-one" }],
  ]);
});

test("missing, duplicate and removed bindings cannot silently start an environment-local login", async () => {
  for (const definitions of [
    [],
    [account, { ...account, id: "duplicate" }],
    [{ ...account, removed: true }],
  ]) {
    settings(definitions);
    await expect(claudeSetupRequest("dev", "claude-one", "start")).rejects.toThrow(
      "Refresh shared account settings",
    );
  }
  expect(request).not.toHaveBeenCalled();
});

test("unavailable coordinator is surfaced and pending delivery stays distinct from login success", async () => {
  settings([account]);
  request.mockRejectedValueOnce(new Error("Update coordinator"));
  await expect(claudeSetupRequest("host", "claude-one", "start")).rejects.toThrow(
    "Update coordinator",
  );
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: { connected: true, environments: [{ serverId: "dev", status: "pending" }] },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection?.environments).toEqual(
    [{ serverId: "dev", status: "pending" }],
  );
});

test("full sign-in accounts use the Host refresh routes and report the Host account", async () => {
  settings([
    {
      ...account,
      accountSetup: {
        provider: "claude",
        creationId: "11111111-1111-4111-8111-111111111111",
        signIn: "full",
      },
    },
  ]);
  request.mockResolvedValueOnce({
    status: "starting",
    attemptId: "11111111-1111-4111-8111-111111111111",
  });
  await claudeSetupRequest("host", "claude-one", "start");
  expect(request.mock.calls[0]).toEqual(["claude/oauth/start", "", { definitionId: "shared-one" }]);
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: {
      signedIn: true,
      needsSignIn: false,
      identity: { email: "owner@example.com", orgId: null },
      expiresAt: 1,
      refresh: null,
      environments: [{ serverId: "dev", status: "ready" }],
    },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection).toEqual({
    connected: true,
    needsSignIn: false,
    accountLabel: "owner@example.com",
    environments: [{ serverId: "dev", status: "ready" }],
  });
});

test("a lost Host grant reads as not connected so the owner signs in again", async () => {
  settings([
    {
      ...account,
      accountSetup: {
        provider: "claude",
        creationId: "11111111-1111-4111-8111-111111111111",
        signIn: "full",
      },
    },
  ]);
  request.mockResolvedValueOnce({
    login: { status: "idle" },
    connection: { signedIn: true, needsSignIn: true, identity: null, environments: [] },
  });
  expect((await claudeSetupRequest("host", "claude-one", "read")).connection).toMatchObject({
    connected: false,
    needsSignIn: true,
  });
});

test("full sign-in is offered only when the coordinator serves its routes", async () => {
  request.mockRejectedValueOnce(
    new InstallationRequestFailed("Claude sign-in could not complete.", 409),
  );
  await expect(claudeFullSignInAvailable()).resolves.toBe(true);
  request.mockRejectedValueOnce(new InstallationRequestFailed("Coordinator maintenance", 503));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new InstallationRouteUnavailable("unavailable"));
  await expect(claudeFullSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new OwnerAccessExpired("locked"));
  await expect(claudeFullSignInAvailable()).rejects.toThrow("locked");
});
