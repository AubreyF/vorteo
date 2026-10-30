import { expect, test } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { accountsFirstServerId, decideAccountsFirst, hasInstallationAccounts } from "./model";

const INSTALLATION = "3386c661-7e90-4e01-abf7-e7ca3b9fca00";

function definition(overrides: Partial<InstallationProvider> = {}): InstallationProvider {
  return {
    id: "claude",
    providerType: "claude",
    bindings: { host: "claude" },
    policy: {},
    ...overrides,
  };
}
const account = definition({
  id: "claude-2",
  accountSetup: { provider: "claude", creationId: "11111111-1111-4111-8111-111111111111" },
  bindings: { host: "claude-2", dev: "claude-2" },
});

function decide(overrides: Partial<Parameters<typeof decideAccountsFirst>[0]> = {}) {
  return decideAccountsFirst({
    previous: "pending",
    installationId: INSTALLATION,
    hydrated: true,
    dismissed: [],
    settings: { status: "ready", definitions: [definition()] },
    ...overrides,
  });
}

test("only accounts connected through Vorteo count, and removed accounts do not", () => {
  expect(hasInstallationAccounts(undefined)).toBe(false);
  // A default provider connection is local to its environment.
  expect(hasInstallationAccounts([definition()])).toBe(false);
  expect(hasInstallationAccounts([definition(), account])).toBe(true);
  expect(hasInstallationAccounts([{ ...account, removed: true }])).toBe(false);
});

test("the first screen shows once settings confirm no installation account", () => {
  expect(decide()).toBe("show");
  expect(decide({ settings: { status: "ready", definitions: [account] } })).toBe("hide");
});

test("it waits for stored dismissals and settings, and stays out of the way on errors", () => {
  expect(decide({ hydrated: false })).toBe("pending");
  expect(decide({ settings: { status: "loading" } })).toBe("pending");
  expect(decide({ settings: { status: "error" } })).toBe("hide");
  expect(decide({ installationId: null })).toBe("hide");
});

test("dismissal is remembered per installation", () => {
  expect(decide({ dismissed: [INSTALLATION] })).toBe("hide");
  expect(decide({ previous: "show", dismissed: [INSTALLATION] })).toBe("hide");
  expect(decide({ dismissed: ["another-installation"] })).toBe("show");
});

test("a shown screen stays while the owner connects an account in it", () => {
  expect(decide({ previous: "show", settings: { status: "ready", definitions: [account] } })).toBe(
    "show",
  );
  expect(decide({ previous: "hide", settings: { status: "ready", definitions: [] } })).toBe("hide");
});

test("sign-ins target the Host, falling back to Dev", () => {
  const host = {
    kind: "host",
    serverId: "host",
    endpoint: "h.example.test",
    useTls: true,
  } as const;
  const dev = {
    kind: "container",
    serverId: "dev",
    endpoint: "d.example.test",
    useTls: true,
  } as const;
  expect(accountsFirstServerId([dev, host])).toBe("host");
  expect(accountsFirstServerId([dev])).toBe("dev");
  expect(accountsFirstServerId([])).toBeNull();
});
