// Reuse only this private checkout, with inputs recorded after build:app-deps.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { dependencyKey } from "./dependency-cache.mjs";
import { digest, git, hashFiles } from "../instance-web-artifact.mjs";

const receiptName = ".runtime/prepared-web-inputs.json";
const packages = ["protocol", "relay", "client", "highlight", "plugin", "expo-two-way-audio"];
export async function preparedExpoCli(root) {
  const cli = path.join(root, "node_modules/expo/bin/cli");
  const info = await fs.lstat(cli);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022 ||
    (await fs.realpath(cli)) !== cli
  )
    throw new Error("Prepared build requires the checkout-local Expo CLI");
  return cli;
}

async function identity(file) {
  const s = await fs.lstat(file);
  if (!s.isFile() || s.uid !== process.getuid?.()) throw new Error("Unowned prepared input");
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs];
}

async function inputs(root) {
  const npmVersion = execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim();
  const generatedSources = digest(
    git(root, ["ls-tree", "-r", "HEAD", "--", ...packages.map((name) => `packages/${name}`)])
      .split("\n")
      .filter((line) => !line.endsWith("/package.json"))
      .join("\n"),
  );
  const outputIdentities = {};
  async function visit(directory) {
    for (const entry of (
      await fs.readdir(path.join(root, directory), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else outputIdentities[file] = await identity(path.join(root, file));
    }
  }
  for (const name of packages) {
    const directory = `packages/${name}/${name === "expo-two-way-audio" ? "build" : "dist"}`;
    await visit(directory);
    if (
      !Object.keys(outputIdentities).some(
        (file) => file.startsWith(directory + "/") && file.endsWith(".js"),
      )
    )
      throw new Error(`Missing prepared app output: ${name}`);
  }
  const modules = path.join(root, "node_modules");
  if ((await fs.realpath(modules)) !== modules) throw new Error("Foreign prepared dependencies");
  const expoCli = await preparedExpoCli(root);
  return {
    root,
    dependencyKey: dependencyKey(root, "worktree", { npmVersion }),
    generatedSources,
    installedLock: digest(await fs.readFile(path.join(modules, ".package-lock.json"))),
    expoCli: {
      path: expoCli,
      identity: await identity(expoCli),
      sha256: digest(await fs.readFile(expoCli)),
    },
    outputIdentities,
  };
}

/** Call only after a successful build:app-deps in this checkout. No build/install is run here. */
export async function recordPreparedWebInputs(root) {
  root = await fs.realpath(root);
  const value = await inputs(root);
  await fs.mkdir(path.join(root, ".runtime"), { recursive: true });
  await fs.writeFile(path.join(root, receiptName), JSON.stringify(value) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

export async function claimPreparedWebBuild({ source, buildRoot, snapshot, sourceCommit }) {
  if (path.resolve(buildRoot) !== source || (await fs.realpath(buildRoot)) !== source)
    throw new Error("Prepared build root must be this dedicated source checkout");
  const runtime = path.join(source, ".runtime");
  for (const directory of [source, runtime]) {
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o022 ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("Prepared build requires private physical directories");
  }
  const receiptInfo = await fs.lstat(path.join(source, receiptName));
  if (
    !receiptInfo.isFile() ||
    receiptInfo.nlink !== 1 ||
    receiptInfo.uid !== process.getuid?.() ||
    receiptInfo.mode & 0o077
  )
    throw new Error("Unprotected prepared input receipt");
  const receipt = JSON.parse(await fs.readFile(path.join(source, receiptName), "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(await inputs(source)))
    throw new Error("Prepared app dependencies changed; build:app-deps evidence required");
  const lock = path.join(source, ".runtime/prepared-web-build.lock");
  const handle = await fs.open(lock, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, sourceCommit, snapshot }) + "\n");
  await handle.sync();
  await handle.close();
  const expected = await hashFiles(snapshot, { allowSourceLinks: true });
  delete expected[".build-owner.json"];
  async function verify() {
    if (
      git(source, ["rev-parse", "HEAD"]) !== sourceCommit ||
      git(source, ["status", "--porcelain"])
    )
      throw new Error("Prepared build source drifted");
    for (const [file, hash] of Object.entries(expected)) {
      const target = path.join(source, file);
      const s = await fs.lstat(target);
      const actual = s.isSymbolicLink()
        ? digest(`symlink:${await fs.readlink(target)}`)
        : digest(await fs.readFile(target));
      if (actual !== hash) throw new Error(`Prepared source differs from snapshot: ${file}`);
    }
    if (JSON.stringify(receipt) !== JSON.stringify(await inputs(source)))
      throw new Error("Prepared app dependencies changed during export");
  }
  async function release() {
    // Preserve claims for diagnosis, including failures. Never take over a stale lock.
    await fs.rename(lock, path.join(snapshot, "prepared-build-claim.json"));
  }
  try {
    await verify();
  } catch (error) {
    await release();
    throw error;
  }
  return { verify, release, receipt, expoCli: receipt.expoCli.path };
}
