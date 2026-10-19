import { describe, expect, it } from "vitest";
import {
  journalViewKey,
  latestJournalSequence,
  parseClearedThrough,
  visibleJournalEntries,
} from "./view-state";

const entry = (sequence: number, timestamp = "2026-10-09T12:00:00Z") => ({
  id: String(sequence),
  sequence,
  timestamp,
  text: `Entry ${sequence}`,
});

describe("journal clear view", () => {
  it("retains history and shows entries appended after the cleared snapshot", () => {
    const before = [entry(1), entry(2)];
    const cleared = latestJournalSequence(before);
    const after = [...before, entry(3, "2026-10-08T12:00:00Z")];
    expect(visibleJournalEntries(after, cleared)).toEqual([after[2]]);
    expect(visibleJournalEntries(after, 0)).toEqual(after);
    expect(before).toHaveLength(2);
  });
  it("retains a clear boundary across reload and duplicate delivery", () => {
    const cleared = parseClearedThrough(String(latestJournalSequence([entry(1), entry(2)])));
    expect(visibleJournalEntries([entry(1), entry(2)], cleared)).toEqual([]);
  });
  it("isolates environments and threads without delimiter collisions", () => {
    expect(journalViewKey("a:b", "c")).not.toBe(journalViewKey("a", "b:c"));
    expect(journalViewKey("host", "same")).not.toBe(journalViewKey("dev", "same"));
  });
  it("shows history if saved view state is invalid", () => {
    for (const value of [null, "bad", "-1", "1.5", "Infinity", "9007199254740992"]) {
      expect(parseClearedThrough(value)).toBe(0);
    }
  });
});
