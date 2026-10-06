import { describe, expect, it } from "vitest";
import { accountPresets, intelligenceLabel } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";

function row(id: string, provider: string): AgentProfilePickerRow {
  return { id, provider, name: id, modelId: "astra", icon: "", color: "", summary: "Astra" };
}

describe("account presets", () => {
  it("follows provider order while preserving profile order within each account", () => {
    const rows = [row("medium", "codex1"), row("other", "codex2"), row("ultra", "codex1")];
    const entries = ["codex2", "codex1"].map((provider) => ({
      provider,
      status: "ready" as const,
      enabled: true,
    }));
    expect(accountPresets({ rows, definitions: [], entries, query: "" })).toEqual([
      { provider: "codex2", label: "codex2", rows: [rows[1]] },
      { provider: "codex1", label: "codex1", rows: [rows[0], rows[2]] },
    ]);
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
