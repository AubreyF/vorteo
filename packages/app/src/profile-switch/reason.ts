import { isQuotaExhaustionMessage } from "@/agent-stream/quota-notice";
import type { StreamItem } from "@/types/stream";

/** A switch is attributed to quota when the thread's latest reply is a quota exhaustion error. */
export function profileSwitchReason(items: readonly StreamItem[]): "manual" | "quota" {
  const latestReply = items.findLast((item) => item.kind === "assistant_message");
  return latestReply?.kind === "assistant_message" && isQuotaExhaustionMessage(latestReply.text)
    ? "quota"
    : "manual";
}
