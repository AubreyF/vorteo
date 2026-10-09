import { beforeEach, expect, test, vi } from "vitest";
import { claudeSetupRequest } from "./claude-setup-login";
import { requestInstallationSettings } from "@/execution-installation/settings";
import { requestInstallationOwner } from "@/execution-installation/client";
vi.mock("@/execution-installation/settings", () => ({ requestInstallationSettings: vi.fn() }));
vi.mock("@/execution-installation/client", () => ({ requestInstallationOwner: vi.fn() }));
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
