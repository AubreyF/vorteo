import { describe, expect, it } from "vitest";
import { attentionKind, hasImportantChange } from "./observer.js";

const baseline = {
  previousTimestamp: "2026-10-07T12:00:00Z",
  attentionTimestamp: "2026-10-07T12:00:00Z",
  attentionReason: "finished" as const,
  previouslyObserved: true,
  createdAt: "2026-10-01T12:00:00Z",
  monitoringStartedAt: "2026-10-07T00:00:00Z",
  gap: false,
};

describe("relevant notifications", () => {
  it("does not report an old completion again when a thread's other fields change", () => {
    expect(hasImportantChange(baseline)).toBe(false);
    expect(
      hasImportantChange({
        ...baseline,
        attentionReason: null,
        attentionTimestamp: "2026-10-07T12:01:00Z",
      }),
    ).toBe(false);
  });

  it("reports fresh completion and permission requests", () => {
    expect(hasImportantChange({ ...baseline, attentionTimestamp: "2026-10-07T12:01:00Z" })).toBe(
      true,
    );
    expect(
      hasImportantChange({
        ...baseline,
        attentionReason: "permission",
        attentionTimestamp: "2026-10-07T12:01:00Z",
      }),
    ).toBe(true);
    expect(attentionKind("permission", false)).toBe("permission");
  });

  it("catches a new task that completed while disconnected without importing old history as new work", () => {
    expect(
      hasImportantChange({
        ...baseline,
        attentionTimestamp: "2026-10-01T12:00:00Z",
        previouslyObserved: false,
        previousTimestamp: null,
      }),
    ).toBe(false);
    expect(
      hasImportantChange({
        ...baseline,
        previouslyObserved: false,
        previousTimestamp: null,
        createdAt: "2026-10-07T11:00:00Z",
      }),
    ).toBe(true);
  });

  it("reports missing history without claiming the task completed", () => {
    expect(hasImportantChange({ ...baseline, gap: true })).toBe(true);
    expect(attentionKind("finished", true)).toBe("gap");
  });
});
