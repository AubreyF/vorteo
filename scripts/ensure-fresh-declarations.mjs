#!/usr/bin/env node
// Rebuild the protocol and client declarations that other packages typecheck
// against, but only when their sources changed since the last successful build.
// After a branch switch, git touches exactly the files that differ, so a stale
// build is caught here instead of failing the commit hook's typecheck.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STAMP = ".vorteo-build-stamp";

/** Each target's build also covers the packages listed in `sources`. */
export const TARGETS = [
  {
    name: "protocol",
    script: "build:protocol",
    stamp: "packages/protocol/dist",
    sources: ["packages/protocol/src", "packages/protocol/codegen", "packages/protocol/scripts"],
  },
  {
    // build:client rebuilds protocol and relay first.
    name: "client",
    script: "build:client",
    stamp: "packages/client/dist",
    sources: [
      "packages/protocol/src",
      "packages/protocol/codegen",
      "packages/protocol/scripts",
      "packages/relay/src",
      "packages/client/src",
    ],
  },
];

function newestMtime(directory) {
  if (!existsSync(directory)) return 0;
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(file));
    else if (entry.isFile()) newest = Math.max(newest, statSync(file).mtimeMs);
  }
  return newest;
}

/** Names of targets whose sources are newer than their last successful build. */
export function staleTargets(root, targets = TARGETS) {
  return targets
    .filter((target) => {
      const stamp = path.join(root, target.stamp, STAMP);
      if (!existsSync(stamp)) return true;
      const built = statSync(stamp).mtimeMs;
      return target.sources.some((source) => newestMtime(path.join(root, source)) > built);
    })
    .map((target) => target.name);
}

/** Rebuild what is stale. A client build also refreshes the protocol stamp it rebuilt. */
export function ensureFreshDeclarations(root, run = defaultRun, targets = TARGETS) {
  const stale = staleTargets(root, targets);
  const rebuilt = [];
  const build = (target) => {
    run(target.script, root);
    writeFileSync(path.join(root, target.stamp, STAMP), `${new Date().toISOString()}\n`);
    rebuilt.push(target.name);
  };
  const client = targets.find((target) => target.name === "client");
  const protocol = targets.find((target) => target.name === "protocol");
  if (stale.includes("client") && client) {
    build(client);
    if (protocol)
      writeFileSync(path.join(root, protocol.stamp, STAMP), `${new Date().toISOString()}\n`);
  } else if (stale.includes("protocol") && protocol) build(protocol);
  return rebuilt;
}

function defaultRun(script, root) {
  execFileSync("npm", ["run", script], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rebuilt = ensureFreshDeclarations(root);
  if (rebuilt.length) console.log(`Rebuilt stale declarations: ${rebuilt.join(", ")}`);
}
