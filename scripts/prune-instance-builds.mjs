#!/usr/bin/env node
// Remove abandoned web builds and old exports. Usage: node scripts/prune-instance-builds.mjs [BUILDS_DIR]
import os from "node:os";
import path from "node:path";
import { pruneInstanceBuildsOnce } from "./lib/instance-builds.mjs";

const builds = process.argv[2] ?? path.join(os.homedir(), ".cache", "paseo-instance-builds");
const removed = await pruneInstanceBuildsOnce(builds, {
  onError: (root, error) =>
    console.error(`Could not remove ${root}: ${error.code ?? error.message}`),
});
if (removed === null) console.log("Another pruner is already running");
else console.log(`Removed ${removed.length} build directories`);
