#!/usr/bin/env node
// Compares the checked-in GitHub rulesets in .github/rulesets with the repository and,
// with --apply, creates or updates them by name. Applying changes GitHub settings: run it
// only from Vorteo :: Builds with the owner's recorded approval (docs/release.md).
// Usage: node scripts/sync-github-rulesets.mjs [--apply] [--repo owner/name] [--remote origin]
// Exit status 0 means in sync (or applied); 1 means drift or a refusal.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, repositoryRoot } from "./lib/delivery-git.mjs";
import { ghJson, resolveRepository, RULESET_DIRECTORY, runGh } from "./lib/github.mjs";
import { isMainModule } from "./is-main-module.mjs";
import { assertBuildsCoordinator } from "./lib/builds-guard.mjs";

const COMPARED_FIELDS = ["target", "enforcement", "bypass_actors", "conditions", "rules"];

/** Rejects rulesets that would weaken the delivery rules or touch upstream's v* tags. */
export function validateRuleset(ruleset, file) {
  const fail = (message) => {
    throw new Error(`${file}: ${message}`);
  };
  if (typeof ruleset?.name !== "string" || !ruleset.name.startsWith("Vorteo ")) {
    fail("name must begin with Vorteo.");
  }
  if (!["branch", "tag"].includes(ruleset.target)) fail("target must be branch or tag.");
  if (ruleset.enforcement !== "active") fail("enforcement must be active.");
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length) {
    fail("rulesets have no bypass actors.");
  }
  const types = new Set((ruleset.rules ?? []).map((rule) => rule.type));
  if (ruleset.target === "tag") validateTagRules(ruleset, types, fail);
  else validateBranchRules(ruleset, types, fail);
  return ruleset;
}

function validateTagRules(ruleset, types, fail) {
  const include = ruleset.conditions?.ref_name?.include ?? [];
  if (JSON.stringify(include) !== JSON.stringify(["refs/tags/release-*"])) {
    fail("release tag rulesets cover exactly refs/tags/release-*.");
  }
  if (!types.has("update") || !types.has("deletion")) fail("release tags must be immutable.");
}

function validateBranchRules(ruleset, types, fail) {
  for (const type of ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]) {
    if (!types.has(type)) fail(`branch rulesets need the ${type} rule.`);
  }
  const pullRequest = ruleset.rules.find((rule) => rule.type === "pull_request").parameters;
  if (JSON.stringify(pullRequest?.allowed_merge_methods) !== JSON.stringify(["merge"])) {
    fail("allow merge commits only, so installed commits stay in main's history.");
  }
  const checks = ruleset.rules.find((rule) => rule.type === "required_status_checks").parameters;
  if (!checks?.strict_required_status_checks_policy || !checks.required_status_checks?.length) {
    fail("require at least one check on a branch that is up to date with its base.");
  }
}

export function loadRulesets(root) {
  const directory = path.join(root, RULESET_DIRECTORY);
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) =>
      validateRuleset(JSON.parse(readFileSync(path.join(directory, file), "utf8")), file),
    );
}

/** True when every value in `expected` appears in `actual`; GitHub adds defaulted fields. */
export function contains(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => contains(actual[index], item))
    );
  }
  if (expected && typeof expected === "object") {
    return (
      Boolean(actual) &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => contains(actual[key], value))
    );
  }
  return actual === expected;
}

/** Rules match by type, in any order: GitHub need not return them as submitted. */
export function sameRules(actual = [], expected = []) {
  return (
    actual.length === expected.length &&
    expected.every((rule) =>
      contains(
        actual.find((entry) => entry.type === rule.type),
        rule,
      ),
    )
  );
}

/** Plans one create or update per drifted ruleset. */
export function planSync(desired, existing) {
  return desired.flatMap((ruleset) => {
    const current = existing.find((entry) => entry.name === ruleset.name);
    if (!current) return [{ action: "create", ruleset }];
    const inSync = COMPARED_FIELDS.every((field) =>
      field === "rules"
        ? sameRules(current.rules, ruleset.rules)
        : contains(current[field], ruleset[field]),
    );
    return inSync ? [] : [{ action: "update", id: current.id, ruleset }];
  });
}

export function fetchRulesets(gh, repository) {
  const summaries = ghJson(gh, ["api", `repos/${repository}/rulesets`]) ?? [];
  return summaries.map((summary) =>
    ghJson(gh, ["api", `repos/${repository}/rulesets/${summary.id}`]),
  );
}

export function applySync(gh, repository, plan) {
  for (const step of plan) {
    const endpoint =
      step.action === "create"
        ? `repos/${repository}/rulesets`
        : `repos/${repository}/rulesets/${step.id}`;
    gh(["api", "--method", step.action === "create" ? "POST" : "PUT", endpoint, "--input", "-"], {
      input: JSON.stringify(step.ruleset),
    });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ["apply"], options: ["repo", "remote"] });
  const root = repositoryRoot(process.cwd());
  const repository = resolveRepository({ root, remote: args.remote, explicit: args.repo });
  const desired = loadRulesets(root);
  const plan = planSync(desired, fetchRulesets(runGh, repository));
  if (!plan.length) {
    console.log(`${repository}: ${desired.map((entry) => entry.name).join(", ")} in sync.`);
    return;
  }
  for (const step of plan) console.log(`${step.action}: ${step.ruleset.name}`);
  if (!args.apply) {
    console.log("Drift found. Applying needs the owner's approval and --apply from Builds.");
    process.exitCode = 1;
    return;
  }
  assertBuildsCoordinator("Applying GitHub rulesets");
  applySync(runGh, repository, plan);
  const remaining = planSync(desired, fetchRulesets(runGh, repository));
  if (remaining.length) {
    throw new Error(
      `Still drifting after apply: ${remaining.map((s) => s.ruleset.name).join(", ")}`,
    );
  }
  console.log(`Applied and verified on ${repository}.`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
