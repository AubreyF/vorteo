// Agents and terminals run their own git, which the daemon's per-invocation trust does not
// reach. When the daemon registers a project or creates a Paseo-owned worktree whose real
// path lies under an alias of the Projects folder, such as a Dev container that reaches the
// folder through a symlink, it appends that exact physical path to the daemon user's
// global `safe.directory` once, so git before 2.46 trusts it there too. No wildcard is
// written, and daemons that see the folder at its own path (the Host) write nothing.
// Self-contained so an installation can drop it without touching per-invocation trust.
// See docs/execution-installation.md#projects-folder.
import os from "node:os";
import type { Logger } from "pino";
import { runGitCommand, type RunGitCommand } from "../utils/run-git-command.js";
import {
  findProjectsFolderRepository,
  gitSafeDirectoryValue,
} from "./projects-folder-git-trust.js";
import { activeProjectsFolderConfig, type ProjectsFolderConfig } from "./projects-folder.js";

export interface TrustRepositoryForAgentsDependencies {
  config?: Pick<ProjectsFolderConfig, "root" | "aliases"> | null;
  runGit?: RunGitCommand;
  logger?: Pick<Logger, "info" | "warn">;
}

// Paths already present or added in this process; avoids a git process per registration.
const trustedThisProcess = new Set<string>();
// Serializes writes, because concurrent `git config --add` calls contend for one lock.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Adds the physical top level of the repository at `directory` to the global
 * `safe.directory` list when it is reached through a Projects folder alias and not yet
 * listed. Never throws: a failure is logged and leaves git's behavior unchanged.
 * Resolves to the added path, or null when nothing was written.
 */
export function trustProjectsFolderRepositoryForAgents(
  directory: string,
  dependencies: TrustRepositoryForAgentsDependencies = {},
): Promise<string | null> {
  const config =
    dependencies.config === undefined ? activeProjectsFolderConfig() : dependencies.config;
  if (!config?.aliases.length) return Promise.resolve(null);
  const repository = findProjectsFolderRepository(config, directory);
  if (!repository?.throughAlias) return Promise.resolve(null);
  const physical = gitSafeDirectoryValue(repository.physical);
  if (trustedThisProcess.has(physical)) return Promise.resolve(null);
  const runGit = dependencies.runGit ?? runGitCommand;
  const operation = queue.then(async () => {
    if (trustedThisProcess.has(physical)) return null;
    // Runs outside the folder, so this command itself gets no per-invocation trust.
    const options = { cwd: os.homedir(), acceptExitCodes: [0, 1] };
    try {
      const listed = await runGit(["config", "--global", "--get-all", "safe.directory"], options);
      if (listed.stdout.split("\n").includes(physical)) {
        trustedThisProcess.add(physical);
        return null;
      }
      await runGit(["config", "--global", "--add", "safe.directory", physical], {
        cwd: os.homedir(),
      });
      trustedThisProcess.add(physical);
      dependencies.logger?.info(
        { directory: physical },
        "Trusted a Projects folder repository for agents and terminals",
      );
      return physical;
    } catch (error) {
      dependencies.logger?.warn(
        { err: error, directory: physical },
        "Could not trust a Projects folder repository for agents and terminals",
      );
      return null;
    }
  });
  queue = operation;
  return operation;
}

/** Test hook: forgets paths trusted in this process. */
export function resetProjectsFolderAgentTrustForTests(): void {
  trustedThisProcess.clear();
}
