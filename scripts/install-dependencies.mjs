#!/usr/bin/env node
// Install this checkout's dependencies, cloning a cached install when possible.
// Usage: node scripts/install-dependencies.mjs [--mode worktree|build]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { installDependencies } from "./lib/dependency-cache.mjs";

const { values } = parseArgs({ options: { mode: { type: "string", default: "worktree" } } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
installDependencies({ root, mode: values.mode });
