import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../utils/run-git-command.js";
import { setActiveProjectsFolder } from "./projects-folder.js";
import {
  findProjectsFolderRepository,
  safeDirectoryEnv,
  withProjectsFolderSafeDirectory,
} from "./projects-folder-git-trust.js";

// A Dev-like layout: `physical` is the mount, and `logical` is a symlink to it that the
// daemon records as the root, as when a container reaches the folder through an alias.
let base: string;
let physical: string;
let logical: string;
let outside: string;

function makeRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", directory]);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "projects-git-trust-")));
  physical = path.join(base, "mount");
  logical = path.join(base, "owner-dev");
  outside = path.join(base, "elsewhere");
  mkdirSync(physical);
  symlinkSync(physical, logical);
  setActiveProjectsFolder({ root: logical, aliases: [physical], allowOutside: [] });
});

afterEach(() => {
  setActiveProjectsFolder(undefined);
  rmSync(base, { recursive: true, force: true });
});

const envOf = (overlay: Record<string, string | undefined> | undefined) =>
  Object.fromEntries(Object.entries(overlay ?? {}).filter(([key]) => key.startsWith("GIT_CONFIG")));

describe("Projects folder per-invocation git trust", () => {
  it("trusts a repository inside the folder by its physical top level", () => {
    makeRepository(path.join(physical, "app"));
    expect(
      envOf(withProjectsFolderSafeDirectory(path.join(logical, "app"), undefined, {})),
    ).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: path.join(physical, "app"),
    });
  });

  it("gives the same entry for an alias-path cwd and a subdirectory", () => {
    makeRepository(path.join(physical, "app"));
    mkdirSync(path.join(physical, "app", "packages", "web"), { recursive: true });
    for (const cwd of [path.join(physical, "app"), path.join(logical, "app", "packages", "web")]) {
      expect(withProjectsFolderSafeDirectory(cwd, undefined, {})?.GIT_CONFIG_VALUE_0).toBe(
        path.join(physical, "app"),
      );
    }
  });

  it("trusts a linked worktree under .vorteo/worktrees by its own top level", () => {
    const worktree = path.join(logical, ".vorteo", "worktrees", "abc", "feature");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${logical}/app/.git/worktrees/feature\n`);
    expect(findProjectsFolderRepository({ root: logical, aliases: [physical] }, worktree)).toEqual({
      physical: path.join(physical, ".vorteo", "worktrees", "abc", "feature"),
      throughAlias: true,
    });
  });

  it("gives no override outside the folder and its aliases, or outside a repository", () => {
    makeRepository(outside);
    mkdirSync(path.join(physical, "plain"));
    for (const cwd of [outside, path.join(physical, "plain"), path.join(base, "missing")]) {
      expect(withProjectsFolderSafeDirectory(cwd, { KEEP: "1" }, {})).toEqual({ KEEP: "1" });
    }
    // A folder sharing the root's prefix is outside it.
    makeRepository(`${physical}-other`);
    expect(withProjectsFolderSafeDirectory(`${physical}-other`, undefined, {})).toBeUndefined();
  });

  it("gives no override without a Projects folder", () => {
    makeRepository(path.join(physical, "app"));
    setActiveProjectsFolder(undefined);
    expect(withProjectsFolderSafeDirectory(path.join(physical, "app"), undefined, {})).toBe(
      undefined,
    );
  });

  it("appends after existing GIT_CONFIG_COUNT entries from the overlay or the base env", () => {
    makeRepository(path.join(physical, "app"));
    const cwd = path.join(physical, "app");
    const fromOverlay = withProjectsFolderSafeDirectory(
      cwd,
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.x", GIT_CONFIG_VALUE_0: "y" },
      { GIT_CONFIG_COUNT: "5" },
    );
    expect(envOf(fromOverlay)).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.x",
      GIT_CONFIG_VALUE_0: "y",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: cwd,
    });
    expect(
      envOf(withProjectsFolderSafeDirectory(cwd, undefined, { GIT_CONFIG_COUNT: "3" })),
    ).toEqual({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_3: "safe.directory",
      GIT_CONFIG_VALUE_3: cwd,
    });
    expect(safeDirectoryEnv([cwd], () => "not a number")).toEqual({});
  });

  describe("with git", () => {
    let isolation: Record<string, string>;
    beforeEach(() => {
      const globalConfig = path.join(base, "global.gitconfig");
      writeFileSync(globalConfig, "");
      // Makes git treat every repository as owned by someone else, as Dev's git sometimes
      // does, with no user or system config that could already trust it.
      isolation = {
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      };
    });

    it("runs in a refused repository inside the folder, by alias or logical path", async () => {
      makeRepository(path.join(physical, "app"));
      for (const cwd of [path.join(logical, "app"), path.join(physical, "app")]) {
        const result = await runGitCommand(["rev-parse", "--show-toplevel"], {
          cwd,
          envOverlay: isolation,
        });
        expect(result.stdout.trim()).toBe(path.join(physical, "app"));
      }
    });

    it("still refuses a repository outside the folder", async () => {
      makeRepository(outside);
      await expect(
        runGitCommand(["rev-parse", "--show-toplevel"], { cwd: outside, envOverlay: isolation }),
      ).rejects.toThrow("dubious ownership");
    });
  });
});
