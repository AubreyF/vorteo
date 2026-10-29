import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { watch } from "node:fs";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { installationWebEntry } from "./installation-web-entry.mjs";
import { preloadWebEntry } from "./preload-web-entry.mjs";
import { fallbackIcons, isReviewedFallback } from "./web-icon-migration.mjs";
import {
  assertIntegratedSource,
  digest,
  git,
  readLiveState,
  sealArtifact,
  snapshotSource,
  createPublicationBinding,
  publicationBindingPath,
  retainPublicationSource,
} from "./instance-web-artifact.mjs";
const run = promisify(execFile);
const publisher = path.resolve("scripts/publish-instance-web.mjs");

test("entry script preload starts in the head and preserves its security attributes and execution order", () => {
  const script =
    '<script src="/_expo/static/js/web/index-0123456789abcdef.js" defer crossorigin="anonymous" integrity="sha256-test" referrerpolicy="no-referrer" nonce="test-nonce"></script>';
  const html = `<html><head><title>Test</title></head><body><script>window.loaderReady=true;</script>${script}</body></html>`;
  const transformed = preloadWebEntry(html);
  assert.ok(transformed.indexOf('rel="preload"') < transformed.indexOf("</head>"));
  assert.ok(transformed.includes(script));
  for (const attribute of [
    'crossorigin="anonymous"',
    'integrity="sha256-test"',
    'referrerpolicy="no-referrer"',
    'nonce="test-nonce"',
  ])
    assert.equal(transformed.split(attribute).length - 1, 2);
  assert.equal(preloadWebEntry(transformed), transformed);
});

test("entry script preload leaves external, credential-bearing and non-entry scripts alone", () => {
  const html =
    '<html><head></head><body><script src="https://user:secret@example.test/entry.js"></script><script src="/installation-entry-test.js"></script><script src="/_expo/static/js/web/index.js?token=private"></script></body></html>';
  assert.equal(preloadWebEntry(html), html);
});

test("entry preload reuses anonymous CORS semantics and embeds only validated build provenance", () => {
  const html =
    '<html><head></head><body><script src="/_expo/static/js/web/index-test.js" crossorigin defer></script></body></html>';
  const metadata = { version: "0.11.0-beta.3.vorteo.820", sourceCommit: "a".repeat(40) };
  const result = preloadWebEntry(html, metadata);
  assert.match(result, /crossorigin="anonymous"/);
  assert.match(result, /content="0.11.0-beta.3.vorteo.820 \(aaaaaaaaaaaa\)"/);
  assert.equal(preloadWebEntry(result, metadata), result);
  assert.throws(
    () => preloadWebEntry(html, { ...metadata, sourceCommit: "<private>" }),
    /metadata/,
  );
});

test("installation entry preserves deep links without reading client credentials or storage", () => {
  const entry = installationWebEntry("https://owner.example.test:44444");
  let replaced;
  const location = {
    origin: "https://container.example.test",
    pathname: "/h/container/workspace/known-conversation",
    search: "?serverId=container&projectId=existing",
    hash: "#draft",
    replace: (url) => {
      replaced = url;
    },
  };
  runInNewContext(entry.script, { window: { location }, URL });
  assert.equal(
    replaced,
    "https://owner.example.test:44444/h/container/workspace/known-conversation?serverId=container&projectId=existing#draft",
  );
  assert.match(entry.html, new RegExp(entry.scriptName));
  assert.match(entry.html, /name="referrer" content="no-referrer"/);
});

test("installation entry rejects insecure or credential-bearing targets and does not loop", () => {
  for (const origin of [
    "http://owner.example.test",
    "https://user:secret@owner.example.test",
    "https://owner.example.test/path",
    "https://owner.example.test?token=secret",
    "https://owner.example.test#token",
  ])
    assert.throws(() => installationWebEntry(origin), /HTTPS origin/);
  const entry = installationWebEntry("https://owner.example.test");
  const status = { textContent: "" };
  runInNewContext(entry.script, {
    window: { location: { origin: entry.origin, replace: () => assert.fail("redirect loop") } },
    document: { getElementById: () => status },
  });
  assert.match(status.textContent, /points to itself/);
});

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "publish-web-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repo");
  const destination = path.join(root, "served");
  await fs.mkdir(repository);
  await fs.mkdir(destination);
  git(repository, ["init", "-b", "integration"]);
  git(repository, ["config", "user.email", "test@example.invalid"]);
  git(repository, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repository, "app.txt"), "first source");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "Initial source"]);
  return { root, repository, destination };
}
async function candidate(f, name, previous = null) {
  const directory = path.join(f.root, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "index.html"), `<script src="/${name}.js"></script>`);
  await fs.writeFile(path.join(directory, `${name}.js`), `console.log('${name}');`.repeat(100));
  const live = previous ?? (await readLiveState(f.destination));
  await sealArtifact(directory, {
    buildId: name,
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    sourceHash: digest("source"),
    deployment: {
      destination: f.destination,
      expectedRelease: live.token,
      integrationRef: "refs/heads/integration",
      repository: f.repository,
    },
  });
  return directory;
}
function publish(source, destination) {
  return run(process.execPath, [publisher, source, destination]);
}

