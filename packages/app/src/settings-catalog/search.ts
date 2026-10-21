/**
 * Ranks settings for a search query, using the shared text matcher so settings
 * search forgives the same typos as the pickers and history search.
 *
 * Fields carry different weight: a hit on the row label beats a keyword hit,
 * which beats words spread across the label, keywords, hint and the pane or
 * section title. Within a tier, the shared matcher's order applies: exact,
 * whole word, prefix, word start, substring, then a typo.
 */
import {
  compareMatchScores,
  matchRanges,
  scoreMatch,
  scoreTextFields,
  tokenizeQuery,
  type MatchRange,
  type MatchScore,
} from "@getpaseo/protocol/search/text-match";

export interface SearchableSetting {
  id: string;
  pane: string;
  section: string;
  label: string;
  hint?: string;
  keywords?: readonly string[];
  /** Pane and section titles, matched with lower weight than the row itself. */
  context?: readonly string[];
}

export interface SettingsSearchResult<T extends SearchableSetting = SearchableSetting> {
  entry: T;
  /** Marked characters in `entry.label`. */
  labelRanges: MatchRange[];
}

const FIELD_OPTIONS = { typoTolerant: true, subsequence: false } as const;

interface Ranked {
  field: number;
  score: MatchScore;
}

function rank(entry: SearchableSetting, query: string): Ranked | null {
  const label = scoreTextFields(query, [entry.label], FIELD_OPTIONS);
  if (label) return { field: 0, score: label };
  const keywords = entry.keywords ?? [];
  const keyword = keywords.length ? scoreTextFields(query, [...keywords], FIELD_OPTIONS) : null;
  if (keyword) return { field: 1, score: keyword };
  const fields = [entry.label, ...keywords, entry.hint ?? "", ...(entry.context ?? [])];
  const anywhere = scoreTextFields(query, fields, FIELD_OPTIONS);
  return anywhere ? { field: 2, score: anywhere } : null;
}

/** Characters in `label` that any query word matched, merged and in order. */
export function labelMatchRanges(label: string, query: string): MatchRange[] {
  const marked = new Set<number>();
  for (const token of tokenizeQuery(query)) {
    const score = scoreMatch(token, label, { subsequence: false });
    if (!score) continue;
    for (const range of matchRanges(token, label, score)) {
      for (let index = range.start; index < range.start + range.length; index += 1) {
        marked.add(index);
      }
    }
  }
  const ranges: MatchRange[] = [];
  for (const index of [...marked].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last.start + last.length === index) last.length += 1;
    else ranges.push({ start: index, length: 1 });
  }
  return ranges;
}

/**
 * Matching settings, best first. Ties keep catalog order so the result list
 * reads in the same order as the page.
 */
export function searchSettings<T extends SearchableSetting>(
  entries: readonly T[],
  query: string,
  limit = 50,
): SettingsSearchResult<T>[] {
  if (tokenizeQuery(query).length === 0) return [];
  return entries
    .map((entry, index) => ({ entry, index, ranked: rank(entry, query) }))
    .filter((result): result is typeof result & { ranked: Ranked } => result.ranked !== null)
    .sort(
      (a, b) =>
        a.ranked.field - b.ranked.field ||
        compareMatchScores(a.ranked.score, b.ranked.score) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ entry }) => ({ entry, labelRanges: labelMatchRanges(entry.label, query) }));
}
