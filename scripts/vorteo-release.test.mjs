import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  parseGitHubRemote,
  requiredCheckApp,
  requiredChecks,
  summarizeChecks,
} from "./lib/github.mjs";
import { contains, loadRulesets, planSync, validateRuleset } from "./sync-github-rulesets.mjs";
import {
  jobGuards,
  matchesFilters,
  parseTriggers,
  requiresUpstream,
  startsOnTag,
} from "./lib/workflow-triggers.mjs";
import {
  createTag,
  latestFor,
  parseInstalled,
  parseRemoteTags,
  prepareTag,
  releaseNotes,
  tagName,
  versionCounter,
} from "./vorteo-release.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const run = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A bare origin whose main carries versioned commits, and a clone of it.
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vorteo-release-")));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  run(root, "clone", "--quiet", origin, clone);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ]) {
    run(clone, "config", key, value);
  }
  return { root, origin, clone };
}

function versionCommit(clone, counter, { push = true } = {}) {
  const version = `0.11.0-beta.3.vorteo.${counter}`;
  writeFileSync(path.join(clone, "package.json"), `${JSON.stringify({ version })}\n`);
  writeFileSync(
    path.join(clone, "VORTEO_CHANGELOG.md"),
    `# Vorteo changelog\n\n## ${version} - 2026-10-29\n\n- Change ${counter}\n`,
  );
  run(clone, "add", ".");
  run(clone, "commit", "--quiet", "-m", `Version ${counter}`);
  if (push) run(clone, "push", "--quiet", "origin", "HEAD:main");
  return run(clone, "rev-parse", "HEAD");
}

function gitleaksEnv(root) {
  const bin = path.join(root, "gitleaks");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { ...process.env, PASEO_GITLEAKS_BIN: bin };
}

test("tag names carry the channel and the Vorteo counter", () => {
  assert.equal(tagName("beta", 922), "release-922-beta");
  assert.equal(tagName("stable", 922), "release-922");
  assert.equal(versionCounter("0.11.0-beta.3.vorteo.922"), 922);
  assert.equal(versionCounter("0.12.0-vorteo.1000"), 1000);
  assert.equal(versionCounter("0.9.0-beta.2.vorton.40"), 40);
  assert.throws(() => versionCounter("0.11.0"), /no Vorteo counter/);
  assert.equal(parseInstalled("0.11.0-beta.3.vorteo.922"), 922);
  assert.equal(parseInstalled("930"), 930);
  assert.equal(parseInstalled(undefined), 0);
});

test("discovery offers the newest newer tag; beta also follows stable", () => {
  const tags = parseRemoteTags(
    [
      "aaa\trefs/tags/release-900-beta",
      "a1a\trefs/tags/release-900-beta^{}",
      "bbb\trefs/tags/release-900",
      "b1b\trefs/tags/release-900^{}",
      "ccc\trefs/tags/release-950-beta",
      "ddd\trefs/tags/v0.7.2",
      "eee\trefs/tags/release-oops",
    ].join("\n"),
  );
  assert.deepEqual(
    tags.map((tag) => [tag.name, tag.commit]),
    [
      ["release-950-beta", "ccc"],
      ["release-900", "b1b"],
      ["release-900-beta", "a1a"],
    ],
  );
  assert.equal(latestFor(tags, "stable", 899).name, "release-900");
  assert.equal(latestFor(tags, "stable", 900), null);
  assert.equal(latestFor(tags, "beta", 900).name, "release-950-beta");
  assert.equal(latestFor(tags, "beta", 950), null);
  assert.throws(() => latestFor(tags, "nightly"), /beta or stable/);
});

test("release notes cover the changelog entries since the previous tag", () => {
  const changelog = [
    "# Vorteo changelog",
    "## 0.11.0-beta.3.vorteo.12 - 2026-10-29\n\n- Twelve",
    "## 0.11.0-beta.3.vorteo.11 - 2026-10-29\n\n- Eleven",
    "## 0.11.0-beta.3.vorteo.10 - 2026-10-28\n\n- Ten",
  ].join("\n\n");
  const notes = releaseNotes(changelog, 10, 12);
  assert.match(notes, /Twelve[\s\S]*Eleven/);
  assert.doesNotMatch(notes, /Ten/);
  assert.match(releaseNotes(changelog, 0, 12, 1), /And 2 earlier entries/);
});

