import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
  origin?: "agent";
}

export interface TimelinePromptIndex {
  epoch: string;
  prompts: TimelinePromptIndexEntry[];
}

function promptPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

/**
 * Prompts in timeline order. With `afterSeq`, only prompts after that position: a client
 * that already holds the index fetches what arrived since instead of the whole history.
 * Prompt rows keep their sequence once appended, so the suffix extends the earlier index.
 */
export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
  afterSeq?: number,
): TimelinePromptIndex {
  return {
    epoch,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message" && (afterSeq === undefined || row.seq > afterSeq)
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(row.item.text),
              ...(row.item.origin ? { origin: row.item.origin } : {}),
            },
          ]
        : [],
    ),
  };
}
