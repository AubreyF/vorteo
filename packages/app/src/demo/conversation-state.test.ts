import { expect, it } from "vitest";
import {
  DemoConversationState,
  demoReply,
  type DemoConversationSnapshot,
} from "./conversation-state";

const turn = {
  agentId: "demo-agent",
  messageId: "message-1",
  text: "What remains?",
  reply: "Simulated reply",
  timestamp: "2026-10-01T12:00:00.000Z",
};
it("restores conversation entries and deduplicates retries across reload", () => {
  let saved: DemoConversationSnapshot | null = null;
  const persistence = {
    load: () => saved,
    save: (value: DemoConversationSnapshot) => {
      saved = value;
    },
  };
  const first = new DemoConversationState(new Set([turn.agentId]), persistence);
  expect(first.append(turn)).toBe(true);
  const restored = new DemoConversationState(new Set([turn.agentId]), persistence);
  expect(restored.append(turn)).toBe(false);
  expect(() => restored.append({ ...turn, text: "Different message" })).toThrow(
    "different demo message",
  );
  expect(restored.entries(turn.agentId, 5).map((entry) => entry.seqStart)).toEqual([5, 6]);
  restored.reset();
  expect(
    new DemoConversationState(new Set([turn.agentId]), persistence).entries(turn.agentId, 5),
  ).toEqual([]);
});
it("rejects invalid restored identities and preserves prior state after failed persistence", () => {
  const invalid = new DemoConversationState(new Set([turn.agentId]), {
    load: () => ({ version: 1, turns: [{ ...turn, agentId: "real-agent" }] }),
    save: () => {},
  });
  expect(invalid.entries("real-agent", 5)).toEqual([]);
  let failed = true;
  const state = new DemoConversationState(new Set([turn.agentId]), {
    load: () => null,
    save: () => {
      if (failed) throw new Error("quota");
    },
  });
  expect(() => state.append(turn)).toThrow("browser storage");
  expect(state.entries(turn.agentId, 5)).toEqual([]);
  failed = false;
  expect(state.append(turn)).toBe(true);
});
it("labels authored replies and reflects the current sample checklist and diffs", () => {
  const context = {
    title: "Atlas",
    tasks: [{ text: "Review screenshots", completed: false, status: "review" as const }],
    files: ["README.md"],
  };
  expect(demoReply({ ...context, text: "What remains?" })).toContain("Review screenshots (review)");
  expect(demoReply({ ...context, text: "Show changes" })).toContain("README.md");
  expect(demoReply({ ...context, text: "Change theme" })).toContain("Simulated reply");
  expect(demoReply({ ...context, text: "Run a command" })).toContain(
    "No model, command or real project is running.",
  );
});
