import { expect, test } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { ProviderUsage } from "@/provider-usage/types";
import {
  accountsFirstConnections,
  accountsFirstServerId,
  decideAccountsFirst,
  type AccountsFirstConnection,
} from "./model";

const INSTALLATION = "3386c661-7e90-4e01-abf7-e7ca3b9fca00";

function definition(overrides: Partial<InstallationProvider> = {}): InstallationProvider {
  return {
    id: "claude",
    providerType: "claude",
    bindings: { host: "claude", dev: "claude" },
    policy: {},
    ...overrides,
  };
}
const claudeDefault = definition();
const codexDefault = definition({
  id: "codex",
  providerType: "codex",
  bindings: { host: "codex", dev: "codex" },
});
const account = definition({
  id: "claude-2",
  accountSetup: { provider: "claude", creationId: "11111111-1111-4111-8111-111111111111" },
  bindings: { host: "claude-account-1111", dev: "claude-account-1111" },
  policy: { label: "Claude 1" },
});

function usage(providerId: string, overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: "pro",
    windows: [],
    ...overrides,
  };
}

const ON = { claude: true, codex: true };
const OFF = { claude: false, codex: false };

function connections(
  definitions: InstallationProvider[],
  hostUsage: ProviderUsage[] | undefined,
  connectOnce = ON,
) {
  return accountsFirstConnections({ definitions, hostServerId: "host", hostUsage, connectOnce });
}
function connected(entries: AccountsFirstConnection[]) {
  return Object.fromEntries(
    entries.map((entry) => [entry.provider, entry.connection?.name ?? null]),
  );
}

function decide(
  overrides: Partial<Parameters<typeof decideAccountsFirst>[0]> & {
    rows?: AccountsFirstConnection[];
  } = {},
) {
  const { rows, ...rest } = overrides;
  return decideAccountsFirst({
    previous: "pending",
    installationId: INSTALLATION,
    hydrated: true,
    dismissed: [],
    connections: {
      status: "ready",
      connections: rows ?? connections([claudeDefault, codexDefault], undefined),
    },
    ...rest,
  });
}

test("accounts added through Vorteo count as connected, and removed ones do not", () => {
  expect(connected(connections([claudeDefault, codexDefault, account], undefined))).toEqual({
    claude: "Claude 1",
    codex: null,
  });
  expect(connected(connections([claudeDefault, { ...account, removed: true }], undefined))).toEqual(
    { claude: null, codex: null },
  );
});

test("with connect-once on, a signed-in default Host connection counts as connected", () => {
  // The adopted installation: the Host Codex CLI is signed in and reports pro usage.
  const rows = connections([claudeDefault, codexDefault], [usage("codex")]);
  const codex = rows.find((entry) => entry.provider === "codex")!;
  expect(codex.connection).toMatchObject({ isDefault: true, signedIn: true, plan: "pro" });
  expect(rows.find((entry) => entry.provider === "claude")!.connection).toBeNull();
  expect(decide({ rows })).toBe("show");
  expect(
    decide({ rows: connections([claudeDefault, codexDefault], [usage("codex"), usage("claude")]) }),
  ).toBe("hide");
});

test("a default connection does not count without connect-once, sign-in or usage", () => {
  const both = [usage("codex"), usage("claude")];
  expect(connected(connections([claudeDefault, codexDefault], both, OFF))).toEqual({
    claude: null,
    codex: null,
  });
  const lost = [
    usage("codex", { authRecovery: { instructions: "Sign in again" } }),
    usage("claude", { status: "unavailable" }),
  ];
  expect(connected(connections([claudeDefault, codexDefault], lost))).toEqual({
    claude: null,
    codex: null,
  });
  // Usage read on Dev never stands in for the Host.
  expect(
    connected(
      accountsFirstConnections({
        definitions: [definition({ bindings: { dev: "claude" } })],
        hostServerId: "host",
        hostUsage: [usage("claude")],
        connectOnce: ON,
      }),
    ),
  ).toEqual({ claude: null, codex: null });
});

test("a disabled provider neither shows nor keeps the screen open", () => {
  const rows = connections(
    [claudeDefault, { ...codexDefault, policy: { enabled: false } }],
    [usage("claude")],
  );
  expect(rows.find((entry) => entry.provider === "codex")!.enabled).toBe(false);
  expect(decide({ rows })).toBe("hide");
});

test("the first screen shows once connections confirm something to connect", () => {
  expect(decide()).toBe("show");
  expect(decide({ rows: connections([], undefined) })).toBe("show");
});

test("it waits for stored dismissals and connections, and stays out of the way on errors", () => {
  expect(decide({ hydrated: false })).toBe("pending");
  expect(decide({ connections: { status: "loading" } })).toBe("pending");
  expect(decide({ connections: { status: "error" } })).toBe("hide");
  expect(decide({ installationId: null })).toBe("hide");
});

test("dismissal is remembered per installation", () => {
  expect(decide({ dismissed: [INSTALLATION] })).toBe("hide");
  expect(decide({ previous: "show", dismissed: [INSTALLATION] })).toBe("hide");
  expect(decide({ dismissed: ["another-installation"] })).toBe("show");
});

test("a shown screen stays while the owner connects an account in it", () => {
  const all = connections([account, codexDefault], [usage("codex")]);
  expect(decide({ previous: "show", rows: all })).toBe("show");
  expect(decide({ previous: "hide", rows: connections([], undefined) })).toBe("hide");
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
