#!/usr/bin/env node
// Publish static assets without restarting the daemon.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { compressFile } from "./compress-web-asset.mjs";
import { fallbackIcons, isReviewedFallback } from "./web-icon-migration.mjs";
import {
  digest,
  hashFiles,
  manifestName,
  readLiveState,
  readPublicationBinding,
  verifyPublicationSource,
  retainPublicationSource,
} from "./instance-web-artifact.mjs";

const [sourceArg, destinationArg] = process.argv.slice(2);
if (!sourceArg || !destinationArg || process.argv.length !== 4) {
  throw new Error(
    "Usage: node scripts/publish-instance-web.mjs EXPORTED_WEB_DIR PERSISTENT_WEB_DIR",
  );
}
const source = await fs.realpath(sourceArg);
const destination = await fs.realpath(destinationArg);
if (source === destination || destination.startsWith(source + path.sep)) {
  throw new Error("Publish destination must be outside the export directory");
}
const manifest = JSON.parse(await fs.readFile(path.join(source, manifestName), "utf8"));
if (
  manifest.version !== 1 ||
  !manifest.deployment ||
  !/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit)
) {
  throw new Error("A completed primary build with committed source is required.");
}
if (manifest.deployment.destination !== destination)
  throw new Error("Artifact targets another destination.");