async function withIcon(f, name, bytes) {
  const directory = await candidate(f, name);
  const manifestPath = path.join(directory, ".build-manifest.json");
  const provenance = JSON.parse(await fs.readFile(manifestPath));
  await fs.rm(manifestPath);
  delete provenance.files;
  await fs.writeFile(path.join(directory, "apple-touch-icon.png"), bytes);
  await sealArtifact(directory, provenance);
  return directory;
}

test("fallback migration only accepts exact approved bytes and fixed names", async () => {
  for (const [name, hashes] of Object.entries(fallbackIcons)) {
    assert.equal(isReviewedFallback(name, hashes.before, hashes.after), true);
    assert.equal(isReviewedFallback(name, hashes.after, hashes.after), true);
    assert.equal(isReviewedFallback(name, null, hashes.after), true);
    assert.throws(() => isReviewedFallback(name, digest("unknown"), hashes.after));
    assert.throws(() => isReviewedFallback(name, hashes.before, digest("new")));
    const bytes = await fs.readFile(path.resolve("packages/app/public", name));
    assert.equal(digest(bytes), hashes.after);
  }
  assert.equal(isReviewedFallback("versioned-icon.png", "old", "new"), false);
  assert.equal(isReviewedFallback("../favicon.ico", "old", "new"), false);
});

test("reviewed icons switch with the release and preserve rollback and open-client assets", async (t) => {
  const f = await fixture(t);
  const oldIcon = await fs.readFile("scripts/test-fixtures/paseo-apple-touch-icon.png");
  const newIcon = await fs.readFile("packages/app/public/apple-touch-icon.png");
  await fs.writeFile(path.join(f.destination, "apple-touch-icon.png"), oldIcon);
  await publish(await candidate(f, "before-icons"), f.destination);
  const before = await fs.readlink(path.join(f.destination, ".current"));
  await publish(await withIcon(f, "icons", newIcon), f.destination);
  const after = await fs.readlink(path.join(f.destination, ".current"));
  assert.equal(
    await fs.readlink(path.join(f.destination, "apple-touch-icon.png")),
    ".current/apple-touch-icon.png",
  );
  assert.deepEqual(await fs.readFile(path.join(f.destination, "apple-touch-icon.png")), newIcon);
  assert.deepEqual(
    await fs.readFile(path.join(f.destination, before, "apple-touch-icon.png")),
    oldIcon,
  );
  assert.ok(await fs.readFile(path.join(f.destination, "before-icons.js")));
  await fs.symlink(before, path.join(f.destination, ".rollback"));
  await fs.rename(path.join(f.destination, ".rollback"), path.join(f.destination, ".current"));
  assert.deepEqual(await fs.readFile(path.join(f.destination, "apple-touch-icon.png")), oldIcon);
  await fs.symlink(after, path.join(f.destination, ".forward"));
  await fs.rename(path.join(f.destination, ".forward"), path.join(f.destination, ".current"));
  await assert.rejects(
    publish(await candidate(f, "omitted-icon"), f.destination),
    /omits selected fallback/,
  );
  await publish(await withIcon(f, "icons-again", newIcon), f.destination);
  assert.deepEqual(await fs.readFile(path.join(f.destination, "apple-touch-icon.png")), newIcon);
});

