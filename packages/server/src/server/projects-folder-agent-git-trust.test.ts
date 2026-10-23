import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitCommandOptions, GitCommandResult } from "../utils/run-git-command.js";
import {
  resetProjectsFolderAgentTrustForTests,
  trustProjectsFolderRepositoryForAgents,
} from "./projects-folder-agent-git-trust.js";
import { gitSafeDirectoryValue } from "./projects-folder-git-trust.js";

let base: string;
let physical: string;
let logical: string;

beforeEach(() => {
  // The native resolver expands Windows 8.3 short names, as the module does.
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "projects-agent-trust-")));
  physical = path.join(base, "mount");
  logical = path.join(base, "owner-dev");
  mkdirSync(path.join(physical, "app", ".git"), { recursive: true });
  symlinkSync(physical, logical);
  resetProjectsFolderAgentTrustForTests();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function fakeGit(listed: string[]) {
  const calls: string[][] = [];
  const runGit = async (args: string[], _options: GitCommandOptions): Promise<GitCommandResult> => {
    calls.push(args);
    if (args.includes("--add")) listed.push(args.at(-1)!);
    return {
      stdout: args.includes("--get-all") ? listed.join("\n") : "",
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    };
  };
  return { calls, runGit };
}

describe("Projects folder global git trust for agents", () => {
  it("appends the exact physical path once when the folder is reached through an alias", async () => {
    const listed = ["/somewhere/else"];
    const { calls, runGit } = fakeGit(listed);
    const config = { root: logical, aliases: [physical] };
    const app = path.join(physical, "app");
    const entry = gitSafeDirectoryValue(app);
    expect(
      await trustProjectsFolderRepositoryForAgents(path.join(logical, "app"), { config, runGit }),
    ).toBe(entry);
    expect(calls).toContainEqual(["config", "--global", "--add", "safe.directory", entry]);
    // Already trusted: no second write, in this process or after a restart.
    expect(await trustProjectsFolderRepositoryForAgents(app, { config, runGit })).toBeNull();
    resetProjectsFolderAgentTrustForTests();
    expect(await trustProjectsFolderRepositoryForAgents(app, { config, runGit })).toBeNull();
    expect(calls.filter((args) => args.includes("--add"))).toHaveLength(1);
    expect(listed).toEqual(["/somewhere/else", entry]);
  });

  it("writes nothing where the folder is at its own path, outside it, or without aliases", async () => {
    const { calls, runGit } = fakeGit([]);
    mkdirSync(path.join(base, "elsewhere", ".git"), { recursive: true });
    const hostLike = { root: physical, aliases: ["/Users/guest/dev"] };
    expect(
      await trustProjectsFolderRepositoryForAgents(path.join(physical, "app"), {
        config: hostLike,
        runGit,
      }),
    ).toBeNull();
    expect(
      await trustProjectsFolderRepositoryForAgents(path.join(base, "elsewhere"), {
        config: { root: logical, aliases: [physical] },
        runGit,
      }),
    ).toBeNull();
    expect(
      await trustProjectsFolderRepositoryForAgents(path.join(physical, "app"), {
        config: { root: logical, aliases: [] },
        runGit,
      }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  it("logs and resolves to null when git fails", async () => {
    const warnings: unknown[] = [];
    const result = await trustProjectsFolderRepositoryForAgents(path.join(physical, "app"), {
      config: { root: logical, aliases: [physical] },
      runGit: async () => {
        throw new Error("could not lock config file");
      },
      logger: { info: () => undefined, warn: (entry: unknown) => warnings.push(entry) },
    });
    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