test("tags go only on main, never repeat, and stable needs beta on the same commit", () => {
  const { root, clone } = fixture();
  const env = gitleaksEnv(root);
  const first = versionCommit(clone, 100);
  assert.throws(() => prepareTag({ cwd: clone, channel: "beta" }), /--commit/);
  assert.throws(
    () => prepareTag({ cwd: clone, channel: "stable", commit: "HEAD" }),
    /needs release-100-beta/,
  );
  const beta = prepareTag({ cwd: clone, channel: "beta", commit: "HEAD" });
  assert.equal(beta.name, "release-100-beta");
  assert.equal(createTag(beta, env).commit, first);
  assert.throws(
    () => prepareTag({ cwd: clone, channel: "beta", commit: "HEAD" }),
    /permanent; fix forward/,
  );
  const stable = prepareTag({ cwd: clone, channel: "stable", commit: "HEAD" });
  assert.equal(createTag(stable, env).commit, first);
  // A commit that has not reached main cannot be tagged.
  versionCommit(clone, 101, { push: false });
  assert.throws(
    () => prepareTag({ cwd: clone, channel: "beta", commit: "HEAD" }),
    /not on origin\/main/,
  );
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  // An older commit can no longer be tagged once a newer one is.
  const second = prepareTag({ cwd: clone, channel: "beta", commit: "HEAD" });
  createTag(second, env);
  assert.throws(
    () => prepareTag({ cwd: clone, channel: "beta", commit: first }),
    /already exists|already newer/,
  );
  assert.equal(second.previous, 100);
});

test("a failed tag push leaves no local tag behind to block the retry", () => {
  const { root, origin, clone } = fixture();
  const env = gitleaksEnv(root);
  versionCommit(clone, 100);
  const plan = prepareTag({ cwd: clone, channel: "beta", commit: "HEAD" });
  // A remote that rejects every push.
  writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(() => createTag(plan, env));
  assert.equal(run(clone, "tag", "--list", plan.name), "");
});

test("required checks come from the checked-in main ruleset", () => {
  const mainRuleset = loadRulesets(process.cwd()).find((entry) => entry.target === "branch");
  assert.deepEqual(requiredChecks(mainRuleset), ["changes", "format", "lint", "typecheck", "scan"]);
  assert.equal(requiredCheckApp(mainRuleset), 15368);
  const required = ["changes", "format", "lint", "typecheck", "scan"];
  const done = (id, name, conclusion) => ({ id, name, status: "completed", conclusion });
  const summary = summarizeChecks(
    [
      done(1, "format", "failure"),
      done(2, "format", "success"),
      done(3, "lint", "skipped"),
      { id: 4, name: "scan", status: "in_progress", conclusion: null },
      done(5, "typecheck", "neutral"),
      done(6, "changes", "success"),
    ],
    required,
  );
  assert.deepEqual(summary, {
    passed: ["changes", "format"],
    skipped: ["lint"],
    pending: ["scan"],
    failed: ["typecheck (neutral)"],
  });
  // Skips count only for path-filtered jobs, and only when changes passed.
  const skippedScan = summarizeChecks(
    [done(1, "changes", "success"), done(2, "scan", "skipped")],
    ["scan"],
  );
  assert.deepEqual(skippedScan.failed, ["scan (skipped)"]);
  const withoutGate = summarizeChecks(
    [done(1, "changes", "failure"), done(2, "lint", "skipped")],
    ["lint"],
  );
  assert.deepEqual(withoutGate.failed, ["lint (skipped without changes)"]);
  assert.deepEqual(summarizeChecks([done(2, "lint", "skipped")], ["lint"]).pending, ["lint"]);
  assert.throws(() => requiredChecks({ rules: [] }), /no required checks/);
  assert.equal(parseGitHubRemote("https://github.com/AubreyF/paseo.git"), "AubreyF/paseo");
  assert.equal(parseGitHubRemote("git@github.com:AubreyF/vorteo.git"), "AubreyF/vorteo");
});

test("ruleset validation keeps merge commits, no bypass and release-* tags", () => {
  const file = path.join(".github", "rulesets", "main.json");
  const main = JSON.parse(readFileSync(file, "utf8"));
  const squash = structuredClone(main);
  squash.rules.find((rule) => rule.type === "pull_request").parameters.allowed_merge_methods = [
    "squash",
  ];
  assert.throws(() => validateRuleset(squash, "main.json"), /merge commits only/);
  assert.throws(
    () => validateRuleset({ ...main, bypass_actors: [{ actor_id: 1 }] }, "main.json"),
    /no bypass/,
  );
  const tags = {
    name: "Vorteo release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "update" }, { type: "deletion" }],
  };
  assert.throws(() => validateRuleset(tags, "tags.json"), /release-\*/);
});

test("ruleset sync creates missing rulesets and ignores fields GitHub adds", () => {
  const desired = loadRulesets(process.cwd());
  assert.deepEqual(
    planSync(desired, []).map((step) => step.action),
    desired.map(() => "create"),
  );
  const applied = desired.map((ruleset, index) => ({
    ...structuredClone(ruleset),
    id: index + 1,
    source: "owner/vorteo",
    rules: ruleset.rules.map((rule) => ({
      ...rule,
      parameters: rule.parameters && { ...rule.parameters, required_reviewers: [] },
    })),
  }));
  assert.deepEqual(planSync(desired, applied), []);
  // GitHub may return rules in another order.
  applied[0].rules.reverse();
  assert.deepEqual(planSync(desired, applied), []);
  applied[0].enforcement = "disabled";
  assert.deepEqual(planSync(desired, applied), [{ action: "update", id: 1, ruleset: desired[0] }]);
  assert.equal(contains({ a: 1, b: 2 }, { a: 1 }), true);
  assert.equal(contains([1, 2], [1]), false);
});

