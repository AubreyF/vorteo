import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const manifestName = ".build-manifest.json";
export function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
export function git(repository, args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

export async function readLiveState(destination) {
  async function read(name) {
    return fs.readFile(path.join(destination, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  const index = await read("index.html");
  const receipt = await read("release.json");
  const release = receipt ? JSON.parse(receipt.toString()) : null;
  if (release && (!index || release.sha256 !== digest(index))) {
    throw new Error(
      "Live index and release receipt disagree; recover publication before building.",
    );
  }
  return {
    token: digest(JSON.stringify([index && digest(index), receipt && digest(receipt)])),
    release,
    index,
    receipt,
  };
}

export function assertIntegratedSource(repository, integrationRef, previousCommit) {
  if (!integrationRef.startsWith("refs/heads/")) {
    throw new Error("Use a full local integration branch reference: refs/heads/<branch>.");
  }
  if (git(repository, ["symbolic-ref", "HEAD"]) !== integrationRef) {
    throw new Error("Primary builds must run from the configured integration branch.");
  }
  if (git(repository, ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Primary builds require clean, committed integration source.");
  }
  const commit = git(repository, ["rev-parse", "HEAD"]);
  if (previousCommit) {
    execFileSync("git", ["merge-base", "--is-ancestor", previousCommit, commit], {
      cwd: repository,
      stdio: "pipe",
    });
  }
  return commit;
}

export async function hashFiles(directory, { allowSourceLinks = false } = {}) {
  const files = {};
  async function visit(relative) {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (name === manifestName) continue;
      if (entry.isSymbolicLink()) {
        if (!allowSourceLinks) throw new Error(`Symbolic link in artifact: ${name}`);
        const target = await fs.readlink(path.join(directory, name));
        const resolved = path.resolve(directory, path.dirname(name), target);
        if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(directory) + path.sep)) {
          throw new Error(`Source link escapes snapshot: ${name}`);
        }
        files[name] = digest(`symlink:${target}`);
        continue;
      }
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = digest(await fs.readFile(path.join(directory, name)));
      else throw new Error(`Unsupported artifact entry: ${name}`);
    }
  }
  await visit("");
  return files;
}

export async function sealArtifact(directory, provenance) {
  const files = await hashFiles(directory);
  if (!files["index.html"]) throw new Error("Build did not produce index.html.");
  await fs.writeFile(
    path.join(directory, manifestName),
    JSON.stringify({ version: 1, ...provenance, files }, null, 2) + "\n",
    { flag: "wx" },
  );
}

export async function snapshotSource({
  source,
  sourceCommit,
  committed,
  builds,
  retainArchive = false,
}) {
  await fs.mkdir(builds, { recursive: true });
  const root = await fs.mkdtemp(path.join(builds, "build-"));
  if (committed) {
    // Archive the chosen commit so concurrent edits cannot contaminate a primary build.
    const archive = retainArchive ? root + ".source.tar" : path.join(root, ".source.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, sourceCommit], {
      cwd: source,
    });
    execFileSync("tar", ["-xf", archive, "-C", root]);
    if (!retainArchive) await fs.rm(archive);
  } else {
    const files = git(source, ["ls-files", "-co", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean);
    for (const relative of new Set(files)) {
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error("Invalid source path");
      const from = path.join(source, relative);
      const stat = await fs.lstat(from).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (!stat.isFile() && !stat.isSymbolicLink())
        throw new Error(`Unsupported source entry: ${relative}`);
      const to = path.join(root, relative);
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to);
      else await fs.copyFile(from, to);
    }
  }
  return {
    root,
    sourceHash: digest(JSON.stringify(await hashFiles(root, { allowSourceLinks: true }))),
  };
}

// Match source-batch isolation: inherited Git settings must not select programs,
// credentials, replacement objects or a different object store.
async function withPublicationGit(action) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "publication-source-"));
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    XDG_CONFIG_HOME: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const settings = [
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.logAllRefUpdates=false",
    "gc.auto=0",
    "maintenance.auto=false",
    "protocol.allow=never",
    "protocol.file.allow=always",
    "fetch.fsckObjects=true",
    "transfer.fsckObjects=true",
    "credential.helper=",
    "core.fsync=committed",
  ];
  const options = settings.flatMap((setting) => ["-c", setting]);
  function run(args, extra = {}) {
    return (
      execFileSync("git", [...options, ...args], {
        env,
        cwd: temporary,
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        ...extra,
      })?.trim() ?? ""
    );
  }
  async function repository(directory, { complete = true } = {}) {
    if (typeof directory !== "string" || !path.isAbsolute(directory))
      throw new Error("Publication source must be an absolute local repository path");
    const canonical = await fs.realpath(directory);
    const gitDirectory = await fs.realpath(
      run(["-C", canonical, "rev-parse", "--absolute-git-dir"]),
    );
    const commonDirectory = await fs.realpath(
      run(["--git-dir", gitDirectory, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (!complete) return { repository: canonical, gitDirectory, commonDirectory };
    // Git may place a worktree's gitdir elsewhere; bind both resolved roots.
    // Storage-directory symlinks would escape the installer's mount protection.
    for (const relative of [
      "objects",
      "objects/pack",
      "refs",
      "refs/vorteo-publications",
      "logs",
      "logs/refs",
      "logs/refs/vorteo-publications",
    ]) {
      const storage = path.join(commonDirectory, relative);
      const resolved = await fs.realpath(storage).catch(missing);
      if (resolved && resolved !== storage)
        throw new Error("Publication Git storage must not use symlink directories");
    }
    const objects = path.join(commonDirectory, "objects");
    const partial = run(["--git-dir", gitDirectory, "config", "--includes", "--list"])
      .split("\n")
      .some((line) => /^(extensions\.partialclone|remote\..*\.promisor)=/i.test(line));
    const shallow = await fs.stat(path.join(commonDirectory, "shallow")).catch(missing);
    const alternates = await fs.stat(path.join(objects, "info", "alternates")).catch(missing);
    const packs = await fs.readdir(path.join(objects, "pack")).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (partial || shallow || alternates || packs.some((name) => name.endsWith(".promisor")))
      throw new Error(
        "Publication requires complete repositories without shallow, partial or alternate object stores",
      );
    return { repository: canonical, gitDirectory, commonDirectory };
  }
  try {
    return await action({ temporary, run, repository, options });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
function missing(error) {
  if (error.code === "ENOENT") return null;
  throw error;
}
function assertPublicationCommit(commit) {
  if (typeof commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    throw new Error("Publication requires an exact source commit");
}

export function publicationBindingPath(destination) {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.source-publication.json`,
  );
}

export async function createPublicationBinding({ destination, sourceRepository, integrationRef }) {
  return withPublicationGit(async ({ run, repository }) => {
    if (typeof destination !== "string" || !path.isAbsolute(destination))
      throw new Error("Publication binding requires an absolute destination path");
    const webDirectory = await fs.realpath(destination);
    if (!integrationRef?.startsWith("refs/heads/"))
      throw new Error("Publication binding requires a full integration branch reference");
    run(["check-ref-format", integrationRef]);
    const identity = await repository(sourceRepository);
    return {
      version: 1,
      webDirectory,
      sourceRepository: identity.repository,
      gitDirectory: identity.gitDirectory,
      commonDirectory: identity.commonDirectory,
      integrationRef,
    };
  });
}

export async function readPublicationBinding(destination) {
  const file = publicationBindingPath(destination);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(missing);
  if (!handle) return null; // Standalone static destinations do not require installation setup.
  let binding;
  try {
    const parent = await fs.stat(path.dirname(file));
    if (parent.mode & 0o022 || parent.uid !== process.getuid())
      throw new Error("Publication binding parent must remain protected and Host-owned");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o022 || stat.uid !== process.getuid())
      throw new Error("Publication binding must be a protected regular Host-owned file");
    binding = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  const expected = await createPublicationBinding({
    destination,
    sourceRepository: binding.sourceRepository,
    integrationRef: binding.integrationRef,
  });
  const keys = Object.keys(expected);
  if (
    Object.keys(binding).length !== keys.length ||
    keys.some((key) => binding[key] !== expected[key])
  )
    throw new Error(
      "Publication binding does not match its canonical destination and repository identity",
    );
  return binding;
}

export async function verifyPublicationSource({
  repository,
  sourceCommit,
  previousCommit,
  requireComplete = false,
}) {
  assertPublicationCommit(sourceCommit);
  if (previousCommit) assertPublicationCommit(previousCommit);
  await withPublicationGit(async ({ run, repository: inspect }) => {
    const { gitDirectory } = await inspect(repository, { complete: requireComplete });
    run(["--git-dir", gitDirectory, "cat-file", "-e", `${sourceCommit}^{commit}`]);
    if (previousCommit)
      run(["--git-dir", gitDirectory, "merge-base", "--is-ancestor", previousCommit, sourceCommit]);
  });
}

/** Retain source before selection. No checkout, source scripts, branch updates or remote configuration. */
export async function retainPublicationSource({ binding, repository, sourceCommit }) {
  assertPublicationCommit(sourceCommit);
  await withPublicationGit(async ({ temporary, run, repository: inspect, options }) => {
    // Git 2.38 documents packObjectsHook as protected-config only. Removing
    // global/system/inherited command config therefore disables the source hook.
    const version = run(["version"]).match(/^git version (\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 38))
      throw new Error("Protected publication requires Git 2.38 or newer");
    const target = await inspect(binding.sourceRepository);
    if (
      target.gitDirectory !== binding.gitDirectory ||
      target.commonDirectory !== binding.commonDirectory
    )
      throw new Error("Publication source repository identity changed");
    const format = run(["--git-dir", target.gitDirectory, "rev-parse", "--show-object-format"]);
    const pin = `refs/vorteo-publications/${sourceCommit}`;
    function pinned() {
      try {
        run(["--git-dir", target.gitDirectory, "symbolic-ref", "--quiet", pin]);
        throw new Error("Publication source pin must not be a symbolic reference");
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      try {
        return run(["--git-dir", target.gitDirectory, "rev-parse", "--verify", "--quiet", pin]);
      } catch (error) {
        if (error.status === 1) return null;
        throw error;
      }
    }
    const existing = pinned();
    if (existing && existing !== sourceCommit)
      throw new Error("Conflicting publication source pin");
    function initialize(name) {
      const directory = path.join(temporary, name);
      run(["init", "--bare", "--template=", `--object-format=${format}`, directory]);
      return directory;
    }
    // The receiver imports no config, and both sides receive the fixed command
    // options. packObjectsHook is absent from all protected config scopes.
    const uploadPack = ["git", ...options, "upload-pack"].join(" ");
    function fetch(directory, source, ref) {
      run([
        "--git-dir",
        directory,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        `--upload-pack=${uploadPack}`,
        source,
        `${ref}:refs/heads/retained`,
      ]);
      if (run(["--git-dir", directory, "rev-parse", "--is-shallow-repository"]) !== "false")
        throw new Error("Retained source fetch produced an incomplete shallow graph");
      const fetched = run(["--git-dir", directory, "rev-parse", "refs/heads/retained"]);
      if (fetched !== sourceCommit)
        throw new Error("Retained source fetch returned another commit");
      run(["--git-dir", directory, "fsck", "--full", "--strict", "--no-reflogs", sourceCommit]);
    }
    if (!existing) {
      const source = await inspect(repository);
      const incoming = initialize("incoming.git");
      fetch(incoming, source.repository, sourceCommit);
      const packFile = await fs.open(path.join(temporary, "source.pack"), "wx", 0o600);
      try {
        run(["--git-dir", incoming, "pack-objects", "--stdout", "--revs"], {
          input: `${sourceCommit}\n`,
          stdio: ["pipe", packFile.fd, "pipe"],
        });
      } finally {
        await packFile.close();
      }
      const pack = await fs.open(path.join(temporary, "source.pack"), "r");
      try {
        // Import objects directly, so target-local URL rewrites/remotes cannot
        // redirect a fetch. Only the additive CAS pin changes repository refs.
        run(["--git-dir", target.gitDirectory, "index-pack", "--stdin", "--strict"], {
          stdio: [pack.fd, "pipe", "pipe"],
        });
      } finally {
        await pack.close();
      }
      try {
        run([
          "--git-dir",
          target.gitDirectory,
          "update-ref",
          "--no-deref",
          pin,
          sourceCommit,
          "0".repeat(sourceCommit.length),
        ]);
      } catch (error) {
        if (pinned() !== sourceCommit) throw error;
      }
    }
    // A separate reader must obtain its entire graph from protected storage.
    fetch(initialize("reader.git"), target.repository, pin);
  });
}
