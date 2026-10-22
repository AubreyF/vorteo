import { z } from "zod";
import {
  AgentTimelineItemPayloadSchema,
  ProfileSwitchTimelineItemSchema,
} from "@getpaseo/protocol/messages";
import type { AgentStreamEvent, AgentProvider } from "../agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";

export const ProfileSwitchRecordSchema = z.object({
  switchedAt: z.string(),
  marker: ProfileSwitchTimelineItemSchema,
});
export type ProfileSwitchRecord = z.infer<typeof ProfileSwitchRecordSchema>;

/**
 * Provider history covers only the current native session, which lives in the
 * current account's home. Everything the thread showed before its latest switch,
 * ending with that switch's marker, is retained here and replayed first.
 */
export const SwitchHistorySchema = z.object({
  switchId: z.string(),
  events: z.array(
    z.object({
      timestamp: z.string(),
      turnId: z.string().optional(),
      item: AgentTimelineItemPayloadSchema,
    }),
  ),
});
export type SwitchHistory = z.infer<typeof SwitchHistorySchema>;

export function buildSwitchHistory(
  rows: readonly AgentTimelineRow[],
  record: ProfileSwitchRecord,
): SwitchHistory {
  const events = rows.map((row) => ({
    timestamp: row.timestamp,
    ...(row.turnId ? { turnId: row.turnId } : {}),
    item: row.item,
  }));
  events.push({ timestamp: record.switchedAt, item: record.marker });
  return { switchId: record.marker.switchId, events };
}

export async function* prependSwitchHistory(
  retained: SwitchHistory | null,
  provider: AgentProvider,
  history: AsyncIterable<AgentStreamEvent> | Iterable<AgentStreamEvent>,
): AsyncGenerator<AgentStreamEvent> {
  for (const event of retained?.events ?? []) {
    yield {
      type: "timeline",
      provider,
      timestamp: event.timestamp,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      item: event.item,
    };
  }
  yield* history;
}
