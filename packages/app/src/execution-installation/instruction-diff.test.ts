import { describe, expect, it } from "vitest";
import { diffInstructionLines } from "./instruction-diff";

describe("diffInstructionLines", () => {
  it("reports only removed and added lines in order", () => {
    expect(diffInstructionLines("a\nb\nc\nd", "a\nc\nd\ne")).toEqual([
      { kind: "removed", text: "b" },
      { kind: "added", text: "e" },
    ]);
  });

  it("shows a deleted line in a long prompt", () => {
    const lines = Array.from({ length: 300 }, (_, index) => `rule ${index}`);
    const proposed = lines.filter((line) => line !== "rule 150").join("\n");
    expect(diffInstructionLines(lines.join("\n"), proposed)).toEqual([
      { kind: "removed", text: "rule 150" },
    ]);
  });

  it("treats a changed line as a removal and an addition", () => {
    expect(diffInstructionLines("Be kind.", "Be candid.")).toEqual([
      { kind: "removed", text: "Be kind." },
      { kind: "added", text: "Be candid." },
    ]);
  });

  it("returns nothing for identical text", () => {
    expect(diffInstructionLines("same\ntext", "same\ntext")).toEqual([]);
  });
});
