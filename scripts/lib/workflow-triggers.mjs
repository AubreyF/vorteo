// Reads the `on:` block of a GitHub Actions workflow well enough to tell whether a tag push
// or a published GitHub Release starts it. It reads text because the CI job that runs the
// release tests installs no dependencies. It understands block and flow lists, comments,
// quoted patterns and the push filters; anything it cannot read makes `parseTriggers`
// throw, so a new workflow shape fails the test instead of passing silently.

const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
const stripComment = (line) => line.replace(/\s+#.*$/, "");
const indentOf = (line) => /^ */.exec(line)[0].length;
const isFiller = (line) => !line.trim() || line.trim().startsWith("#");

function parseFlow(value) {
  const text = stripComment(value).trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error(`Unsupported multi-line flow list: ${text}`);
    return text.slice(1, -1).split(",").map(unquote).filter(Boolean);
  }
  if (text.startsWith("{")) throw new Error(`Unsupported flow mapping: ${text}`);
  return [unquote(text)];
}

// The lines nested under `lines[index]`, skipping blank and comment lines.
function childLines(lines, index) {
  const indent = indentOf(lines[index]);
  const children = [];
  for (const line of lines.slice(index + 1)) {
    if (isFiller(line)) continue;
    if (indentOf(line) <= indent) break;
    children.push(stripComment(line));
  }
  return children;
}

// Keys directly under a mapping, each with its inline value and nested lines.
function mapping(lines) {
  if (!lines.length) return {};
  const indent = indentOf(lines[0]);
  const result = {};
  lines.forEach((line, index) => {
    if (indentOf(line) !== indent) return;
    const match = /^\s*(["']?)([\w-]+)\1:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Unsupported workflow trigger line: ${line.trim()}`);
    result[match[2]] = { value: match[3], children: childLines(lines, index) };
  });
  return result;
}

function list(entry) {
  const inline = parseFlow(entry.value);
  if (inline) return inline;
  return entry.children.map((line) => {
    const match = /^\s*-\s*(.+)$/.exec(line);
    if (!match) throw new Error(`Unsupported filter item: ${line.trim()}`);
    return unquote(match[1]);
  });
}

/** Events and push filters from a workflow's source. */
export function parseTriggers(source) {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => /^(["']?)on\1:/.test(line));
  if (index === -1) throw new Error("Workflow has no on: block.");
  const inline = parseFlow(lines[index].replace(/^(["']?)on\1:/, ""));
  if (inline) return Object.fromEntries(inline.map((event) => [event, {}]));
  const events = {};
  for (const [event, entry] of Object.entries(mapping(childLines(lines, index)))) {
    const filters = {};
    // Only push filters decide tag triggers; other events' settings are not needed.
    if (event !== "push") {
      events[event] = filters;
      continue;
    }
    for (const [key, value] of Object.entries(mapping(entry.children))) {
      if (
        ["tags", "tags-ignore", "branches", "branches-ignore", "paths", "paths-ignore"].includes(
          key,
        )
      ) {
        filters[key] = list(value);
      }
    }
    events[event] = filters;
  }
  return events;
}

/**
 * GitHub filter pattern to a regular expression: `*` stops at "/", `**` does not, `?`
 * and `+` quantify the preceding character, `[...]` is a class and `\` escapes.
 */
export function filterRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (char === "?" || char === "+") source += char;
    else if (char === "[") {
      const end = pattern.indexOf("]", index);
      if (end === -1) throw new Error(`Unclosed class in ${pattern}`);
      source += pattern.slice(index, end + 1);
      index = end;
    } else if (char === "\\") {
      source += `\\${pattern[index + 1] ?? "\\"}`;
      index += 1;
    } else source += char.replace(/[.^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Whether a ref name matches a filter list, with later `!` patterns excluding. */
export function matchesFilters(patterns, ref) {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (filterRegex(pattern.slice(1)).test(ref)) matched = false;
    } else if (filterRegex(pattern).test(ref)) matched = true;
  }
  return matched;
}

/** Whether pushing (creating) this tag starts the workflow. */
export function startsOnTag(events, tag) {
  // A chained workflow inherits its trigger's events; treat it as starting on any tag.
  if ("create" in events || "workflow_run" in events) return true;
  const push = events.push;
  if (!push) return false;
  if (push.tags) return matchesFilters(push.tags, tag);
  if (push["tags-ignore"]) return !matchesFilters(push["tags-ignore"], tag);
  // A branch filter without a tag filter limits the push trigger to branches.
  if (push.branches || push["branches-ignore"]) return false;
  return true;
}

const GUARD = "github.repository == 'getpaseo/paseo'";

/**
 * Whether an `if:` condition requires upstream's repository: the guard must be a top-level
 * conjunct, so no `||` outside parentheses can bypass it.
 */
export function requiresUpstream(condition) {
  const text = condition
    .trim()
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*\}\}$/, "");
  let depth = 0;
  const conjuncts = [""];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && text.startsWith("||", index)) return false;
    if (depth === 0 && text.startsWith("&&", index)) {
      conjuncts.push("");
      index += 1;
      continue;
    }
    conjuncts[conjuncts.length - 1] += char;
  }
  return conjuncts.some((part) => part.trim() === GUARD);
}

/** Job names and whether each job's own `if:` requires upstream's repository. */
export function jobGuards(source) {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (index === -1) return [];
  return Object.entries(mapping(childLines(lines, index))).map(([name, entry]) => {
    // Only the job's own if: guards the job; a step's if: guards one step.
    const ownIndent = entry.children.length ? indentOf(entry.children[0]) : 0;
    return {
      name,
      upstreamOnly: entry.children.some((line) => {
        const match = /^\s*if:\s*(.+)$/.exec(line);
        return indentOf(line) === ownIndent && Boolean(match) && requiresUpstream(match[1]);
      }),
    };
  });
}
