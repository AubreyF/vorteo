import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { git } from "./delivery-git.mjs";

// Shared GitHub access for pull request delivery, release tags and ruleset sync.
// Every call names the repository: in a fork, gh otherwise resolves the parent
// (upstream Paseo), not this repository.

/** Runs gh and returns stdout. Tests pass their own runner with the same signature. */
export function runGh(args, { input } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    throw new Error(`gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
  }
}

export function ghJson(gh, args, options) {
  const output = gh(args, options);
  return output ? JSON.parse(output) : null;
}

/** `owner/name` from a GitHub remote URL, or null for other hosts. */
export function parseGitHubRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url ?? "");
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The repository a remote points at, following GitHub renames (the Vorteo repository
 * was renamed from AubreyF/paseo). `explicit` wins when given.
 */
export function resolveRepository({ root, remote = "origin", explicit, gh = runGh }) {
  if (explicit) return explicit;
  const parsed = parseGitHubRemote(git(root, ["remote", "get-url", remote]));
  if (!parsed) throw new Error(`${remote} is not a GitHub remote; pass --repo owner/name.`);
  return ghJson(gh, ["api", `repos/${parsed}`, "--jq", "{full_name}"]).full_name;
}

export const RULESET_DIRECTORY = path.join(".github", "rulesets");

/** Checked-in ruleset for `main`, the single source of the required check list. */
export function readMainRuleset(root) {
  return JSON.parse(readFileSync(path.join(root, RULESET_DIRECTORY, "main.json"), "utf8"));
}

/** Required check names; an empty list is a configuration error, never a pass. */
export function requiredChecks(ruleset) {
  const rule = ruleset.rules.find((entry) => entry.type === "required_status_checks");
  const names = (rule?.parameters.required_status_checks ?? []).map((check) => check.context);
  if (!names.length) throw new Error("The main ruleset lists no required checks.");
  return names;
}

/** The single app that must report every required check (GitHub Actions is 15368). */
export function requiredCheckApp(ruleset) {
  const rule = ruleset.rules.find((entry) => entry.type === "required_status_checks");
  const apps = new Set(rule.parameters.required_status_checks.map((check) => check.integration_id));
  if (apps.size !== 1 || [...apps][0] === undefined) {
    throw new Error("Required checks must all name one integration_id.");
  }
  return [...apps][0];
}

/**
 * Summarizes required checks for one commit from its check runs. The newest run per
 * name decides, as on GitHub. Only success passes. A job skipped by CI's path filter
 * satisfies the requirement, as GitHub's ruleset does, but is listed as skipped so it
 * is never reported as validation. Any other conclusion, including cancelled and
 * neutral, fails: it is not evidence, and a rerun produces a newer run.
 */
export function summarizeChecks(checkRuns, required) {
  const latest = new Map();
  for (const run of checkRuns) {
    const previous = latest.get(run.name);
    if (!previous || run.id > previous.id) latest.set(run.name, run);
  }
  const passed = [];
  const skipped = [];
  const pending = [];
  const failed = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run || run.status !== "completed") pending.push(name);
    else if (run.conclusion === "success") passed.push(name);
    else if (run.conclusion === "skipped") skipped.push(name);
    else failed.push(`${name} (${run.conclusion})`);
  }
  return { passed, skipped, pending, failed };
}

export function checkRunsFor(gh, repository, sha) {
  // One JSON object per line, so pagination concatenates cleanly.
  const output = gh([
    "api",
    "--paginate",
    `repos/${repository}/commits/${sha}/check-runs?per_page=100`,
    "--jq",
    ".check_runs[] | {id, name, status, conclusion, app: .app.id}",
  ]);
  return output ? output.split("\n").map((line) => JSON.parse(line)) : [];
}
