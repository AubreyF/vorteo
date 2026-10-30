#!/usr/bin/env node
// Pre-push guard (AGENTS.md, "Builds coordinator"). Every change reaches main through a pull
// request, so nobody pushes main directly, Builds included. Only Builds pushes release tags.
// Git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per pushed ref.
import { readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";
import { isBuildsCoordinator } from "./lib/builds-guard.mjs";

const remoteRefs = (input) =>
  input
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[2])
    .filter(Boolean);

export function pushesMain(input) {
  return remoteRefs(input).includes("refs/heads/main");
}

export function pushesReleaseTag(input) {
  return remoteRefs(input).some((ref) => ref.startsWith("refs/tags/release-"));
}

/** The refusal for a push, or null when it may proceed. */
export function refusePush(input, env = process.env) {
  if (pushesMain(input)) {
    return "main changes only through a pull request. Push your branch and hand it to Builds, which delivers it with scripts/publish-main.mjs (docs/task-delivery.md).";
  }
  if (pushesReleaseTag(input) && !isBuildsCoordinator(env)) {
    return "Only the Vorteo :: Builds thread creates release tags, with scripts/vorteo-release.mjs (docs/release.md).";
  }
  return null;
}

if (isMainModule(import.meta.url)) {
  const refusal = refusePush(readFileSync(0, "utf8"));
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
  }
}
