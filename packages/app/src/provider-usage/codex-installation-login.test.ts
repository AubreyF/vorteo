import { beforeEach, expect, test, vi } from "vitest";
import {
  codexInstallationRequest,
  codexInstallationSignInAvailable,
} from "./codex-installation-login";
import { requestInstallationSettings } from "@/execution-installation/settings";
import {
  InstallationRequestFailed,
  OwnerAccessExpired,
  requestInstallationOwner,
} from "@/execution-installation/client";
vi.mock("@/execution-installation/settings", () => ({ requestInstallationSettings: vi.fn() }));
vi.mock("@/execution-installation/client", () => ({
  requestInstallationOwner: vi.fn(),
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
  id: "shared-codex",
  providerType: "codex",
  accountSetup: { provider: "codex", creationId: "11111111-1111-4111-8111-111111111111" },
  bindings: { host: "codex-one", dev: "codex-one" },
  policy: { label: "Pro" },
};

test("Host and Dev start the same installation sign-in, with no environment choice", async () => {
  settings([account]);
  request.mockResolvedValue({
    status: "starting",
    attemptId: "22222222-2222-4222-8222-222222222222",
  });
  await codexInstallationRequest("host", "codex-one", "start");
  await codexInstallationRequest("dev", "codex-one", "start");
  expect(request.mock.calls).toEqual([
    ["codex/signin/start", "", { definitionId: "shared-codex" }],
    ["codex/signin/start", "", { definitionId: "shared-codex" }],
  ]);
});

test("unlinked, duplicate and removed bindings cannot start a sign-in", async () => {
  for (const definitions of [
    [],
    [{ ...account, accountSetup: undefined }],
    [account, { ...account, id: "copy" }],
    [{ ...account, removed: true }],
  ]) {
    settings(definitions);
    await expect(codexInstallationRequest("dev", "codex-one", "start")).rejects.toThrow(
      "Refresh shared account settings",
    );
  }
  expect(request).not.toHaveBeenCalled();
});

test("read reports Dev synchronization and the Host account", async () => {
  settings([account]);
  request.mockResolvedValue({
    login: { status: "idle" },
    connection: {
      signedIn: true,
      needsSignIn: false,
      identity: { email: "owner@example.com", orgId: "workspace-1" },
      environments: [{ serverId: "dev", status: "pending" }],
      refresh: null,
    },
  });
  await expect(codexInstallationRequest("host", "codex-one", "read")).resolves.toEqual({
    login: { status: "idle" },
    connection: {
      connected: true,
      needsSignIn: false,
      accountLabel: "owner@example.com",
      environments: [{ serverId: "dev", status: "pending" }],
    },
  });
});

test("only the coordinator's refusal of an unknown definition enables shared Codex sign-in", async () => {
  request.mockRejectedValueOnce(new InstallationRequestFailed("refused", 409));
  await expect(codexInstallationSignInAvailable()).resolves.toBe(true);
  request.mockRejectedValueOnce(new InstallationRequestFailed("missing", 404));
  await expect(codexInstallationSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new Error("offline"));
  await expect(codexInstallationSignInAvailable()).resolves.toBe(false);
  request.mockRejectedValueOnce(new OwnerAccessExpired("locked"));
  await expect(codexInstallationSignInAvailable()).rejects.toThrow("locked");
});
