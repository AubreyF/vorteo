#!/usr/bin/env node
// Every Vorteo commit bumps the version in every workspace manifest and the
// lockfile. Those bumps match the `workspace` and package routing groups in
// .github/ci-paths.yml, which made every pull request run the full suite.
//
// Before path filtering, this script restores each manifest whose only change
// is the Vorteo version to its merge-base content and records that in a local,
// never-pushed commit. The path filter then sees only substantive changes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST = /(^|\/)(package\.json|package-lock\.json)$/;

/** True when the texts differ only where one version string replaced the other. */
export function isVersionOnlyChange(baseText, headText, baseVersion, headVersion) {
  if (!baseVersion || !headVersion || baseVersion === headVersion) return false;
  return baseText.replaceAll(baseVersion, "\0") === headText.replaceAll(headVersion, "\0");
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function showOrNull(revision, path) {
  try {
    return git("show", `${revision}:${path}`);
  } catch {
    return null;
  }
}

function main(base) {
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const baseVersion = JSON.parse(git("show", `${mergeBase}:package.json`)).version;
  const headVersion = JSON.parse(git("show", "HEAD:package.json")).version;
  const changed = git("diff", "--name-only", `${mergeBase}...HEAD`).split("\n").filter(Boolean);

  const restored = [];
  for (const path of changed.filter((file) => MANIFEST.test(file))) {
    const baseText = showOrNull(mergeBase, path);
    const headText = showOrNull("HEAD", path);
    if (baseText === null || headText === null) continue;
    if (!isVersionOnlyChange(baseText, headText, baseVersion, headVersion)) continue;
    writeFileSync(path, baseText);
    restored.push(path);
  }

  if (restored.length === 0) {
    console.log("No version-only manifest changes.");
    return;
  }
  git("add", "--", ...restored);
  git(
    "-c",
    "user.name=ci-routing",
    "-c",
    "user.email=ci-routing@localhost",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    "Routing view without version-only manifest bumps",
  );
  console.log(`Ignored version-only changes in:\n${restored.join("\n")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2];
  if (!base) throw new Error("usage: ci-neutralize-version-bumps.mjs <base-sha>");
  main(base);
}
