import { describe, expect, it } from "vitest";
import type { ProviderSecretsStatus } from "@getpaseo/protocol/provider-secrets";
import { describeSecretDelivery } from "./provider-secrets";

const saved = {
  name: "ZAI_API_KEY",
  last4: "abcd",
  updatedAt: new Date(0).toISOString(),
  source: "owner" as const,
};

function status(overrides: Partial<ProviderSecretsStatus>): ProviderSecretsStatus {
  return {
    definitionId: "zai",
    secrets: [saved],
    environments: [],
    conflicts: [],
    ready: false,
    ...overrides,
  };
}

describe("describeSecretDelivery", () => {
  it("stays quiet when keys are everywhere or none are shared", () => {
    expect(describeSecretDelivery(status({ ready: true }))).toBeNull();
    expect(describeSecretDelivery(status({ secrets: [] }))).toBeNull();
    expect(describeSecretDelivery(undefined)).toBeNull();
  });

  it("shows the environment still waiting", () => {
    expect(
      describeSecretDelivery(
        status({
          environments: [
            { serverId: "host", kind: "host", status: "delivered" },
            {
              serverId: "dev",
              kind: "container",
              status: "pending",
              message: "Reaching Dev container",
            },
          ],
        }),
      ),
    ).toBe("Reaching Dev container");
  });

  it("asks the owner to resolve differing imported values", () => {
    expect(
      describeSecretDelivery(
        status({ conflicts: [{ name: "ZAI_API_KEY", serverIds: ["host", "dev"] }] }),
      ),
    ).toBe("Different ZAI_API_KEY values found. Set the key once to use it everywhere.");
  });
});
