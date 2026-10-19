import { z } from "zod";
import { AgentTimelineEntryPayloadSchema } from "@getpaseo/protocol/messages";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";

const TurnSchema = z.object({
  agentId: z.string(),
  messageId: z.string().min(1).max(200),
  text: z.string().min(1).max(10_000),
  reply: z.string().max(30_000),
  timestamp: z.string().datetime(),
});
const SnapshotSchema = z.object({ version: z.literal(1), turns: z.array(TurnSchema).max(200) });
export type DemoConversationSnapshot = z.infer<typeof SnapshotSchema>;
export interface DemoConversationPersistence {
  load(): unknown;
  save(snapshot: DemoConversationSnapshot): void;
}

/** Authored demo responses, never model output or a claim that work was executed. */
export function demoReply(input: {
  text: string;
  title: string;
  tasks: AgentTaskItem[];
  files: string[];
}): string {
  const heading = `**Simulated reply**\n\nThis is a scripted preview of ${input.title}.`;
  if (/\b(theme|appearance|color|colour)\b/i.test(input.text)) {
    return `${heading}\n\nOpen the sidebar's three-dot menu to try Starship, Dark Star, Scriptorium, Midas, Ember or Neon. The same sample workspace stays open while you compare them.`;
  }
  if (/\b(file|files|change|changes|diff)\b/i.test(input.text)) {
    return `${heading}\n\n${input.files.length ? `Sample files with changes:\n${input.files.map((path) => `- ${path}`).join("\n")}` : "There are no changes in this sample workspace."}\n\nOpen Files to edit a sample or Changes to inspect its diff. These edits stay in this browser tab.`;
  }
  const remaining = input.tasks.filter((task) => !task.completed);
  return `${heading}\n\n${remaining.length ? `Remaining sample tasks:\n${remaining.map((task) => `- ${task.text} (${task.status ?? "pending"})`).join("\n")}` : "All sample tasks are complete."}\n\nYou can edit the Tasks card to change this summary. No model, command or real project is running.`;
}

export class DemoConversationState {
  private turns: DemoConversationSnapshot["turns"] = [];
  constructor(
    private readonly agentIds: Set<string>,
    private readonly persistence?: DemoConversationPersistence,
  ) {
    try {
      const saved = persistence?.load();
      if ((JSON.stringify(saved)?.length ?? 0) > 1_048_576) return;
      const parsed = SnapshotSchema.safeParse(saved);
      if (!parsed.success) return;
      const keys = new Set<string>();
      for (const turn of parsed.data.turns) {
        const key = JSON.stringify([turn.agentId, turn.messageId]);
        if (!agentIds.has(turn.agentId) || keys.has(key)) return;
        keys.add(key);
      }
      this.turns = parsed.data.turns;
    } catch {
      /* Unavailable demo storage starts from the authored conversation. */
    }
  }

  append(turn: DemoConversationSnapshot["turns"][number]): boolean {
    if (!this.agentIds.has(turn.agentId)) throw new Error("Demo thread not found.");
    const previous = this.turns.find(
      (entry) => entry.agentId === turn.agentId && entry.messageId === turn.messageId,
    );
    if (previous) {
      if (previous.text !== turn.text)
        throw new Error("This message ID already belongs to a different demo message.");
      return false;
    }
    const next = SnapshotSchema.safeParse({ version: 1, turns: [...this.turns, turn] });
    if (!next.success || JSON.stringify(next.data).length > 1_048_576)
      throw new Error("The demo conversation limit was reached. Reset the demo to start again.");
    this.save(next.data);
    this.turns = next.data.turns;
    return true;
  }

  entries(agentId: string, startSeq: number) {
    return this.turns
      .filter((turn) => turn.agentId === agentId)
      .flatMap((turn, index) =>
        [
          { type: "user_message", text: turn.text, clientMessageId: turn.messageId },
          {
            type: "assistant_message",
            text: turn.reply,
            messageId: `demo-reply-${turn.messageId}`,
          },
        ].map((item, offset) => {
          const seq = startSeq + index * 2 + offset;
          return AgentTimelineEntryPayloadSchema.parse({
            provider: "demo",
            item,
            timestamp: turn.timestamp,
            seqStart: seq,
            seqEnd: seq,
            sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
            collapsed: [],
          });
        }),
      );
  }

  reset(): void {
    this.save({ version: 1, turns: [] });
    this.turns = [];
  }
  private save(snapshot: DemoConversationSnapshot) {
    try {
      this.persistence?.save(snapshot);
    } catch {
      throw new Error(
        "The demo could not save this conversation in browser storage. Check available space and storage access, then retry.",
      );
    }
  }
}
