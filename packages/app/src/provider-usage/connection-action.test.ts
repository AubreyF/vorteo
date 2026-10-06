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
