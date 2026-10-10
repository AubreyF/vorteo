import { describe, expect, it } from "vitest";
import {
  journalSeenKey,
  parseSeenEntries,
  rememberSeenEntries,
  createSeenDwell,
} from "./seen-state";

describe("journal seen entries", () => {
  it("remembers individual entries without marking skipped history seen", () => {
    const seen = rememberSeenEntries(["first"], ["third", "third"]);
    expect(parseSeenEntries(JSON.stringify(seen))).toEqual(["first", "third"]);
    expect(journalSeenKey("host", "thread")).not.toBe(journalSeenKey("dev", "thread"));
    expect(journalSeenKey("a:b", "c")).not.toBe(journalSeenKey("a", "b:c"));
  });
  it("treats absent or malformed storage as unseen", () => {
    for (const value of [null, "broken", "{}", '["one",2]']) {
      expect(parseSeenEntries(value)).toEqual([]);
    }
  });
  it("requires continuous visibility and emits each entry only once", () => {
    const seen: string[] = [];
    const dwell = createSeenDwell((id) => seen.push(id));
    dwell.update("first", true, 0);
    dwell.update("first", true, 799);
    expect(seen).toEqual([]);
    dwell.update("first", false, 800);
    dwell.update("first", true, 1000);
    dwell.update("first", true, 1799);
    expect(seen).toEqual([]);
    dwell.update("first", true, 1800);
    dwell.update("first", true, 3000);
    expect(seen).toEqual(["first"]);
  });
});
