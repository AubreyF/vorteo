import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkArchiveReadiness } from "./archive-readiness.mjs";
import { findGitleaks, unpublishedCommits } from "./lib/delivery-git.mjs";
import {
  prepareHostDelivery,
  resolveVersionOnlyConflicts,
  unionConflicts,
} from "./prepare-host-delivery.mjs";
import {
  PublishRefusal,
  assertReviewed,
  deleteMergedBranch,
  readDelegates,
  mergePullRequest,
  openPullRequest,
  preparePublication,
  waitForChecks,
} from "./publish-main.mjs";
import { createTaskWorktree, planTaskWorktree } from "./task-worktree.mjs";
import { applyCleanup, classifyWorktrees } from "./worktree-cleanup.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A bare origin with one commit on main and a clone checked out on main.
function fixture() {
  // Resolve the macOS /var -> /private/var symlink so Git and Node report the same paths.
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-lifecycle-")));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  run(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  run(root, "clone", "--quiet", origin, clone);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "/dev/null"],
  ]) {
    run(clone, "config", key, value);
  }
  commit(clone, "README.md", "base\n", "Base");
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  run(clone, "fetch", "--quiet", "origin");
  return { root, origin, clone };
}

function commit(cwd, file, content, message) {
  writeFileSync(path.join(cwd, file), content);
  run(cwd, "add", file);
  run(cwd, "commit", "--quiet", "-m", message);
  return run(cwd, "rev-parse", "HEAD").trim();
}

test("a clean checkout whose commits are on origin/main is ready", () => {
  const { clone } = fixture();
  const result = checkArchiveReadiness({ cwd: clone, fetch: false });
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
});

test("uncommitted and untracked files block archiving", () => {
  const { clone } = fixture();
  writeFileSync(path.join(clone, "README.md"), "edited\n");
  writeFileSync(path.join(clone, "notes.txt"), "draft\n");
  const result = checkArchiveReadiness({ cwd: clone, fetch: false });
  assert.equal(result.ready, false);
  assert.match(result.blockers[0], /Uncommitted changes: README\.md/);
  assert.match(result.blockers[1], /Untracked files: notes\.txt/);
});

test("a commit that never reached origin/main blocks archiving", () => {
  const { clone } = fixture();
  run(clone, "switch", "--quiet", "-c", "feat/x");
  commit(clone, "feature.txt", "x\n", "Add feature");
  const result = checkArchiveReadiness({ cwd: clone, fetch: false });
  assert.equal(result.ready, false);
  assert.match(result.blockers[0], /Commits not on origin\/main: [0-9a-f]{9} Add feature/);
});

test("work that reached origin/main by cherry-pick or squash counts as published", () => {
  const { clone, root } = fixture();
  run(clone, "switch", "--quiet", "-c", "feat/y");
  commit(clone, "a.txt", "a\n", "Add a");
  commit(clone, "b.txt", "b\n", "Add b");
  // Another checkout squashes both commits onto main and pushes.
  const other = path.join(root, "other");
  run(root, "clone", "--quiet", path.join(root, "origin.git"), other);
  run(other, "config", "user.name", "Test");
  run(other, "config", "user.email", "test@example.invalid");
  run(other, "config", "core.hooksPath", "/dev/null");
  run(other, "fetch", "--quiet", clone, "feat/y");
  run(other, "merge", "--quiet", "--squash", "FETCH_HEAD");
  run(other, "commit", "--quiet", "-m", "Squash a and b");
  run(other, "push", "--quiet", "origin", "HEAD:main");
  run(clone, "fetch", "--quiet", "origin");
  assert.deepEqual(unpublishedCommits(clone, "origin/main"), []);
  assert.equal(checkArchiveReadiness({ cwd: clone, fetch: false }).ready, true);
});

test("an installed release that lacks the work blocks archiving when requested", () => {
  const { clone } = fixture();
  const installed = run(clone, "rev-parse", "HEAD").trim();
  commit(clone, "c.txt", "c\n", "Add c");
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  run(clone, "fetch", "--quiet", "origin");
  const result = checkArchiveReadiness({ cwd: clone, fetch: false, installed });
  assert.equal(result.ready, false);
  assert.match(result.blockers[0], /installed release .* does not contain this work/);
  assert.equal(
    checkArchiveReadiness({
      cwd: clone,
      fetch: false,
      installed: run(clone, "rev-parse", "HEAD").trim(),
    }).ready,
    true,
  );
});