const lock = path.join(destination, ".publish-lock");
try {
  await fs.mkdir(lock);
} catch (error) {
  if (error.code === "EEXIST")
    throw new Error(`Another publisher owns ${lock}. Never remove a live lock.`, { cause: error });
  throw error;
}
const id = crypto.randomUUID();
const staging = path.join(destination, `.staging-${id}`);
const releaseDirectory = path.join(destination, ".releases", id);
const iconAliases = new Map();
try {
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }),
  );
  const live = await readLiveState(destination);
  if (live.token !== manifest.deployment.expectedRelease) {
    throw new Error(
      "Stale candidate: live release changed. Integrate the deployed source and rebuild.",
    );
  }
  if (
    live.release?.integrationRef &&
    live.release.integrationRef !== manifest.deployment.integrationRef
  ) {
    throw new Error("Integration branch does not match the live release.");
  }
  const binding = await readPublicationBinding(destination);
  if (binding && binding.integrationRef !== manifest.deployment.integrationRef)
    throw new Error("Integration branch does not match the protected publication binding");
  // Verify ancestry again without requiring the checkout to remain unchanged.
  await verifyPublicationSource({
    repository: manifest.deployment.repository,
    sourceCommit: manifest.sourceCommit,
    previousCommit: live.release?.sourceCommit,
    requireComplete: Boolean(binding),
  });
  await fs.cp(source, staging, { recursive: true, dereference: false });
  const files = await hashFiles(staging);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("Artifact changed after build completion.");
  const html = await fs.readFile(path.join(staging, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  if (
    !scripts.length ||
    scripts.some((script) => !script.startsWith("/") || !files[script.slice(1)])
  ) {
    throw new Error("Export has missing or invalid entry scripts.");
  }
  const reserved = new Set(["index.html", "metadata.json"]);
  const assets = Object.keys(files).filter(
    (name) => !reserved.has(name) && !name.endsWith(".br") && !name.endsWith(".gz"),
  );
  for (const name of Object.keys(fallbackIcons)) {
    const target = await fs.readlink(path.join(destination, name)).catch((error) => {
      if (error.code === "ENOENT" || error.code === "EINVAL") return null;
      throw error;
    });
    if (target === `.current/${name}` && !assets.includes(name))
      throw new Error(`Export omits selected fallback icon: ${name}`);
  }
  for (const name of assets) {
    if (
      name.split("/").some((part) => part.startsWith(".")) ||
      name === "release.json" ||
      name === "index.previous.html"
    ) {
      throw new Error(`Reserved publication path: ${name}`);
    }
    const existing = await fs.readFile(path.join(destination, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const reviewedIcon = isReviewedFallback(name, existing ? digest(existing) : null, files[name]);
    if (reviewedIcon) iconAliases.set(name, existing);
    // Only exact reviewed icon aliases may change. Open clients retain every old chunk.
    if (!reviewedIcon && existing && digest(existing) !== files[name])
      throw new Error(`Asset URL collision: ${name}. Export a new content-addressed filename.`);
    if ([".js", ".css", ".json", ".svg", ".map"].includes(path.extname(name))) {
      await compressFile(path.join(staging, name));
    }
  }
  if (binding) {
    await retainPublicationSource({
      binding,
      repository: manifest.deployment.repository,
      sourceCommit: manifest.sourceCommit,
    });
  }
  const release = {
    publishedAt: new Date().toISOString(),
    sha256: digest(html),
    scripts,
    buildId: manifest.buildId,
    sourceCommit: manifest.sourceCommit,
    sourceHash: manifest.sourceHash,
    integrationRef: manifest.deployment.integrationRef,
    ...(manifest.entrypoint ? { entrypoint: manifest.entrypoint } : {}),
  };
  await fs.mkdir(releaseDirectory, { recursive: true });
  await fs.writeFile(path.join(releaseDirectory, "index.html"), html);
  await fs.writeFile(
    path.join(releaseDirectory, "release.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  for (const name of assets) {
    if (iconAliases.has(name)) {
      await fs.copyFile(path.join(staging, name), path.join(releaseDirectory, name));
      continue;
    }
    await installAsset(name);
    for (const extension of [".br", ".gz"]) {
      await installAsset(name + extension).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await prepareCurrent(live);
  await prepareIconAliases();
  if (live.index) await atomicFile(path.join(destination, "index.previous.html"), live.index);
  // One rename commits both index and receipt. A killed publisher leaves the old release selected.
  await atomicLink(path.join(destination, ".current"), `.releases/${id}`);
  console.log(JSON.stringify(release, null, 2));
} finally {
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(lock, { recursive: true, force: true });
}

async function installAsset(name) {
  const target = path.join(destination, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${id}.tmp`;
  try {
    await fs.copyFile(path.join(staging, name), temporary);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
async function atomicFile(target, bytes) {
  const temporary = `${target}.${id}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, target);
}
async function atomicLink(target, relative) {
  const temporary = `${target}.${id}.tmp`;
  await fs.symlink(relative, temporary);
  await fs.rename(temporary, target);
}
async function prepareIconAliases() {
  const selected = await fs.realpath(path.join(destination, ".current"));
  if (!selected.startsWith(path.join(destination, ".releases") + path.sep))
    throw new Error("Selected release must remain inside .releases");
  for (const [name, previous] of iconAliases) {
    if (previous) {
      const retained = path.join(selected, name);
      await fs.writeFile(retained, previous, { flag: "wx" }).catch(async (error) => {
        if (error.code !== "EEXIST") throw error;
        if (!(await fs.readFile(retained)).equals(previous))
          throw new Error(`Retained fallback icon differs: ${name}`);
      });
    }
    // Until .current switches, this still serves the exact previous icon bytes.
    await atomicLink(path.join(destination, name), `.current/${name}`);
  }
}
async function prepareCurrent(live) {
  const current = path.join(destination, ".current");
  const existing = await fs.lstat(current).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    const baseline = `.releases/baseline-${id}`;
    await fs.mkdir(path.join(destination, baseline), { recursive: true });
    if (live.index) await fs.writeFile(path.join(destination, baseline, "index.html"), live.index);
    if (live.receipt)
      await fs.writeFile(path.join(destination, baseline, "release.json"), live.receipt);
    await atomicLink(current, baseline);
  } else if (!existing.isSymbolicLink())
    throw new Error("Publication .current must be a symbolic link.");
  // Migration is resumable: each link initially resolves to the unchanged baseline bytes.
  await atomicLink(path.join(destination, "index.html"), ".current/index.html");
  await atomicLink(path.join(destination, "release.json"), ".current/release.json");
}
