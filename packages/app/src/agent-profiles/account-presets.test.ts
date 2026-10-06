import { describe, expect, it } from "vitest";
import { accountPresets, intelligenceLabel } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";

function row(id: string, provider: string): AgentProfilePickerRow {
  return { id, provider, name: id, modelId: "astra", icon: "", color: "", summary: "Astra" };
}

describe("account presets", () => {
  it("sorts accounts by name while preserving profile order within each account", () => {
    const rows = [row("medium", "codex1"), row("other", "codex2"), row("ultra", "codex1")];
    const entries = ["codex2", "codex1"].map((provider) => ({
      provider,
      status: "ready" as const,
      enabled: true,
    }));
    expect(accountPresets({ rows, definitions: [], entries, query: "" })).toEqual([
      { provider: "codex1", label: "codex1", rows: [rows[0], rows[2]] },
      { provider: "codex2", label: "codex2", rows: [rows[1]] },
    ]);
  });
  it("keeps natural account order across environments with different IDs and registration order", () => {
    const labels = ["Pi", "Codex 10", "Codex 2", "Codex 3 (Christian)", "Codex 1"];
    const ordered = (environment: string, names: string[]) => {
      const entries = names.map((label, index) => ({
        provider: `${environment}-${index}`,
        label,
        status: "ready" as const,
        enabled: true,
      }));
      return accountPresets({
        rows: entries.map((entry) => row(entry.provider, entry.provider)),
        definitions: [],
        entries,
        query: "",
      }).map((group) => group.label);
    };
    const expected = ["Codex 1", "Codex 2", "Codex 3 (Christian)", "Codex 10", "Pi"];
    expect(ordered("host", labels)).toEqual(expected);
    expect(ordered("container", labels.toReversed())).toEqual(expected);
  });

  it("groups intelligence profiles by account while retaining their order and identity", () => {
    const rows = [row("medium", "codex1"), row("other", "codex2"), row("ultra", "codex1")];
    expect(accountPresets({ rows, definitions: [], entries: undefined, query: "" })).toEqual([
      { provider: "codex1", label: "codex1", rows: [rows[0], rows[2]] },
      { provider: "codex2", label: "codex2", rows: [rows[1]] },
    ]);
  });

  it("searching a nickname retains the account's sibling intelligence choices", () => {
    const rows = [row("medium", "codex1"), row("ultra", "codex1"), row("other", "codex2")];
    const definitions = [{ id: "ultra", name: "Ultra", nickname: "deep", provider: "codex1" }];
    expect(accountPresets({ rows, definitions, entries: undefined, query: " DEEP " })).toEqual([
      { provider: "codex1", label: "codex1", rows: rows.slice(0, 2) },
    ]);
    expect(accountPresets({ rows, definitions, entries: undefined, query: "missing" })).toEqual([]);
  });

  it("finds Pi models even when they do not have a saved profile", () => {
    const rows = [row("saved", "pi")];
    const entries = [
      {
        provider: "pi",
        status: "ready" as const,
        enabled: true,
        models: [{ provider: "pi", id: "local/other", label: "Another model" }],
      },
    ];
    expect(accountPresets({ rows, definitions: [], entries, query: "Another" })).toHaveLength(1);
  });

  it("uses stored reasoning rather than guessing from the profile name", () => {
    expect(
      intelligenceLabel(
        { id: "one", name: "Ultra", provider: "codex1", thinkingOptionId: "medium" },
        undefined,
      ),
    ).toBe("Medium");
    expect(intelligenceLabel({ id: "two", name: "Medium", provider: "codex1" }, undefined)).toBe(
      "Provider default",
    );
  });
});

it("selects accounts independently while keeping one shared profile ID", () => {
  const shared = row("shared-profile/codex/review", "codex");
  const entries = ["one", "two"].map((provider) => ({
    provider,
    enabled: true,
    status: "ready" as const,
  }));
  const groups = accountPresets({
    rows: [shared],
    definitions: [],
    entries,
    query: "",
    providers: { one: { extends: "codex" }, two: { extends: "codex" } },
    accountIndependent: true,
  });
  expect(
    groups.map((group) => ({
      provider: group.provider,
      profileIds: group.rows.map((item) => item.id),
    })),
  ).toEqual([
    { provider: "one", profileIds: [shared.id] },
    { provider: "two", profileIds: [shared.id] },
  ]);
  expect(shared.provider).toBe("codex");
});
