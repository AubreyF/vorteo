import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateRegistryPathsToProjectsFolder } from "./projects-folder-paths.migration.js";

const OLD = "/Users/guest/dev";
const ROOT = "/Users/owner/dev";
const logger = { info: () => undefined, warn: () => undefined };

describe("Projects folder registry path migration", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "projects-migration-"));
    await mkdir(path.join(home, "projects"));
    await writeFile(
      path.join(home, "projects", "projects.json"),
      JSON.stringify([
        { projectId: "prj_dev", rootPath: OLD, projectKey: `host:srv_1:${OLD}` },
        { projectId: "prj_app", rootPath: `${OLD}/app`, projectKey: `${OLD}/app` },
        { projectId: "prj_remote", rootPath: `${OLD}/lib`, projectKey: "remote:github.com/a/lib" },
        { projectId: "prj_similar", rootPath: `${OLD}-other/x`, projectKey: `${OLD}-other/x` },
        { projectId: "prj_home", rootPath: "/home/paseo/.paseo/system", projectKey: "x" },
      ]),
    );
    await writeFile(
      path.join(home, "projects", "workspaces.json"),
      JSON.stringify([
        {
          workspaceId: "wks_app",
          cwd: `${OLD}/app/packages/web`,
          worktreeRoot: `${OLD}/app`,
          mainRepoRoot: null,
        },
        {
          workspaceId: "wks_tree",
          cwd: "/home/paseo/.paseo/worktrees/abc/x",
          worktreeRoot: "/home/paseo/.paseo/worktrees/abc/x",
          mainRepoRoot: `${OLD}/app`,
        },
      ]),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = () =>
    migrateRegistryPathsToProjectsFolder({
      paseoHome: home,
      root: ROOT,
      aliases: [`${OLD}/`],
      logger,
      now: () => new Date("2026-10-22T00:00:00.000Z"),
    });
  const read = async (name: string) =>
    JSON.parse(await readFile(path.join(home, "projects", name), "utf8")) as Array<
      Record<string, unknown>
    >;

  it("rewrites paths and local project keys under the earlier prefix, after a backup", async () => {
    const before = await readFile(path.join(home, "projects", "projects.json"), "utf8");
    const result = await run();
    expect(result).toMatchObject({ projects: 3, workspaces: 2 });
    expect(await read("projects.json")).toEqual([
      { projectId: "prj_dev", rootPath: ROOT, projectKey: `host:srv_1:${ROOT}` },
      { projectId: "prj_app", rootPath: `${ROOT}/app`, projectKey: `${ROOT}/app` },
      { projectId: "prj_remote", rootPath: `${ROOT}/lib`, projectKey: "remote:github.com/a/lib" },
      { projectId: "prj_similar", rootPath: `${OLD}-other/x`, projectKey: `${OLD}-other/x` },
      { projectId: "prj_home", rootPath: "/home/paseo/.paseo/system", projectKey: "x" },
    ]);
    expect(await read("workspaces.json")).toEqual([
      {
        workspaceId: "wks_app",
        cwd: `${ROOT}/app/packages/web`,
        worktreeRoot: `${ROOT}/app`,
        mainRepoRoot: null,
      },
      {
        workspaceId: "wks_tree",
        cwd: "/home/paseo/.paseo/worktrees/abc/x",
        worktreeRoot: "/home/paseo/.paseo/worktrees/abc/x",
        mainRepoRoot: `${ROOT}/app`,
      },
    ]);
    const backup = result.backups.find((file) => file.includes("projects.json"));
    expect(backup && (await readFile(backup, "utf8"))).toBe(before);
  });

  it("is idempotent", async () => {
    await run();
    const projects = await read("projects.json");
    const files = await readdir(path.join(home, "projects"));
    expect(await run()).toEqual({ projects: 0, workspaces: 0, backups: [] });
    expect(await read("projects.json")).toEqual(projects);
    expect(await readdir(path.join(home, "projects"))).toEqual(files);
  });

  it("does nothing without an earlier prefix or registry files", async () => {
    await rm(path.join(home, "projects"), { recursive: true });
    expect(await run()).toEqual({ projects: 0, workspaces: 0, backups: [] });
  });
});