function fakeGitleaks(root) {
  const bin = path.join(root, "gitleaks");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { ...process.env, PASEO_GITLEAKS_BIN: bin };
}

const REPO = "owner/vorteo";
const REQUIRED = ["format", "scan"];
const ACTIONS = 15368;

// A fake gh backed by the fixture's bare origin. Merging creates a real merge commit on main.
function fakeGh({ root, origin, checks = [], reviews = [], viewer = "owner", author = "owner" }) {
  const calls = [];
  const prs = [];
  const gh = (args, { input } = {}) => {
    calls.push({ args, input });
    const [group, verb] = args;
    if (group === "api" && verb === "user") return viewer;
    if (group === "api" && verb.endsWith("/permission")) return "admin";
    if (group === "api" && verb === `repos/${REPO}`) return "owner";
    if (group === "pr" && verb === "list") {
      return JSON.stringify(prs.filter((pr) => pr.state === "OPEN"));
    }
    if (group === "pr" && verb === "create") {
      const branch = args[args.indexOf("--head") + 1];
      const head = run(root, "--git-dir", origin, "rev-parse", `refs/heads/${branch}`).trim();
      prs.push({
        number: prs.length + 1,
        state: "OPEN",
        baseRefName: "main",
        headRefName: branch,
        headRefOid: head,
        isCrossRepository: false,
        author: { login: author },
        url: `https://github.com/${REPO}/pull/${prs.length + 1}`,
      });
      return prs.at(-1).url;
    }
    if (group === "pr" && verb === "view") {
      return JSON.stringify(prs.find((entry) => String(entry.number) === args[2]));
    }
    if (group === "pr" && verb === "merge") {
      const pr = prs.find((entry) => String(entry.number) === args[2]);
      assert.equal(args[args.indexOf("--match-head-commit") + 1], pr.headRefOid);
      assert.ok(args.includes("--merge"));
      const merger = path.join(root, `merger-${pr.number}`);
      run(root, "clone", "--quiet", origin, merger);
      run(merger, "config", "user.name", "GitHub");
      run(merger, "config", "user.email", "noreply@example.invalid");
      run(
        merger,
        "merge",
        "--quiet",
        "--no-ff",
        "-m",
        `Merge pull request #${pr.number}`,
        pr.headRefOid,
      );
      run(merger, "push", "--quiet", "origin", "HEAD:main");
      pr.state = "MERGED";
      pr.mergeCommit = { oid: run(merger, "rev-parse", "HEAD").trim() };
      return "";
    }
    if (group === "api" && args.at(-3).includes("/check-runs")) {
      return checks.map((check) => JSON.stringify({ app: ACTIONS, ...check })).join("\n");
    }
    if (group === "api" && args.at(-3).includes("/reviews")) {
      return reviews.map((review) => JSON.stringify(review)).join("\n");
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, calls, prs };
}

function branchFixture() {
  const setup = fixture();
  run(setup.clone, "checkout", "--quiet", "-b", "feat/a");
  return setup;
}

const planFor = (clone, env, gh) =>
  preparePublication({
    cwd: clone,
    env,
    gh,
    repository: REPO,
    required: REQUIRED,
    checkApp: ACTIONS,
  });

const passing = REQUIRED.map((name, index) => ({
  id: index + 1,
  name,
  status: "completed",
  conclusion: "success",
}));

test("publishing refuses a dirty tree, main, a stale base and a missing secret scanner", () => {
  const { clone, root, origin } = fixture();
  const env = fakeGitleaks(root);
  const { gh } = fakeGh({ root, origin });
  const prepare = (extra = {}) =>
    preparePublication({ cwd: clone, env, gh, repository: REPO, required: REQUIRED, ...extra });
  commit(clone, "a.txt", "a\n", "Add a");
  assert.throws(() => prepare(), /named task or integration branch/);
  run(clone, "checkout", "--quiet", "-b", "feat/a");
  writeFileSync(path.join(clone, "draft.txt"), "x\n");
  assert.throws(() => prepare(), PublishRefusal);
  rmSync(path.join(clone, "draft.txt"));
  assert.throws(
    () => prepare({ env: { ...env, PASEO_GITLEAKS_BIN: path.join(root, "none") } }),
    /Gitleaks/,
  );
  // Someone else merges first: the branch must take main and a fresh version.
  const other = path.join(root, "other");
  run(root, "clone", "--quiet", origin, other);
  run(other, "config", "user.name", "Test");
  run(other, "config", "user.email", "test@example.invalid");
  commit(other, "b.txt", "b\n", "Add b");
  run(other, "push", "--quiet", "origin", "HEAD:main");
  assert.throws(() => prepare(), /version:vorton/);
});

test("publishing opens a pull request, waits for required checks and merges with a merge commit", async () => {
  const { clone, root, origin } = branchFixture();
  const env = fakeGitleaks(root);
  const head = commit(clone, "a.txt", "a\n", "Add a");
  const checks = [{ id: 1, name: "format", status: "in_progress", conclusion: null }];
  const { gh, calls } = fakeGh({ root, origin, checks });
  const plan = planFor(clone, env, gh);
  const pr = await openPullRequest(plan, { env, gh, pollMs: 0 });
  assert.equal(pr.headRefOid, head);
  assert.equal(run(clone, "ls-remote", "origin", "refs/heads/feat/a").split(/\s+/)[0], head);
  assert.match(calls.find((call) => call.args[1] === "create").input, /^\(AI Generated\)\./);
  // Reusing the branch finds the same pull request instead of opening another.
  assert.equal((await openPullRequest(plan, { env, gh, pollMs: 0 })).number, pr.number);
  assert.equal(assertReviewed(plan, pr, { gh }), "authored by this installation's account");
  let polls = 0;
  await waitForChecks(plan, {
    gh,
    pollMs: 0,
    log: () => {
      polls += 1;
      checks.splice(0, checks.length, ...passing);
    },
  });
  assert.equal(polls, 1);
  const result = mergePullRequest(plan, pr, { gh });
  const parents = run(clone, "rev-list", "--parents", "-n", "1", result.mergeCommit)
    .trim()
    .split(" ");
  assert.equal(parents.length, 3);
  assert.equal(parents[2], head);
  assert.equal(
    run(clone, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0],
    result.mergeCommit,
  );
  // The branch stays unless deletion is requested.
  assert.equal(run(clone, "ls-remote", "origin", "refs/heads/feat/a").split(/\s+/)[0], head);
  assert.equal(deleteMergedBranch(plan, env), true);
  assert.equal(run(clone, "ls-remote", "origin", "refs/heads/feat/a"), "");
});

test("required checks refuse failures, neutral results and other apps' runs", async () => {
  const { clone, root, origin } = branchFixture();
  const env = fakeGitleaks(root);
  commit(clone, "a.txt", "a\n", "Add a");
  const checks = [
    { id: 1, name: "format", status: "completed", conclusion: "success" },
    { id: 2, name: "scan", status: "completed", conclusion: "neutral" },
  ];
  const { gh } = fakeGh({ root, origin, checks });
  const plan = planFor(clone, env, gh);
  await assert.rejects(waitForChecks(plan, { gh, pollMs: 0 }), /scan \(neutral\)/);
  // A run from another app with a required name is ignored, so scan stays pending.
  checks.splice(1, 1, { id: 3, name: "scan", status: "completed", conclusion: "success", app: 1 });
  await assert.rejects(
    waitForChecks(plan, { gh, pollMs: 0, timeoutMs: 0 }),
    /Timed out waiting for scan/,
  );
});

test("a cancelled run waits briefly for its replacement before refusing", async () => {
  const { clone, root, origin } = branchFixture();
  const env = fakeGitleaks(root);
  commit(clone, "a.txt", "a\n", "Add a");
  const checks = [
    { id: 1, name: "format", status: "completed", conclusion: "success" },
    { id: 2, name: "scan", status: "completed", conclusion: "cancelled" },
  ];
  const { gh } = fakeGh({ root, origin, checks });
  const plan = planFor(clone, env, gh);
  await assert.rejects(
    waitForChecks(plan, { gh, pollMs: 0, cancelledPolls: 2 }),
    /scan \(cancelled\)/,
  );
  let polls = 0;
  await waitForChecks(plan, {
    gh,
    pollMs: 0,
    cancelledPolls: 2,
    log: () => {
      polls += 1;
      checks.push({ id: 3, name: "scan", status: "completed", conclusion: "success" });
    },
  });
  assert.equal(polls, 1);
});

test("reviews count only from writers, by their latest decision, and change requests block all", () => {
  const plan = { repository: REPO, head: "abc" };
  const fork = { number: 7, isCrossRepository: true, author: { login: "contributor" } };
  const review = (overrides) => ({
    id: 1,
    state: "APPROVED",
    commit_id: "abc",
    user: "owner",
    ...overrides,
  });
  const permissions = { owner: "admin", helper: "write", reader: "read", "builds-bot": "write" };
  const gh =
    (reviews, viewer = "builds-bot") =>
    (args) => {
      if (args[1] === "user") return viewer;
      if (args[1] === `repos/${REPO}`) return "owner";
      const permission = /collaborators\/([^/]+)\/permission/.exec(args[1]);
      if (permission) return permissions[permission[1]] ?? "none";
      return reviews.map((entry) => JSON.stringify(entry)).join("\n");
    };
  const refuses = (pr, reviews, pattern, options = {}) =>
    assert.throws(
      () =>
        assertReviewed(plan, pr, {
          gh: gh(reviews, options.viewer),
          delegates: options.delegates ?? [],
        }),
      pattern,
    );
  const accepts = (pr, reviews, options = {}) =>
    assertReviewed(plan, pr, {
      gh: gh(reviews, options.viewer),
      delegates: options.delegates ?? [],
    });
  refuses(fork, [], /waits for review/);
  refuses(fork, [review({ commit_id: "old" })], /waits for review/);
  refuses(fork, [review({ user: "reader" })], /waits for review/);
  // A later change request from the same reviewer supersedes the approval.
  refuses(fork, [review({}), review({ id: 2, state: "CHANGES_REQUESTED" })], /changes requested/);
  // A dismissed change request no longer blocks; a reader's request never did.
  assert.equal(
    accepts(fork, [
      review({}),
      review({ id: 2, user: "helper", state: "CHANGES_REQUESTED" }),
      review({ id: 3, user: "helper", state: "DISMISSED" }),
      review({ id: 4, user: "reader", state: "CHANGES_REQUESTED" }),
    ]),
    "approved on its head",
  );
  // The account agents run as cannot approve on the owner's behalf.
  refuses(fork, [review({})], /other than owner/, { viewer: "owner" });
  assert.equal(accepts(fork, [review({})], { viewer: "builds-bot" }), "approved on its head");
  // Deleted users and bots are skipped instead of breaking the permission lookup.
  refuses(fork, [review({ user: null }), review({ id: 2, user: "ci[bot]" })], /waits for review/);
  // Write access alone does not delegate approval; an explicit delegate does.
  refuses(fork, [review({ user: "helper" })], /owner or a delegated approver/);
  assert.equal(
    accepts(fork, [review({ user: "helper" })], { delegates: ["helper"] }),
    "approved on its head",
  );
  // A writer who is not an approver cannot self-merge as "this installation".
  const helperOwn = { ...fork, isCrossRepository: false, author: { login: "helper" } };
  refuses(helperOwn, [], /waits for review/, { viewer: "helper" });
  // A same-repository branch from another account is not this installation's own work.
  refuses(
    { ...fork, isCrossRepository: false, author: { login: "helper" } },
    [],
    /waits for review/,
  );
  const own = { ...fork, isCrossRepository: false, author: { login: "owner" } };
  assert.equal(accepts(own, [], { viewer: "owner" }), "authored by this installation's account");
  // Even this installation's own pull request stops on a writer's change request.
  refuses(
    own,
    [review({ user: "helper", state: "CHANGES_REQUESTED" })],
    /changes requested by helper/,
    { viewer: "owner" },
  );
});

test("delegated approvers come from the base branch, not the pull request", () => {
  const { clone, root, origin } = branchFixture();
  const env = fakeGitleaks(root);
  run(clone, "checkout", "--quiet", "main");
  mkdirSync(path.join(clone, ".github"), { recursive: true });
  const file = path.join(clone, ".github", "delivery-approvers.json");
  writeFileSync(file, JSON.stringify({ approvers: ["delegate"] }));
  run(clone, "add", ".github");
  run(clone, "commit", "--quiet", "-m", "Delegate");
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  run(clone, "checkout", "--quiet", "-B", "feat/a");
  commit(
    clone,
    ".github/delivery-approvers.json",
    JSON.stringify({ approvers: ["intruder"] }),
    "Self-approve",
  );
  const { gh } = fakeGh({ root, origin });
  assert.deepEqual(readDelegates(planFor(clone, env, gh)), ["delegate"]);
});

test("finds Gitleaks through an explicit override", () => {
  const { root } = fixture();
  const env = fakeGitleaks(root);
  assert.equal(findGitleaks(env), env.PASEO_GITLEAKS_BIN);
});

test("task worktrees are siblings from the fetched base with validated names", () => {
  const { clone } = fixture();
  assert.throws(() => planTaskWorktree({ cwd: clone, slug: "Bad Slug" }), /kebab-case/);
  assert.throws(() => planTaskWorktree({ cwd: clone, slug: "x", branch: "x" }), /Branch names/);
  const plan = planTaskWorktree({ cwd: clone, slug: "folder-browser", env: {} });
  assert.equal(plan.location, path.join(path.dirname(clone), "clone-folder-browser"));
  createTaskWorktree(plan, { install: false });
  assert.equal(
    run(plan.location, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    "feat/folder-browser",
  );
  assert.throws(() => createTaskWorktree(plan, { install: false }), /already exists/);
  // Planning from inside a linked worktree still names siblings after the primary checkout.
  const nested = planTaskWorktree({ cwd: plan.location, slug: "second", env: {} });
  assert.equal(nested.location, path.join(path.dirname(clone), "clone-second"));
});

test("cleanup removes only idle worktrees whose work is published", () => {
  const { clone } = fixture();
  const make = (slug) => {
    const plan = planTaskWorktree({ cwd: clone, slug, env: {} });
    createTaskWorktree(plan, { install: false });
    return plan.location;
  };
  const published = make("published");
  const unpublished = make("unpublished");
  commit(unpublished, "u.txt", "u\n", "Unpublished work");
  const dirty = make("dirty");
  writeFileSync(path.join(dirty, "draft.txt"), "x\n");
  const now = Date.now();
  const entries = classifyWorktrees({ cwd: clone, fetch: false, now: now + 48 * 3_600_000 });
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
  assert.equal(byPath[published].action, "remove");
  assert.equal(byPath[unpublished].action, "keep");
  assert.match(byPath[unpublished].reason, /Unpublished work/);
  assert.equal(byPath[dirty].action, "keep");
  // Recently used worktrees stay even when published.
  assert.equal(
    classifyWorktrees({ cwd: clone, fetch: false, now }).find((entry) => entry.path === published)
      .action,
    "keep",
  );
  applyCleanup({ cwd: clone, target: "origin/main", entries });
  assert.equal(existsSync(published), false);
  assert.equal(existsSync(unpublished), true);
  assert.equal(existsSync(dirty), true);
  assert.equal(run(clone, "branch", "--list", "feat/published").trim(), "");
});

test("cleanup keeps worktrees from other environments unless asked to prune", () => {
  const { clone } = fixture();
  const plan = planTaskWorktree({ cwd: clone, slug: "elsewhere", env: {} });
  createTaskWorktree(plan, { install: false });
  rmSync(plan.location, { recursive: true, force: true });
  const kept = classifyWorktrees({ cwd: clone, fetch: false });
  assert.equal(kept[0].action, "keep");
  assert.match(kept[0].reason, /another environment/);
  assert.equal(
    classifyWorktrees({ cwd: clone, fetch: false, pruneMissing: true })[0].action,
    "prune",
  );
});

test("release-note conflicts keep both sides", () => {
  const merged = unionConflicts(
    [
      "intro",
      "<<<<<<< HEAD",
      "## 2",
      "",
      "- ours",
      "=======",
      "## 3",
      "- theirs",
      ">>>>>>> x",
      "## 1",
    ].join("\n"),
  );
  assert.equal(merged, ["intro", "## 2", "", "- ours", "", "## 3", "- theirs", "## 1"].join("\n"));
});

test("Host delivery starts at the installed commit, then merges publications before main", () => {
  const { clone, root } = fixture();
  const notes = (entry) => `# Changelog\n\n${entry}\n## 0 - 2026-01-01\n\n- base\n`;
  commit(clone, "VORTEO_CHANGELOG.md", notes(""), "Notes");
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  // The installation's source repository holds the installed commit and a publication record.
  const source = path.join(root, "source");
  run(root, "clone", "--quiet", path.join(root, "origin.git"), source);
  run(source, "config", "user.name", "Test");
  run(source, "config", "user.email", "test@example.invalid");
  const installed = commit(
    source,
    "VORTEO_CHANGELOG.md",
    notes("## 2 - 2026-01-02\n\n- installed\n"),
    "Installed",
  );
  run(source, "switch", "--quiet", "-c", "pub");
  const publication = commit(source, "pub.txt", "p\n", "Published interface");
  run(source, "update-ref", `refs/vorteo-publications/${publication}`, publication);
  run(source, "switch", "--quiet", "main");
  // GitHub main moves on with its own release note.
  commit(clone, "VORTEO_CHANGELOG.md", notes("## 1 - 2026-01-02\n\n- main\n"), "Main work");
  run(clone, "push", "--quiet", "origin", "HEAD:main");
  run(clone, "fetch", "--quiet", "origin");

  const checkout = path.join(root, "delivery");
  const options = { repository: clone, checkout, sourceRepo: source, installed };
  assert.equal(prepareHostDelivery(options).state, "reset");
  // The publication sits on top of the installed commit, so it fast-forwards.
  assert.equal(prepareHostDelivery(options).state, "fast-forwarded");
  assert.equal(run(checkout, "rev-parse", "HEAD").trim(), publication);
  run(checkout, "config", "user.name", "Test");
  run(checkout, "config", "user.email", "test@example.invalid");
  const second = prepareHostDelivery(options);
  assert.equal(second.subject, "Main work");
  assert.deepEqual(second.conflicts, []);
  const merged = readFileSync(path.join(checkout, "VORTEO_CHANGELOG.md"), "utf8");
  assert.match(merged, /- installed[\s\S]*- main/);
  run(checkout, "commit", "--quiet", "-m", "Merge main");
  assert.equal(prepareHostDelivery(options).state, "ready");
  // A newer installed release is merged into the delivery branch, not reset to.
  const newer = commit(source, "later.txt", "l\n", "Later install");
  const third = prepareHostDelivery({ ...options, installed: newer });
  assert.equal(third.merging, newer);
  run(checkout, "commit", "--quiet", "-m", "Merge later install");
  // An installed release built on top of this branch is reached by fast-forward.
  run(source, "fetch", "--quiet", checkout, "installation-integration");
  run(source, "merge", "--quiet", "--ff-only", "FETCH_HEAD");
  const descendant = commit(source, "after.txt", "a\n", "Installed on top");
  assert.equal(prepareHostDelivery({ ...options, installed: descendant }).state, "fast-forwarded");
  assert.equal(run(checkout, "rev-parse", "HEAD").trim(), descendant);
  assert.match(run(checkout, "log", "--format=%s"), /Merge main/);
});

test("manifest conflicts on Vorteo versions alone keep the installed side", () => {
  const conflict = (ours, theirs) =>
    ["{", "<<<<<<< HEAD", ours, "=======", theirs, ">>>>>>> origin/main", "}"].join("\n");
  const versions = resolveVersionOnlyConflicts(
    conflict(
      '  "version": "0.11.0-beta.3.vorteo.739",',
      '  "version": "0.11.0-beta.3.vorteo.734",',
    ),
  );
  assert.equal(versions.unresolved, 0);
  assert.equal(versions.text, '{\n  "version": "0.11.0-beta.3.vorteo.739",\n}');
  const dependency = resolveVersionOnlyConflicts(
    conflict('  "zod": "^3.24.0",', '  "zod": "^4.0.0",'),
  );
  assert.equal(dependency.unresolved, 1);
  assert.match(dependency.text, /<<<<<<< HEAD/);
});
