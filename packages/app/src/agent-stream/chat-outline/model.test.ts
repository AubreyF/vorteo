import { describe, expect, it } from "vitest";
import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";
import {
  createActivePromptPublisher,
  findOutlineGroupIndex,
  groupOutlinePrompts,
  promptIndexAfterSeq,
  promptIndexRefreshBase,
  resolvePromptIndexResponse,
  shouldAcceptPromptIndexEpoch,
  promptTickMagnification,
  resolveActivePromptSeq,
  OUTLINE_MAGNIFY_RADIUS,
  type ChatOutlinePrompt,
} from "./model";

describe("chat outline prompt index epoch", () => {
  it("accepts only the authoritative timeline epoch", () => {
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-2")).toBe(true);
    expect(shouldAcceptPromptIndexEpoch("epoch-2", "epoch-1")).toBe(false);
  });
});

function prompt(seq: number): ChatOutlinePrompt {
  return { seq, timestamp: new Date(seq).toISOString(), preview: `prompt ${seq}` };
}

describe("promptTickMagnification", () => {
  it("peaks under the pointer and decays to nothing at the radius", () => {
    expect(promptTickMagnification(0)).toBe(1);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS)).toBe(0);
    expect(promptTickMagnification(OUTLINE_MAGNIFY_RADIUS + 10)).toBe(0);
  });

  it("falls off monotonically and symmetrically around the pointer", () => {
    const above = [0, 1, 2, 3].map((distance) => promptTickMagnification(distance));
    const below = [0, -1, -2, -3].map((distance) => promptTickMagnification(distance));

    expect(above).toEqual(below);
    expect(above).toEqual([...above].sort((left, right) => right - left));
  });
});

describe("resolveActivePromptSeq", () => {
  const prompts = [prompt(2), prompt(9), prompt(20)];

  it("marks the prompt whose turn the reading position sits in", () => {
    expect(resolveActivePromptSeq(prompts, 9)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 14)).toBe(9);
    expect(resolveActivePromptSeq(prompts, 20)).toBe(20);
    expect(resolveActivePromptSeq(prompts, 99)).toBe(20);
  });

  it("marks nothing above the first prompt or without a reading position", () => {
    expect(resolveActivePromptSeq(prompts, 1)).toBeNull();
    expect(resolveActivePromptSeq(prompts, null)).toBeNull();
    expect(resolveActivePromptSeq([], 42)).toBeNull();
  });
});

describe("createActivePromptPublisher", () => {
  it("notifies subscribers only when the active prompt changes", () => {
    const publisher = createActivePromptPublisher();
    let notifications = 0;
    const unsubscribe = publisher.subscribe(() => {
      notifications += 1;
    });

    publisher.publish(9);
    publisher.publish(9);
    publisher.publish(20);
    unsubscribe();
    publisher.publish(null);

    expect(notifications).toBe(2);
    expect(publisher.getActiveSeq()).toBeNull();
  });
});

describe("groupOutlinePrompts", () => {
  const prompts = (count: number) => Array.from({ length: count }, (_, index) => prompt(index * 3));

  it("keeps one mark per prompt while they fit", () => {
    const groups = groupOutlinePrompts(prompts(5), 10);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 1, 1, 1]);
    expect(groups.map((group) => group.first.seq)).toEqual([0, 3, 6, 9, 12]);
  });

  it("bounds the marks for an enormous index and covers every prompt once", () => {
    const groups = groupOutlinePrompts(prompts(100_000), 97);
    expect(groups).toHaveLength(97);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(100_000);
    for (const [index, group] of groups.entries()) {
      expect(group.start).toBe(index === 0 ? 0 : groups[index - 1].start + groups[index - 1].count);
      expect(group.count === 1030 || group.count === 1031).toBe(true);
    }
  });

  it("marks a group as an agent message only when every prompt in it is one", () => {
    const mixed = [
      { ...prompt(1), origin: "agent" as const },
      { ...prompt(2), origin: "agent" as const },
      { ...prompt(3), origin: "agent" as const },
      prompt(4),
    ];
    expect(groupOutlinePrompts(mixed, 2).map((group) => group.isAgentMessage)).toEqual([
      true,
      false,
    ]);
  });

  it("returns nothing for an empty index and at least one mark otherwise", () => {
    expect(groupOutlinePrompts([], 10)).toEqual([]);
    expect(groupOutlinePrompts(prompts(4), 0)).toHaveLength(1);
  });
});

