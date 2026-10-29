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
  const summary = summarizeChecks(
    [
      { id: 1, name: "format", status: "completed", conclusion: "failure" },
      { id: 2, name: "format", status: "completed", conclusion: "success" },
      { id: 3, name: "lint", status: "completed", conclusion: "skipped" },
      { id: 4, name: "scan", status: "in_progress", conclusion: null },
      { id: 5, name: "typecheck", status: "completed", conclusion: "neutral" },
    ],
    ["format", "lint", "typecheck", "scan"],
  );
  assert.deepEqual(summary, {
    passed: ["format"],
    skipped: ["lint"],
    pending: ["scan"],
    failed: ["typecheck (neutral)"],
  });
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

// Tag push filters from each workflow's `on:` block, read as text so the test needs no YAML parser.
function workflowTriggers() {
  const directory = path.join(".github", "workflows");
  return readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => {
      const lines = readFileSync(path.join(directory, file), "utf8").split("\n");
      const end = lines.findIndex((line) => line.startsWith("jobs:"));
      const on = lines.slice(0, end === -1 ? lines.length : end);
      const tags = [];
      on.forEach((line, index) => {
        const header = /^(\s*)tags:\s*$/.exec(line);
        if (!header) return;
        for (const next of on.slice(index + 1)) {
          const item = /^(\s*)-\s*["']?([^"'\s]+)["']?\s*$/.exec(next);
          if (!item || item[1].length <= header[1].length) break;
          tags.push(item[2]);
        }
      });
      return { file, tags, release: on.some((line) => /^\s+release:/.test(line)) };
    });
}

// GitHub filter globs: * stops at "/", ** does not, and later "!" patterns exclude.
function triggers(patterns, tag) {
  const toRegex = (glob) =>
    new RegExp(
      `^${glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".")
        .replaceAll("\u0000", ".*")}$`,
    );
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (toRegex(pattern.slice(1)).test(tag)) matched = false;
    } else if (toRegex(pattern).test(tag)) matched = true;
  }
  return matched;
}

test("release tags start no upstream workflow; GitHub Releases start only guarded ones", () => {
  const workflows = workflowTriggers();
  const tagged = workflows.filter((workflow) => workflow.tags.length);
  assert.ok(tagged.length >= 3, "expected upstream tag-triggered workflows");
  // The old vorteo- prefix matched v*; keep proving the parser sees that.
  assert.ok(tagged.some((workflow) => triggers(workflow.tags, "vorteo-922")));
  for (const tag of [tagName("beta", 922), tagName("stable", 922)]) {
    for (const workflow of tagged) {
      assert.equal(triggers(workflow.tags, tag), false, `${workflow.file} runs on ${tag}`);
    }
  }
  for (const workflow of workflows.filter((entry) => entry.release)) {
    const source = readFileSync(path.join(".github", "workflows", workflow.file), "utf8");
    assert.match(
      source,
      /github\.repository == 'getpaseo\/paseo'/,
      `${workflow.file} runs on GitHub Releases in this repository`,
    );
  }
});
