import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import { prepareHostDelivery, unionConflicts } from "./prepare-host-delivery.mjs";
import { PublishRefusal, preparePublication, publish } from "./publish-main.mjs";
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

test("publishing refuses a dirty tree, a stale base and a missing secret scanner", () => {
  const { clone, root } = fixture();
  const env = fakeGitleaks(root);
  writeFileSync(path.join(clone, "draft.txt"), "x\n");
  assert.throws(() => preparePublication({ cwd: clone, env }), PublishRefusal);
  rmSync(path.join(clone, "draft.txt"));
  assert.throws(() => preparePublication({ cwd: clone, env }), /already points at/);
  commit(clone, "a.txt", "a\n", "Add a");
  assert.throws(
    () =>
      preparePublication({
        cwd: clone,
        env: { ...env, PASEO_GITLEAKS_BIN: path.join(root, "none") },
      }),
    /Gitleaks/,
  );
  // Someone else pushes first: this commit no longer fast-forwards.
  const other = path.join(root, "other");
  run(root, "clone", "--quiet", path.join(root, "origin.git"), other);
  run(other, "config", "user.name", "Test");
  run(other, "config", "user.email", "test@example.invalid");
  commit(other, "b.txt", "b\n", "Add b");
  run(other, "push", "--quiet", "origin", "HEAD:main");
  assert.throws(() => preparePublication({ cwd: clone, env }), /Never force-push/);
});

test("publishing fast-forwards main and verifies the remote head", () => {
  const { clone, root } = fixture();
  const env = fakeGitleaks(root);
  const head = commit(clone, "a.txt", "a\n", "Add a");
  const plan = preparePublication({ cwd: clone, env });
  assert.deepEqual(
    plan.outgoing.map((line) => line.split(" ").slice(1).join(" ")),
    ["Add a"],
  );
  assert.equal(publish(plan, env), head);
  assert.equal(run(clone, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0], head);
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
  const first = prepareHostDelivery(options);
  assert.equal(first.merging, publication);
  run(checkout, "config", "user.name", "Test");
  run(checkout, "config", "user.email", "test@example.invalid");
  run(checkout, "commit", "--quiet", "-m", "Merge publication");
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
  assert.match(run(checkout, "log", "--format=%s"), /Merge main/);
});
