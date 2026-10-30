import type { AgentTimelinePromptIndexPayload } from "@getpaseo/client/internal/daemon-client";

export type ChatOutlinePrompt = AgentTimelinePromptIndexPayload["prompts"][number];

export function shouldAcceptPromptIndexEpoch(timelineEpoch: string, indexEpoch: string): boolean {
  return timelineEpoch === indexEpoch;
}

type PromptIndex = AgentTimelinePromptIndexPayload;

/**
 * The index a refresh extends, or null for a full fetch. Only a daemon advertising
 * incremental reads, holding a non-empty index for the same epoch, gets a suffix request;
 * a permanent thread would otherwise resend its whole history on every new prompt.
 */
export function promptIndexRefreshBase(input: {
  held: PromptIndex | null;
  timelineEpoch: string;
  supportsIncrementalIndex: boolean;
}): PromptIndex | null {
  const { held, timelineEpoch, supportsIncrementalIndex } = input;
  return supportsIncrementalIndex && held?.epoch === timelineEpoch && held.prompts.length > 0
    ? held
    : null;
}

/** The position a refresh asks for prompts after; undefined requests the complete index. */
export function promptIndexAfterSeq(base: PromptIndex | null): number | undefined {
  return base?.prompts.at(-1)?.seq;
}

export type PromptIndexResolution = { kind: "set"; index: PromptIndex } | { kind: "refetch" };

/**
 * Applies an accepted response. A full fetch replaces the held index outright. A suffix
 * extends the base it was requested against, unless the held index changed underneath
 * the request, in which case the caller rebuilds it from a full fetch.
 */
export function resolvePromptIndexResponse(input: {
  base: PromptIndex | null;
  held: PromptIndex | null;
  payload: PromptIndex;
}): PromptIndexResolution {
  const { base, held, payload } = input;
  if (!base) return { kind: "set", index: payload };
  if (held !== base) return { kind: "refetch" };
  return { kind: "set", index: { ...payload, prompts: [...base.prompts, ...payload.prompts] } };
}

/**
 * Slots further than this from the pointer keep their resting size, so a long rail
 * magnifies a local band instead of swelling the whole column.
 */
export const OUTLINE_MAGNIFY_RADIUS = 3;

/**
 * Dock-style falloff: 1 under the pointer, easing to 0 at the radius. The raised cosine
 * has no corner at either end, so sweeping the rail reads as one bulge travelling with
 * the pointer rather than a band switching on and off.
 */
export function promptTickMagnification(slotDistance: number): number {
  const distance = Math.abs(slotDistance);
  if (!Number.isFinite(distance) || distance >= OUTLINE_MAGNIFY_RADIUS) {
    return 0;
  }
  return (1 + Math.cos((Math.PI * distance) / OUTLINE_MAGNIFY_RADIUS)) / 2;
}

/**
 * The prompt whose turn the reader is inside: the last indexed prompt at or before the
 * timeline position under the top of the viewport. It reads the complete daemon index,
 * so a prompt outside the loaded window still lights up while its turn is on screen.
 */
export function resolveActivePromptSeq(
  prompts: readonly ChatOutlinePrompt[],
  anchorSeq: number | null,
): number | null {
  if (anchorSeq === null) {
    return null;
  }
  let activeSeq: number | null = null;
  for (const prompt of prompts) {
    if (prompt.seq > anchorSeq) {
      break;
    }
    activeSeq = prompt.seq;
  }
  return activeSeq;
}

export interface ActivePromptSource {
  subscribe: (listener: () => void) => () => void;
  getActiveSeq: () => number | null;
}

export interface ActivePromptPublisher extends ActivePromptSource {
  publish: (seq: number | null) => void;
}

/**
 * The transcript reports its reading position on every scroll frame, far more often than
 * it re-renders. Keeping the active prompt outside React lets the rail subscribe to it
 * without dragging the transcript through a render on each frame.
 */
export function createActivePromptPublisher(): ActivePromptPublisher {
  const listeners = new Set<() => void>();
  let activeSeq: number | null = null;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActiveSeq: () => activeSeq,
    publish(seq) {
      if (seq === activeSeq) {
        return;
      }
      activeSeq = seq;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/**
 * One rail mark. It stands for a single prompt while the rail has room, and for a run of
 * consecutive prompts once a long conversation outgrows it.
 */
export interface ChatOutlineGroup {
  /** The mark's position on the rail, oldest first. */
  slot: number;
  /** Index of the group's first prompt in the complete index. */
  start: number;
  /** Number of prompts the mark stands for. */
  count: number;
  /** The prompt a click jumps to and the preview describes: the group's first. */
  first: ChatOutlinePrompt;
  last: ChatOutlinePrompt;
  /** True only when every prompt in the group was sent by another agent. */
  isAgentMessage: boolean;
}

/**
 * Splits the index into at most `maxMarks` runs of near-equal length, oldest first. The
 * rail renders one interactive mark per run, so its cost stays bounded by the rail's
 * height however long a permanent thread grows. Runs split by count rather than by time:
 * a quiet week would otherwise become a column of empty marks.
 */
export function groupOutlinePrompts(
  prompts: readonly ChatOutlinePrompt[],
  maxMarks: number,
): ChatOutlineGroup[] {
  const total = prompts.length;
  if (total === 0) return [];
  const marks = Math.max(1, Math.min(total, Math.floor(maxMarks)));
  const groups: ChatOutlineGroup[] = [];
  for (let mark = 0; mark < marks; mark += 1) {
    const start = Math.floor((mark * total) / marks);
    const end = Math.floor(((mark + 1) * total) / marks);
    let isAgentMessage = true;
    for (let index = start; index < end; index += 1) {
      if (prompts[index].origin !== "agent") {
        isAgentMessage = false;
        break;
      }
    }
    groups.push({
      slot: mark,
      start,
      count: end - start,
      first: prompts[start],
      last: prompts[end - 1],
      isAgentMessage,
    });
  }
  return groups;
}

/** The group holding `seq`, found by binary search over the groups' first prompts. */
export function findOutlineGroupIndex(
  groups: readonly ChatOutlineGroup[],
  seq: number | null,
): number | null {
  if (seq === null || groups.length === 0 || seq < groups[0].first.seq) return null;
  let low = 0;
  let high = groups.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (groups[middle].first.seq <= seq) low = middle;
    else high = middle - 1;
  }
  return seq <= groups[low].last.seq ? low : null;
}
