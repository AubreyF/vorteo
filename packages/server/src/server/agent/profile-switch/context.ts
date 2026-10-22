import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { isSystemInjectedEnvelope } from "../agent-prompt.js";

// Matches the reviewed successor handoff so both carry the same bounded context.
const MAX_MESSAGES = 30;
const MAX_CHARACTERS = 50_000;

/** Uses recorded text only; an exhausted account is never asked to summarize itself. */
export function readRecordedContext(items: readonly AgentTimelineItem[]): string {
  const messages = items.flatMap((item) => {
    if (item.type === "assistant_message") return [`assistant_message:\n${item.text}`];
    if (item.type === "user_message" && !isSystemInjectedEnvelope(item.text))
      return [`user_message:\n${item.text}`];
    return [];
  });
  return messages.slice(-MAX_MESSAGES).join("\n\n").slice(-MAX_CHARACTERS);
}

export interface SwitchInstructionsInput {
  from: string;
  to: string;
  context: string;
}

/**
 * Carried as session instructions rather than a prompt, so switching starts no
 * turn and the context stays out of the visible conversation.
 */
export function formatSwitchInstructions({ from, to, context }: SwitchInstructionsInput): string {
  const intro =
    `This thread moved from ${from} to ${to}, and you are continuing it in a new session. ` +
    `Attachments, tool results and provider-private state from the earlier session were not carried over. ` +
    `The thread's goal, checklist, journal and open questions remain available through Vorteo tools. ` +
    `Review the working tree before changing anything, and ask for missing context when necessary.`;
  if (!context) return intro;
  return (
    `${intro} The recorded context below holds up to ${MAX_MESSAGES} recent messages from the earlier session.\n\n` +
    `<recorded-context>\n${context}\n</recorded-context>`
  );
}
