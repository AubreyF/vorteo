#!/usr/bin/env node
// Creates an isolated task worktree from the freshly fetched integration
// branch, so a task never edits a shared checkout that holds other work.
// Usage: node scripts/task-worktree.mjs <slug> [--branch feat/<slug>]
//          [--base origin/main] [--root <directory>] [--no-install]
// The default location is a sibling of the repository: ../<repo>-<slug>.
// PASEO_TASK_WORKTREE_ROOT overrides the parent directory.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { git, hasCommit, parseArgs, repositoryRoot } from "./lib/delivery-git.mjs";
import { isMainModule } from "./is-main-module.mjs";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BRANCH_PREFIXES = ["feat/", "fix/", "chore/", "docs/", "refactor/", "perf/", "test/"];

export function planTaskWorktree({
  cwd,
  slug,
  branch,
  base = "origin/main",
  root,
  env = process.env,
}) {
  if (!SLUG.test(slug ?? "")) {
    throw new Error("Use a lowercase kebab-case slug, such as add-project-browser");
  }
  const branchName = branch ?? `feat/${slug}`;
  if (!BRANCH_PREFIXES.some((prefix) => branchName.startsWith(prefix))) {
    throw new Error(`Branch names start with ${BRANCH_PREFIXES.join(", ")}`);
  }
  const repository = repositoryRoot(cwd);
  // Worktrees share one Git directory; resolve the primary checkout's name.
  const common = path.resolve(repository, git(repository, ["rev-parse", "--git-common-dir"]));
  const primary = path.basename(common) === ".git" ? path.dirname(common) : repository;
  const parent = root ?? env.PASEO_TASK_WORKTREE_ROOT ?? path.dirname(primary);
  const location = path.join(parent, `${path.basename(primary)}-${slug}`);
  return { repository, base, branch: branchName, location };
}

export function createTaskWorktree(plan, { install = true } = {}) {
  if (existsSync(plan.location)) throw new Error(`${plan.location} already exists`);
  const remote = plan.base.includes("/") ? plan.base.split("/")[0] : null;
  if (remote) git(plan.repository, ["fetch", "--quiet", "--prune", remote]);
  if (!hasCommit(plan.repository, plan.base)) throw new Error(`${plan.base} does not exist`);
  if (hasCommit(plan.repository, `refs/heads/${plan.branch}`)) {
    throw new Error(`Branch ${plan.branch} already exists; choose another slug or branch`);
  }
  git(plan.repository, ["worktree", "add", "--quiet", "-b", plan.branch, plan.location, plan.base]);
  if (install && existsSync(path.join(plan.location, "package-lock.json"))) {
    // Each worktree owns its dependencies; a shared install writes through to other checkouts.
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: plan.location,
      stdio: "inherit",
    });
  }
  return plan;
}

function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ["no-install"],
    options: ["branch", "base", "root"],
  });
  const plan = planTaskWorktree({
    cwd: process.cwd(),
    slug: args._[0],
    branch: args.branch,
    base: args.base ?? "origin/main",
    root: args.root,
  });
  createTaskWorktree(plan, { install: !args["no-install"] });
  console.log(`Task worktree ready: ${plan.location} on ${plan.branch} from ${plan.base}`);
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