function workflows() {
  const directory = path.join(".github", "workflows");
  return readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => {
      const source = readFileSync(path.join(directory, file), "utf8");
      return { file, source, events: parseTriggers(source) };
    });
}

// secret-scan.yml runs on every push, tags included; it only reads the repository.
const HARMLESS_ON_TAGS = new Set(["secret-scan.yml"]);

test("release tags start no upstream workflow; GitHub Releases start only guarded jobs", () => {
  const all = workflows();
  // The first proposed prefix matched v*; keep proving the parser sees that.
  const vorteo = all.filter((workflow) => startsOnTag(workflow.events, "vorteo-922"));
  assert.ok(vorteo.some((workflow) => workflow.file === "android-apk-release.yml"));
  assert.ok(vorteo.some((workflow) => workflow.file === "desktop-release.yml"));
  for (const tag of [tagName("beta", 922), tagName("stable", 922)]) {
    const started = all
      .filter((workflow) => startsOnTag(workflow.events, tag))
      .map((workflow) => workflow.file);
    assert.deepEqual(
      started.filter((file) => !HARMLESS_ON_TAGS.has(file)),
      [],
      `${tag} starts ${started.join(", ")}`,
    );
  }
  for (const workflow of all.filter((entry) => "release" in entry.events)) {
    for (const job of jobGuards(workflow.source)) {
      assert.ok(job.upstreamOnly, `${workflow.file} job ${job.name} runs on GitHub Releases here`);
    }
  }
});

test("the trigger parser reads the workflow shapes GitHub accepts", () => {
  const triggers = (on) => parseTriggers(`name: x\n${on}\njobs:\n  a:\n    runs-on: x\n`);
  assert.equal(startsOnTag(triggers("on: push"), "release-1"), true);
  assert.equal(startsOnTag(triggers("on: [push, pull_request]"), "release-1"), true);
  assert.equal(startsOnTag(triggers("on:\n  create:"), "release-1"), true);
  assert.equal(startsOnTag(triggers("on:\n  push:\n    paths: [a]"), "release-1"), true);
  assert.equal(startsOnTag(triggers("on:\n  push:\n    branches: [main]"), "release-1"), false);
  assert.equal(
    startsOnTag(triggers("on:\n  push:\n    tags-ignore:\n      - 'release-*'"), "release-1"),
    false,
  );
  const commented = triggers(
    'on:\n  push:\n    tags:\n      - "v*" # desktop\n\n      # app\n      - "rel*"\n  workflow_dispatch:',
  );
  assert.equal(startsOnTag(commented, "release-1"), true);
  assert.equal(startsOnTag(triggers("on:\n  push:\n    tags: [v*, 'x*']"), "x1"), true);
  assert.equal(startsOnTag(triggers('on:\n  push:\n    tags: "v*"'), "vorteo-1"), true);
  assert.equal(startsOnTag(triggers("on:\n  schedule:\n    - cron: '0 0 * * *'"), "v1"), false);
  assert.ok("release" in triggers("on: release"));
  assert.ok(matchesFilters(["release-[0-9]*"], "release-922"));
  assert.ok(!matchesFilters(["release-[0-9]*"], "release-x"));
  assert.ok(matchesFilters(["v1+"], "v111"));
  assert.ok(matchesFilters(["v*", "!v*-beta.*"], "v1.0"));
  assert.ok(!matchesFilters(["v*", "!v*-beta.*"], "v1-beta.2"));
  assert.ok(!matchesFilters(["a/*"], "a/b/c"));
  assert.ok(matchesFilters(["a/**"], "a/b/c"));
  const guards = jobGuards(
    "jobs:\n  ok:\n    if: github.repository == 'getpaseo/paseo'\n  bad:\n    steps:\n      - if: github.repository == 'getpaseo/paseo'\n",
  );
  assert.deepEqual(guards, [
    { name: "ok", upstreamOnly: true },
    { name: "bad", upstreamOnly: false },
  ]);
  assert.throws(() => triggers("on:\n  push:\n    tags: {a: b}"), /Unsupported/);
  assert.equal(
    startsOnTag(triggers("on:\n  workflow_run:\n    workflows: [x]"), "release-1"),
    true,
  );
  assert.deepEqual(
    jobGuards("jobs:\n  loose:\n    if: github.repository == 'getpaseo/paseo' || true\n"),
    [{ name: "loose", upstreamOnly: false }],
  );
  assert.ok(
    requiresUpstream(
      "${{ github.repository == 'getpaseo/paseo' && (github.event_name != 'release' || x) }}",
    ),
  );
  assert.ok(!requiresUpstream("github.repository == 'getpaseo/paseo' && a || b"));
});
