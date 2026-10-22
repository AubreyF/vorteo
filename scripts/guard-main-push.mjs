#!/usr/bin/env node
// Pre-push guard: only Vorteo :: Builds pushes GitHub main (AGENTS.md, "Builds coordinator").
// Git passes one "<local ref> <local sha> <remote ref> <remote sha>" line per pushed ref.
import { readFileSync } from "node:fs";
import { isMainModule } from "./is-main-module.mjs";
import { isBuildsCoordinator } from "./lib/builds-guard.mjs";

export function pushesMain(input) {
  return input
    .split("\n")
    .some((line) => line.trim().split(/\s+/)[2] === "refs/heads/main");
}

if (isMainModule(import.meta.url)) {
  if (pushesMain(readFileSync(0, "utf8")) && !isBuildsCoordinator()) {
    console.error(
      "Only the Vorteo :: Builds thread pushes main. Push your task branch and hand it to Builds instead (AGENTS.md, Builds coordinator).",
    );
    process.exitCode = 1;
  }
}