test("unexpected fallback bytes refuse before selection or icon changes", async (t) => {
  const f = await fixture(t);
  const newIcon = await fs.readFile("packages/app/public/apple-touch-icon.png");
  await publish(await candidate(f, "baseline-icons"), f.destination);
  const before = (await readLiveState(f.destination)).token;
  await fs.writeFile(path.join(f.destination, "apple-touch-icon.png"), "unreviewed prior bytes");
  await assert.rejects(
    publish(await withIcon(f, "bad-prior", newIcon), f.destination),
    /Unreviewed fallback/,
  );
  await fs.rm(path.join(f.destination, "apple-touch-icon.png"));
  await assert.rejects(
    publish(await withIcon(f, "bad-next", Buffer.from("other")), f.destination),
    /Unreviewed fallback/,
  );
  assert.equal((await readLiveState(f.destination)).token, before);
});

test("installation redirects use guarded publication and record their target", async (t) => {
  const f = await fixture(t);
  const entry = installationWebEntry("https://owner.example.test:44444");
  const directory = path.join(f.root, "redirect");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "index.html"), entry.html);
  await fs.writeFile(path.join(directory, entry.scriptName), entry.script);
  await sealArtifact(directory, {
    buildId: "redirect",
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    sourceHash: digest("source"),
    entrypoint: { kind: "installation", origin: entry.origin },
    deployment: {
      destination: f.destination,
      expectedRelease: (await readLiveState(f.destination)).token,
      integrationRef: "refs/heads/integration",
      repository: f.repository,
    },
  });
  await publish(directory, f.destination);
  const live = await readLiveState(f.destination);
  assert.deepEqual(live.release.entrypoint, { kind: "installation", origin: entry.origin });
  assert.equal(await fs.readFile(path.join(f.destination, entry.scriptName), "utf8"), entry.script);
});

test("publication switches index and receipt together and preserves old chunks", async (t) => {
  const f = await fixture(t);
  const first = await candidate(f, "first");
  await publish(first, f.destination);
  const firstState = await readLiveState(f.destination);
  const second = await candidate(f, "second");
  await publish(second, f.destination);
  const live = await readLiveState(f.destination);
  assert.notEqual(live.token, firstState.token);
  assert.equal(live.release.buildId, "second");
  assert.equal(await fs.readlink(path.join(f.destination, "index.html")), ".current/index.html");
  assert.equal(
    await fs.readlink(path.join(f.destination, "release.json")),
    ".current/release.json",
  );
  assert.deepEqual(
    await fs.readFile(path.join(f.destination, "index.previous.html")),
    firstState.index,
  );
  const script = await fs.readFile(path.join(first, "first.js"));
  assert.deepEqual(await fs.readFile(path.join(f.destination, "first.js")), script);
  assert.deepEqual(
    brotliDecompressSync(await fs.readFile(path.join(f.destination, "first.js.br"))),
    script,
  );
  assert.deepEqual(gunzipSync(await fs.readFile(path.join(f.destination, "first.js.gz"))), script);
});

