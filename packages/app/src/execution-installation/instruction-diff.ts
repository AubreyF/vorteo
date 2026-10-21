export interface InstructionDiffLine {
  kind: "added" | "removed";
  text: string;
}

const MAX_CELLS = 4_000_000;

/**
 * Lines removed from and added to the shared instructions, in document order. Owners review
 * this before the full texts, so a deleted line in a long prompt is not missed.
 */
export function diffInstructionLines(current: string, proposed: string): InstructionDiffLine[] {
  let before = current.split("\n");
  let after = proposed.split("\n");
  // Most edits are local: align only the differing middle so long prompts stay readable.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  before = before.slice(start, before.length - end);
  after = after.slice(start, after.length - end);
  if (before.length * after.length > MAX_CELLS) {
    // Too large for a line alignment: show everything as replaced rather than guess.
    return [
      ...before.map((text) => ({ kind: "removed" as const, text })),
      ...after.map((text) => ({ kind: "added" as const, text })),
    ];
  }
  // Longest common subsequence over lines, filled from the end.
  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        before[i] === after[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  const lines: InstructionDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      lines.push({ kind: "removed", text: before[i++] });
    } else {
      lines.push({ kind: "added", text: after[j++] });
    }
  }
  while (i < before.length) lines.push({ kind: "removed", text: before[i++] });
  while (j < after.length) lines.push({ kind: "added", text: after[j++] });
  return lines;
}
