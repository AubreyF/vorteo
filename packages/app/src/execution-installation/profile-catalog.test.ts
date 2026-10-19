import { expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { selectProfileCatalogSources } from "./profile-catalog";
import { openAgentProfileForm } from "@/agent-profiles/internal/profile-form-model";

const disabled: ProviderSnapshotEntry = {
  provider: "claude",
  enabled: false,
  status: "unavailable",
  modes: [],
};
const connected: ProviderSnapshotEntry = {
  provider: "claude-account",
  enabled: true,
  status: "ready",
  modes: [
    { id: "default", label: "Always Ask" },
    { id: "auto", label: "Auto mode" },
  ],
};

it("populates shared Claude mode choices from a connected account instead of the disabled base", () => {
  const entries = [disabled, connected];
  const sources = selectProfileCatalogSources([
    { serverId: "host", entries, providers: { "claude-account": { extends: "claude" } } },
  ]);
  expect(sources.get("claude")).toEqual({ serverId: "host", provider: "claude-account" });
  const model = openAgentProfileForm({
    mode: "edit",
    profile: {
      id: "defaults",
      name: "Provider defaults",
      provider: sources.get("claude")!.provider,
      modeId: "auto",
    },
  });
  model.applyProviderCatalog(entries);
  expect(model.getState().modeOptions.map((option) => option.value)).toEqual(["default", "auto"]);
  expect(model.getState().modeDisplay?.label).toBe("Auto mode");
});

it.each(["loading", "error", "unavailable"] as const)(
  "uses a ready container account when the Host catalog is %s",
  (status) => {
    const sources = selectProfileCatalogSources([
      { serverId: "host", entries: [{ ...disabled, enabled: true, status }], providers: {} },
      {
        serverId: "container",
        entries: [connected],
        providers: { "claude-account": { extends: "claude" } },
      },
    ]);
    expect(sources.get("claude")).toEqual({
      serverId: "container",
      provider: "claude-account",
    });
  },
);

it("keeps Host precedence when both environments have a ready catalog", () => {
  const providers = { "claude-account": { extends: "claude" } };
  const sources = selectProfileCatalogSources([
    { serverId: "host", entries: [connected], providers },
    { serverId: "container", entries: [connected], providers },
  ]);
  expect(sources.get("claude")).toEqual({ serverId: "host", provider: "claude-account" });
});

it("retains unavailable families without inventing modes and skips absent environments", () => {
  const sources = selectProfileCatalogSources([
    { serverId: null, entries: [connected], providers: {} },
    { serverId: "loading-host", entries: undefined, providers: undefined },
    { serverId: "host", entries: [disabled], providers: {} },
  ]);
  expect([...sources]).toEqual([["claude", { serverId: "host", provider: "claude" }]]);
});