describe("findOutlineGroupIndex", () => {
  const groups = groupOutlinePrompts(
    Array.from({ length: 10 }, (_, index) => prompt(index * 10)),
    3,
  );

  it("finds the group containing a prompt", () => {
    expect(findOutlineGroupIndex(groups, 0)).toBe(0);
    expect(findOutlineGroupIndex(groups, 30)).toBe(1);
    expect(findOutlineGroupIndex(groups, 90)).toBe(2);
  });

  it("returns null outside the index", () => {
    expect(findOutlineGroupIndex(groups, null)).toBeNull();
    expect(findOutlineGroupIndex(groups, -1)).toBeNull();
    expect(findOutlineGroupIndex(groups, 91)).toBeNull();
  });
});

describe("prompt index refresh decisions", () => {
  const index = (epoch: string, seqs: number[]): AgentTimelinePromptIndexPayload => ({
    requestId: "request-1",
    agentId: "agent-1",
    epoch,
    prompts: seqs.map(prompt),
    error: null,
  });

  it("requests the complete index without incremental support, even while holding one", () => {
    const held = index("epoch-1", [1, 2]);
    const base = promptIndexRefreshBase({
      held,
      timelineEpoch: "epoch-1",
      supportsIncrementalIndex: false,
    });
    expect(base).toBeNull();
    expect(promptIndexAfterSeq(base)).toBeUndefined();
  });

  it("extends a held index of the same epoch when the daemon supports it", () => {
    const held = index("epoch-1", [1, 2]);
    const base = promptIndexRefreshBase({
      held,
      timelineEpoch: "epoch-1",
      supportsIncrementalIndex: true,
    });
    expect(base).toBe(held);
    expect(promptIndexAfterSeq(base)).toBe(2);
  });

  it("requests the complete index for another epoch, an empty index or nothing held", () => {
    const refreshFrom = (held: AgentTimelinePromptIndexPayload | null) =>
      promptIndexRefreshBase({ held, timelineEpoch: "epoch-2", supportsIncrementalIndex: true });
    expect(refreshFrom(index("epoch-1", [1, 2]))).toBeNull();
    expect(refreshFrom(index("epoch-2", []))).toBeNull();
    expect(refreshFrom(null)).toBeNull();
  });

  it("replaces the held index with a complete response, dropping prompts it no longer lists", () => {
    const payload = index("epoch-1", [2, 5]);
    const resolution = resolvePromptIndexResponse({
      base: null,
      held: index("epoch-1", [1, 2]),
      payload,
    });
    expect(resolution).toEqual({ kind: "set", index: payload });
  });

  it("appends a suffix response to the base it was requested against", () => {
    const held = index("epoch-1", [1, 2]);
    const resolution = resolvePromptIndexResponse({
      base: held,
      held,
      payload: index("epoch-1", [5]),
    });
    expect(resolution).toEqual({ kind: "set", index: index("epoch-1", [1, 2, 5]) });
  });

  it("rebuilds from a complete fetch when the held index changed during the request", () => {
    const base = index("epoch-1", [1, 2]);
    const resolution = resolvePromptIndexResponse({
      base,
      held: index("epoch-1", [1, 2, 3]),
      payload: index("epoch-1", [5]),
    });
    expect(resolution).toEqual({ kind: "refetch" });
  });
});
