import { expect, it } from "vitest";
import { providerConnectionAction } from "./connection-action";
import type { ProviderUsage } from "./types";

const providers = { christian: { extends: "codex" }, local: { extends: "pi" } };
const usage: ProviderUsage = {
  providerId: "christian",
  displayName: "Christian",
  status: "unavailable",
  planLabel: null,
  windows: [],
};
const input = { providerId: "christian", providers, usage };

it("offers initial connection for a Codex alias without inventing an auth failure", () => {
  expect(providerConnectionAction(input)).toBe("Connect");
  expect(providerConnectionAction({ ...input, usage: undefined })).toBe("Connect");
  expect(usage.authRecovery).toBeUndefined();
});

it("retains recovery for rejected credentials and hides connection for available usage", () => {
  expect(
    providerConnectionAction({
      ...input,
      usage: { ...usage, authRecovery: { method: "device_code", instructions: "Sign in" } },
    }),
  ).toBe("Reconnect");
  expect(
    providerConnectionAction({ ...input, usage: { ...usage, status: "available" } }),
  ).toBeNull();
});

it("uses configured provider identity, including built-in Codex, rather than names", () => {
  expect(providerConnectionAction({ ...input, providerId: "codex" })).toBe("Connect");
  expect(providerConnectionAction({ ...input, providerId: "local" })).toBeNull();
  expect(providerConnectionAction({ ...input, providerId: "codex-impostor" })).toBeNull();
  expect(
    providerConnectionAction({
      ...input,
      providers: { christian: { extends: "codex", enabled: false } },
    }),
  ).toBeNull();
});

it("honors Claude's account-scoped auth check when usage is unavailable", () => {
  const claude = {
    providerId: "work",
    providers: { work: { extends: "claude" } },
    usage: { ...usage, providerId: "work" },
    snapshot: { provider: "work", status: "ready" as const, enabled: true },
  };
  expect(providerConnectionAction(claude)).toBeNull();
  expect(providerConnectionAction({ ...claude, usage: undefined })).toBeNull();
});

it.each(["loading", "unavailable", "error"] as const)(
  "keeps Connect when Claude authentication is not established (%s)",
  (status) => {
    expect(
      providerConnectionAction({
        providerId: "work",
        providers: { work: { extends: "claude" } },
        usage: { ...usage, providerId: "work" },
        snapshot: { provider: "work", status, enabled: true },
      }),
    ).toBe("Connect");
  },
);

it("never borrows another account's ready status or treats Codex readiness as Claude auth", () => {
  expect(
    providerConnectionAction({
      providerId: "work",
      providers: { work: { extends: "claude" } },
      usage: undefined,
      snapshot: { provider: "personal", status: "ready", enabled: true },
    }),
  ).toBe("Connect");
  expect(
    providerConnectionAction({
      ...input,
      snapshot: { provider: "christian", status: "ready", enabled: true },
    }),
  ).toBe("Connect");
  expect(
    providerConnectionAction({
      providerId: "claude",
      providers: {},
      usage: undefined,
      snapshot: { provider: "claude", status: "ready", enabled: false },
    }),
  ).toBe("Connect");
});

it("retains explicit auth recovery even when Claude's cached snapshot is ready", () => {
  expect(
    providerConnectionAction({
      providerId: "claude",
      providers: {},
      usage: {
        ...usage,
        providerId: "claude",
        authRecovery: { instructions: "Sign in again" },
      },
      snapshot: { provider: "claude", status: "ready", enabled: true },
    }),
  ).toBe("Reconnect");
});