test("competing publishers allow exactly one winner; stale candidates leave it intact", async (t) => {
  const f = await fixture(t);
  const baseline = await readLiveState(f.destination);
  const a = await candidate(f, "a", baseline);
  const b = await candidate(f, "b", baseline);
  const results = await Promise.allSettled([publish(a, f.destination), publish(b, f.destination)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const live = await readLiveState(f.destination);
  await assert.rejects(
    publish(live.release.buildId === "a" ? b : a, f.destination),
    /Stale candidate/,
  );
  assert.equal((await readLiveState(f.destination)).token, live.token);
});

test("modified, missing, preview and colliding artifacts cannot change a live release", async (t) => {
  const f = await fixture(t);
  await publish(await candidate(f, "initial"), f.destination);
  const before = await readLiveState(f.destination);
  const changed = await candidate(f, "changed");
  await fs.writeFile(path.join(changed, "changed.js"), "tampered");
  await assert.rejects(publish(changed, f.destination), /Artifact changed/);
  const missing = await candidate(f, "missing");
  await fs.rm(path.join(missing, "missing.js"));
  await assert.rejects(publish(missing, f.destination), /Artifact changed/);
  const preview = await candidate(f, "preview");
  const manifest = path.join(preview, ".build-manifest.json");
  const value = JSON.parse(await fs.readFile(manifest));
  value.deployment = null;
  await fs.writeFile(manifest, JSON.stringify(value));
  await assert.rejects(publish(preview, f.destination), /primary build/);
  const collision = await candidate(f, "collision");
  await fs.writeFile(path.join(f.destination, "collision.js"), "old bytes");
  await assert.rejects(publish(collision, f.destination), /Asset URL collision/);
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert.equal(await fs.readFile(path.join(f.destination, "collision.js"), "utf8"), "old bytes");
});

test("an interrupted publisher lock blocks publication without deleting the lock", async (t) => {
  const f = await fixture(t);
  const artifact = await candidate(f, "locked");
  const before = await readLiveState(f.destination);
  await fs.mkdir(path.join(f.destination, ".publish-lock"));
  await assert.rejects(publish(artifact, f.destination), /Another publisher/);
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert((await fs.stat(path.join(f.destination, ".publish-lock"))).isDirectory());
});

test("legacy file migration preserves baseline and uses a single release pointer", async (t) => {
  const f = await fixture(t);
  const oldHtml = Buffer.from("old application");
  await fs.writeFile(path.join(f.destination, "index.html"), oldHtml);
  await fs.writeFile(
    path.join(f.destination, "release.json"),
    JSON.stringify({ sha256: digest(oldHtml) }),
  );
  const artifact = await candidate(f, "migrated");
  await publish(artifact, f.destination);
  assert.equal((await readLiveState(f.destination)).release.buildId, "migrated");
  assert.deepEqual(await fs.readFile(path.join(f.destination, "index.previous.html")), oldHtml);
});

test("primary source rejects dirty worktrees, other branches and missing deployed ancestry", async (t) => {
  const f = await fixture(t);
  const first = assertIntegratedSource(f.repository, "refs/heads/integration");
  await fs.writeFile(path.join(f.repository, "app.txt"), "uncommitted");
  assert.throws(
    () => assertIntegratedSource(f.repository, "refs/heads/integration"),
    /clean, committed/,
  );
  git(f.repository, ["add", "."]);
  git(f.repository, ["commit", "-qm", "Second"]);
  const second = assertIntegratedSource(f.repository, "refs/heads/integration", first);
  git(f.repository, ["checkout", "-qb", "task"]);
  assert.throws(
    () => assertIntegratedSource(f.repository, "refs/heads/integration"),
    /integration branch/,
  );
  git(f.repository, ["checkout", "integration"]);
  git(f.repository, ["reset", "--hard", first]);
  assert.throws(() => assertIntegratedSource(f.repository, "refs/heads/integration", second));
});

test("concurrent snapshots have private paths and committed snapshots ignore later edits", async (t) => {
  const f = await fixture(t);
  const options = {
    source: f.repository,
    sourceCommit: git(f.repository, ["rev-parse", "HEAD"]),
    committed: true,
    builds: path.join(f.root, "builds"),
  };
  await fs.writeFile(path.join(f.repository, "app.txt"), "later edit");
  const [a, b] = await Promise.all([snapshotSource(options), snapshotSource(options)]);
  assert.notEqual(a.root, b.root);
  assert.equal(a.sourceHash, b.sourceHash);
  assert.equal(await fs.readFile(path.join(a.root, "app.txt"), "utf8"), "first source");
  await fs.writeFile(path.join(a.root, "app.txt"), "build output");
  assert.equal(await fs.readFile(path.join(b.root, "app.txt"), "utf8"), "first source");
});

test("killing a publisher during staging leaves the previous release usable", async (t) => {
  const f = await fixture(t);
  await publish(await candidate(f, "before"), f.destination);
  const before = await readLiveState(f.destination);
  const artifact = await candidate(f, "interrupted");
  const manifestPath = path.join(artifact, ".build-manifest.json");
  const provenance = JSON.parse(await fs.readFile(manifestPath));
  await fs.rm(manifestPath);
  await fs.writeFile(path.join(artifact, "large.js"), randomBytes(4 * 1024 * 1024));
  delete provenance.files;
  await sealArtifact(artifact, provenance);
  let child;
  const watcher = watch(f.destination, (_event, name) => {
    if (name?.startsWith(".staging-")) child.kill("SIGKILL");
  });
  t.after(() => watcher.close());
  child = spawn(process.execPath, [publisher, artifact, f.destination], { stdio: "ignore" });
  const [, signal] = await once(child, "exit");
  watcher.close();
  assert.equal(signal, "SIGKILL");
  assert.equal((await readLiveState(f.destination)).token, before.token);
  assert.deepEqual(
    await fs.readFile(path.join(f.destination, "before.js")),
    await fs.readFile(path.join(f.root, "before", "before.js")),
  );
  await assert.rejects(publish(artifact, f.destination), /Another publisher/);
  // Recovery is allowed only after the owning process has exited.
  await fs.rm(path.join(f.destination, ".publish-lock"), { recursive: true });
  await publish(artifact, f.destination);
  assert.equal((await readLiveState(f.destination)).release.buildId, "interrupted");
});

async function protectedFixture(t) {
  const f = await fixture(t);
  f.protected = path.join(f.root, "protected");
  git(f.root, ["clone", "--no-hardlinks", f.repository, f.protected]);
  f.binding = await createPublicationBinding({
    destination: f.destination,
    sourceRepository: f.protected,
    integrationRef: "refs/heads/integration",
  });
  await fs.writeFile(publicationBindingPath(f.destination), JSON.stringify(f.binding), {
    mode: 0o600,
  });
  return f;
}
async function advanceSource(f) {
  await fs.writeFile(path.join(f.repository, "app.txt"), "new published source");
  git(f.repository, ["commit", "-qam", "New source"]);
  return git(f.repository, ["rev-parse", "HEAD"]);
}
async function checkoutState(repository) {
  return {
    head: git(repository, ["rev-parse", "HEAD"]),
    symbolic: git(repository, ["symbolic-ref", "HEAD"]),
    refs: git(repository, ["show-ref"]),
    status: git(repository, ["status", "--porcelain"]),
    config: await fs.readFile(path.join(repository, ".git", "config")),
    index: await fs.readFile(path.join(repository, ".git", "index")),
    files: await fs.readFile(path.join(repository, "app.txt")),
    fetchHead: await fs.readFile(path.join(repository, ".git", "FETCH_HEAD")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }),
  };
}

test("bound publication retains exact complete history without changing the protected checkout", async (t) => {
  const f = await protectedFixture(t);
  await fs.writeFile(path.join(f.protected, "app.txt"), "staged protected work");
  git(f.protected, ["add", "app.txt"]);
  await fs.writeFile(path.join(f.protected, "app.txt"), "unstaged protected work");
  await fs.writeFile(path.join(f.protected, "private.txt"), "untracked protected work");
  await fs.writeFile(path.join(f.protected, ".git", "FETCH_HEAD"), "preserve this fetch receipt\n");
  const before = await checkoutState(f.protected);
  const commit = await advanceSource(f);
  assert.throws(() => git(f.protected, ["cat-file", "-e", commit]));
  await publish(await candidate(f, "retained"), f.destination);
  const after = await checkoutState(f.protected);
  assert.deepEqual({ ...after, refs: before.refs }, before);
  assert.equal(after.refs, `${before.refs}\n${commit} refs/vorteo-publications/${commit}`);
  assert.equal((await readLiveState(f.destination)).release.sourceCommit, commit);
  await fs.rm(f.repository, { recursive: true });
  const reader = path.join(f.root, "reader.git");
  git(f.root, ["init", "--bare", reader]);
  git(reader, ["fetch", "--no-tags", f.protected, commit]);
  git(reader, ["fsck", "--full", "--strict", commit]);
  git(reader, ["merge-base", "--is-ancestor", before.head, commit]);
  assert.equal(git(reader, ["show", `${commit}:app.txt`]), "new published source");
  // Identical retention retries need no vanished publishing checkout.
  await retainPublicationSource({
    binding: f.binding,
    repository: f.repository,
    sourceCommit: commit,
  });
  assert.equal(
    await fs.readFile(path.join(f.protected, "private.txt"), "utf8"),
    "untracked protected work",
  );
});

test("retention ignores hostile source, target and inherited Git executable configuration", async (t) => {
  const f = await protectedFixture(t);
  const trap = path.join(f.root, "trap");
  await fs.writeFile(
    path.join(f.repository, "package.json"),
    JSON.stringify({ scripts: { postinstall: trap, prepare: trap } }),
  );
  await fs.writeFile(path.join(f.repository, ".gitattributes"), "* filter=trap diff=trap\n");
  git(f.repository, ["add", "."]);
  const commit = await advanceSource(f);
  const marker = path.join(f.root, "executed");
  await fs.writeFile(trap, `#!/bin/sh\necho executed >> '${marker}'\nexit 93\n`, { mode: 0o700 });
  const hooks = path.join(f.root, "hooks");
  await fs.mkdir(hooks);
  for (const hook of ["reference-transaction", "post-update", "pre-auto-gc", "post-checkout"])
    await fs.copyFile(trap, path.join(hooks, hook));
  for (const repository of [f.repository, f.protected]) {
    git(repository, ["config", "core.hooksPath", hooks]);
    git(repository, ["config", "core.fsmonitor", trap]);
    git(repository, ["config", "uploadpack.packObjectsHook", trap]);
    git(repository, ["config", "credential.helper", `!${trap}`]);
    git(repository, ["config", `url.ext::${trap}.insteadOf`, "/"]);
    git(repository, ["config", "core.alternateRefsCommand", trap]);
    git(repository, ["config", "filter.trap.smudge", trap]);
    git(repository, ["config", "filter.trap.clean", trap]);
    git(repository, ["config", "diff.trap.command", trap]);
  }
  const globalConfig = path.join(f.root, "hostile-global.config");
  await fs.writeFile(
    globalConfig,
    `[uploadpack]\npackObjectsHook = ${trap}\n[core]\nhooksPath = ${hooks}\n`,
  );
  const artifact = await candidate(f, "hostile");
  await run(process.execPath, [publisher, artifact, f.destination], {
    env: {
      ...process.env,
      HOME: f.root,
      XDG_CONFIG_HOME: f.root,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_DIR: path.join(f.root, "nonexistent"),
      GIT_WORK_TREE: f.root,
      GIT_EXEC_PATH: f.root,
      GIT_SSH_COMMAND: trap,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: f.root,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "uploadpack.packObjectsHook",
      GIT_CONFIG_VALUE_0: trap,
      GIT_CONFIG_KEY_1: "url.ext::bad.insteadOf",
      GIT_CONFIG_VALUE_1: "/",
    },
  });
  assert.equal((await readLiveState(f.destination)).release.sourceCommit, commit);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("a failed selection after retention leaves a reusable durable pin and unchanged legacy files", async (t) => {
  const f = await protectedFixture(t);
  const html = Buffer.from("verified legacy bytes");
  await fs.writeFile(path.join(f.destination, "index.html"), html);
  await fs.writeFile(
    path.join(f.destination, "release.json"),
    JSON.stringify({ sha256: digest(html) }),
  );
  const before = await readLiveState(f.destination);
  const commit = await advanceSource(f);
  const artifact = await candidate(f, "retry");
  await fs.writeFile(path.join(f.destination, ".releases"), "block release creation");
  await assert.rejects(publish(artifact, f.destination));
  assert.equal(git(f.protected, ["rev-parse", `refs/vorteo-publications/${commit}`]), commit);
  assert.equal((await readLiveState(f.destination)).token, before.token);
  await assert.rejects(fs.lstat(path.join(f.destination, ".current")), { code: "ENOENT" });
  await fs.rm(path.join(f.destination, ".releases"));
  await publish(artifact, f.destination);
  assert.equal((await readLiveState(f.destination)).release.sourceCommit, commit);
});

test("conflicting or unwritable pins fail before assets, selection and legacy migration", async (t) => {
  for (const mode of ["conflict", "blocked", "symbolic", "reader-refused"]) {
    await t.test(mode, async (subtest) => {
      const f = await protectedFixture(subtest);
      const base = git(f.repository, ["rev-parse", "HEAD"]);
      const commit = await advanceSource(f);
      if (mode === "conflict")
        git(f.protected, ["update-ref", `refs/vorteo-publications/${commit}`, base]);
      else if (mode === "symbolic")
        git(f.protected, ["symbolic-ref", `refs/vorteo-publications/${commit}`, "HEAD"]);
      else if (mode === "reader-refused")
        git(f.protected, ["config", "uploadpack.hideRefs", "refs/vorteo-publications"]);
      else
        await fs.writeFile(
          path.join(f.protected, ".git", "refs", "vorteo-publications"),
          "block pin",
        );
      const before = await readLiveState(f.destination);
      const artifact = await candidate(f, "refused");
      await assert.rejects(publish(artifact, f.destination));
      assert.equal((await readLiveState(f.destination)).token, before.token);
      for (const name of [".current", ".releases", "refused.js"])
        await assert.rejects(fs.lstat(path.join(f.destination, name)), { code: "ENOENT" });
      assert.equal(git(f.protected, ["rev-parse", "HEAD"]), base);
      if (mode === "reader-refused") {
        assert.equal(git(f.protected, ["rev-parse", `refs/vorteo-publications/${commit}`]), commit);
        git(f.protected, ["config", "--unset", "uploadpack.hideRefs"]);
        await publish(artifact, f.destination);
      }
    });
  }
});

test("incomplete source graphs and nonlocal sources cannot select a release", async (t) => {
  for (const mode of [
    "missing-blob",
    "shallow",
    "partial",
    "worktree-partial",
    "alternate",
    "url",
  ]) {
    await t.test(mode, async (subtest) => {
      const f = await protectedFixture(subtest);
      const commit = await advanceSource(f);
      const artifact = await candidate(f, "incomplete");
      if (mode === "missing-blob") {
        const blob = git(f.repository, ["rev-parse", `${commit}:app.txt`]);
        await fs.rm(path.join(f.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
      } else if (mode === "shallow") {
        await fs.writeFile(path.join(f.repository, ".git", "shallow"), commit + "\n");
      } else if (mode === "partial") {
        git(f.repository, ["config", "extensions.partialClone", "origin"]);
      } else if (mode === "worktree-partial") {
        git(f.repository, ["config", "extensions.worktreeConfig", "true"]);
        git(f.repository, ["config", "--worktree", "remote.lazy.promisor", "true"]);
        git(f.repository, ["config", "--worktree", "remote.lazy.url", "ext::must-never-execute"]);
      } else if (mode === "alternate") {
        await fs.writeFile(
          path.join(f.repository, ".git", "objects", "info", "alternates"),
          f.protected + "\n",
        );
      } else {
        const file = path.join(artifact, ".build-manifest.json");
        const manifest = JSON.parse(await fs.readFile(file));
        manifest.deployment.repository = "file://" + f.repository;
        await fs.writeFile(file, JSON.stringify(manifest));
      }
      const before = await readLiveState(f.destination);
      await assert.rejects(publish(artifact, f.destination));
      assert.equal((await readLiveState(f.destination)).token, before.token);
      await assert.rejects(fs.lstat(path.join(f.destination, ".current")), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(f.destination, "incomplete.js")), { code: "ENOENT" });
    });
  }
});

test("invalid, writable, symlink and noncanonical destination bindings fail closed", async (t) => {
  for (const mode of [
    "malformed",
    "writable",
    "symlink",
    "identity",
    "branch",
    "storage-symlink",
    "writable-parent",
  ]) {
    await t.test(mode, async (subtest) => {
      const f = await protectedFixture(subtest);
      const file = publicationBindingPath(f.destination);
      if (mode === "malformed") await fs.writeFile(file, "{");
      else if (mode === "writable") await fs.chmod(file, 0o666);
      else if (mode === "writable-parent") await fs.chmod(f.root, 0o777);
      else if (mode === "symlink") {
        await fs.rename(file, file + ".original");
        await fs.symlink(file + ".original", file);
      } else if (mode === "storage-symlink") {
        const refs = path.join(f.protected, ".git", "refs");
        await fs.rename(refs, refs + ".original");
        await fs.symlink(refs + ".original", refs);
      } else {
        const binding = { ...f.binding };
        if (mode === "identity") binding.sourceRepository += "/../protected";
        else binding.integrationRef = "refs/heads/other";
        await fs.writeFile(file, JSON.stringify(binding));
      }
      const artifact = await candidate(f, "invalid-binding");
      await assert.rejects(publish(artifact, f.destination));
      await assert.rejects(fs.lstat(path.join(f.destination, ".current")), { code: "ENOENT" });
    });
  }
});

test("same-repository binding and competing bound publishers preserve winner and pins", async (t) => {
  const f = await fixture(t);
  const binding = await createPublicationBinding({
    destination: f.destination,
    sourceRepository: f.repository,
    integrationRef: "refs/heads/integration",
  });
  await fs.writeFile(publicationBindingPath(f.destination), JSON.stringify(binding), {
    mode: 0o600,
  });
  const commit = git(f.repository, ["rev-parse", "HEAD"]);
  const a = await candidate(f, "bound-a");
  const b = await candidate(f, "bound-b");
  const results = await Promise.allSettled([publish(a, f.destination), publish(b, f.destination)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const live = await readLiveState(f.destination);
  assert.equal(git(f.repository, ["rev-parse", `refs/vorteo-publications/${commit}`]), commit);
  await assert.rejects(
    publish(live.release.buildId === "bound-a" ? b : a, f.destination),
    /Stale candidate/,
  );
  assert.equal((await readLiveState(f.destination)).token, live.token);
});

test("prepared primary builds bind the checkout, dependencies and committed snapshot", async (t) => {
  const { recordPreparedWebInputs, claimPreparedWebBuild } =
    await import("./lib/prepared-web-build.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-web-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = await fs.realpath(directory);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.test"]);
  git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(
    path.join(root, ".gitignore"),
    ".runtime/\nnode_modules/\n**/dist/\n**/build/\n",
  );
  const names = ["protocol", "relay", "client", "highlight", "plugin", "expo-two-way-audio"];
  const lock = { packages: { "": {} } };
  for (const name of names) {
    await fs.mkdir(path.join(root, "packages", name, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "packages", name, "src/index.ts"), "export {};\n");
    await fs.writeFile(path.join(root, "packages", name, "package.json"), JSON.stringify({ name }));
    lock.packages[`packages/${name}`] = {};
    const output = name === "expo-two-way-audio" ? "build" : "dist";
    await fs.mkdir(path.join(root, "packages", name, output));
    const file = name === "protocol" ? "messages.js" : "index.js";
    await fs.writeFile(path.join(root, "packages", name, output, file), "export {};\n");
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: names.map((n) => `packages/${n}`) }),
  );
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify(lock));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules/.package-lock.json"), "{}");
  await fs.mkdir(path.join(root, "node_modules/expo/bin"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules/expo/bin/cli"), "// fixture CLI\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  await recordPreparedWebInputs(root);
  const builds = path.join(root, ".runtime/builds");
  const { root: snapshot } = await snapshotSource({
    source: root,
    sourceCommit,
    committed: true,
    builds,
    retainArchive: true,
  });
  assert.ok(await fs.stat(snapshot + ".source.tar"));
  const options = { source: root, buildRoot: root, snapshot, sourceCommit };
  await assert.rejects(claimPreparedWebBuild({ ...options, buildRoot: snapshot }), /dedicated/);
  const claimed = await claimPreparedWebBuild(options);
  assert.equal(claimed.expoCli, path.join(root, "node_modules/expo/bin/cli"));
  await claimed.verify();
  await assert.rejects(claimPreparedWebBuild(options), /EEXIST/);
  await fs.writeFile(path.join(root, "packages/client/src/index.ts"), "changed\n");
  await assert.rejects(claimed.verify(), /drifted/);
  await fs.writeFile(path.join(root, "packages/client/src/index.ts"), "export {};\n");
  await fs.writeFile(path.join(root, "node_modules/.package-lock.json"), '{"changed":true}');
  await assert.rejects(claimed.verify(), /dependencies changed/);
  await claimed.release();
  assert.ok(await fs.stat(path.join(snapshot, "prepared-build-claim.json")));
  assert.ok(await fs.stat(path.join(root, "node_modules/.package-lock.json")));
});

test("prepared Expo resolution refuses missing and foreign CLIs without a package fallback", async (t) => {
  const { preparedExpoCli } = await import("./lib/prepared-web-build.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-expo-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = await fs.realpath(directory);
  const cli = path.join(root, "node_modules/expo/bin/cli");
  await assert.rejects(preparedExpoCli(root), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(root), []);
  await fs.mkdir(path.dirname(cli), { recursive: true });
  const foreign = path.join(root, "foreign-cli");
  await fs.writeFile(foreign, "// foreign CLI\n");
  await fs.symlink(foreign, cli);
  await assert.rejects(preparedExpoCli(root), /checkout-local Expo CLI/);
  await fs.unlink(cli);
  await fs.writeFile(cli, "// local CLI\n");
  assert.equal(await preparedExpoCli(root), cli);
});

test("prepared root options refuse invalid combinations before creating build artifacts", async () => {
  for (const args of [
    ["--build-root", process.cwd()],
    ["--retain-builds", "--build-root", process.cwd()],
    [
      "--retain-builds",
      "--build-root",
      process.cwd(),
      "--destination",
      "/not-used",
      "--installation-origin",
      "https://example.test",
    ],
  ]) {
    await assert.rejects(
      run(process.execPath, ["scripts/build-instance-web.mjs", ...args]),
      /requires --retain-builds and a primary application build/,
    );
  }
});
