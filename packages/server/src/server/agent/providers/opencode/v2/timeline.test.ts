import type { SessionMessageAssistant } from "@opencode/client";
import { expect, test } from "vitest";
import { V2Timeline } from "./timeline.js";

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

test("a completed edit carries the replaced and replacement text", () => {
  // Captured from OpenCode 2.0.18, whose edit tool takes `path` instead of `filePath`.
  const edit = assistant([
    {
      type: "tool",
      id: "call-edit",
      name: "edit",
      executed: false,
      state: {
        status: "completed",
        input: { path: "a.txt", oldString: "beta", newString: "BETA" },
        content: [{ type: "text", text: "Edited a.txt (1 replacement)" }],
        metadata: {
          files: [
            {
              file: "a.txt",
              patch:
                "Index: a.txt\n===================================================================\n--- a.txt\n+++ a.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n",
              status: "modified",
              additions: 1,
              deletions: 1,
            },
          ],
          truncated: false,
        },
      },
      time: { created: 2, ran: 2, completed: 2 },
    },
  ]);

  expect(new V2Timeline().messages([edit])).toMatchObject([
    {
      item: {
        type: "tool_call",
        name: "edit",
        status: "completed",
        detail: { type: "edit", filePath: "a.txt", oldString: "beta", newString: "BETA" },
      },
    },
  ]);
});

test("keeps the saved OpenCode summary and compaction identity through completion and replay", () => {
  const timeline = new V2Timeline();
  expect(
    timeline.messages([
      {
        id: "compact-1",
        type: "compaction",
        status: "running",
        reason: "manual",
        summary: "",
        recent: "recent",
        time: { created: 1 },
      },
    ]),
  ).toMatchObject([{ item: { type: "compaction", status: "loading", compactionId: "compact-1" } }]);
  const completed = {
    id: "compact-1",
    type: "compaction" as const,
    status: "completed" as const,
    reason: "manual" as const,
    summary: "  Exact summary\n",
    recent: "recent",
    time: { created: 1 },
  };
  const expected = [
    {
      item: {
        type: "compaction",
        status: "completed",
        compactionId: "compact-1",
        trigger: "manual",
        inspection: { summary: { type: "text", text: "  Exact summary\n" } },
      },
    },
  ];
  expect(timeline.messages([completed])).toMatchObject(expected);
  expect(timeline.messages([completed])).toEqual([]);
  expect(new V2Timeline().messages([completed])).toMatchObject(expected);
});
