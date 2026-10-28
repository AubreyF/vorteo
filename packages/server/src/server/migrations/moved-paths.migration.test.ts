import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateMovedPaths } from "./moved-paths.migration.js";

const FROM = "/Users/owner/dev/paseo";
const TO = "/Users/owner/dev/vorteo";
const logger = { info: () => undefined, warn: () => undefined };

describe("Moved checkout record migration", () => {
  let home: string;
  let agents: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "moved-paths-"));
    agents = path.join(home, "agents");
    await mkdir(path.join(home, "projects"));
    await writeFile(
      path.join(home, "projects", "projects.json"),
      JSON.stringify([
        {
          projectId: "prj_new",
          rootPath: TO,
          projectKey: "remote:github.com/a/vorteo",
        },
        {
          projectId: "prj_old",
          rootPath: FROM,
          projectKey: "remote:github.com/a/paseo",
        },
        {
          projectId: "prj_local",
          rootPath: `${FROM}/tools`,
          projectKey: `${FROM}/tools`,
        },
      ]),
    );
    await writeFile(
      path.join(home, "projects", "workspaces.json"),
      JSON.stringify([
        {
          workspaceId: "wks_root",
          cwd: FROM,
          worktreeRoot: null,
          mainRepoRoot: null,
        },
        {
          workspaceId: "wks_tree",
          cwd: "/w/x",
          worktreeRoot: "/w/x",
          mainRepoRoot: FROM,
        },
        {
          workspaceId: "wks_key",
          cwd: `${FROM}/tools`,
          projectMembership: { key: `${FROM}/tools`, source: "manual" },
        },
        {
          workspaceId: "wks_sibling",
          cwd: `${FROM}-factory`,
          mainRepoRoot: `${FROM}-factory`,
        },
      ]),
    );
    await mkdir(path.join(agents, "Users-owner-dev-paseo"), {
      recursive: true,
    });
    await mkdir(path.join(agents, "Users-owner-dev-paseo-factory"), {
      recursive: true,
    });
    await writeFile(
      path.join(agents, "Users-owner-dev-paseo", "a1.json"),
      JSON.stringify({
        id: "a1",
        cwd: FROM,
        persistence: { metadata: { cwd: FROM, id: "s1" } },
      }),
    );
    await writeFile(
      path.join(agents, "Users-owner-dev-paseo-factory", "a2.json"),
      JSON.stringify({ id: "a2", cwd: `${FROM}-factory` }),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = () =>
    migrateMovedPaths({
      paseoHome: home,
      agentStoragePath: agents,
      moves: [{ from: FROM, to: TO }],
      logger,
      now: () => new Date("2026-10-28T00:00:00Z"),
    });
  const read = async (file: string) => JSON.parse(await readFile(path.join(home, file), "utf8"));

  it("moves workspaces, local project roots and agents, but not sibling directories", async () => {
    const result = await run();
    expect(result).toMatchObject({
      projects: 1,
      workspaces: 3,
      agents: 1,
      skippedProjects: 1,
    });

    const workspaces = await read("projects/workspaces.json");
    expect(workspaces.map((w: { cwd: string }) => w.cwd)).toEqual([
      TO,
      "/w/x",
      `${TO}/tools`,
      `${FROM}-factory`,
    ]);
    expect(workspaces[1].mainRepoRoot).toBe(TO);
    expect(workspaces[2].projectMembership).toEqual({
      key: `${TO}/tools`,
      source: "manual",
    });
    expect(workspaces[3].mainRepoRoot).toBe(`${FROM}-factory`);

    const projects = await read("projects/projects.json");
    // The old project keeps its root because the new root already has a project.
    expect(projects[1].rootPath).toBe(FROM);
    expect(projects[2]).toMatchObject({
      rootPath: `${TO}/tools`,
      projectKey: `${TO}/tools`,
    });

    expect(await readdir(path.join(agents, "Users-owner-dev-paseo"))).toEqual([]);
    const moved = await read("agents/Users-owner-dev-vorteo/a1.json");
    expect(moved).toMatchObject({
      cwd: TO,
      persistence: { metadata: { cwd: TO, id: "s1" } },
    });
    expect((await read("agents/Users-owner-dev-paseo-factory/a2.json")).cwd).toBe(
      `${FROM}-factory`,
    );

    const backup = path.join(home, "backups", "moved-paths-2026-10-28T00-00-00-000Z");
    expect(JSON.parse(await readFile(path.join(backup, "workspaces.json"), "utf8"))[0].cwd).toBe(
      FROM,
    );
    expect(
      JSON.parse(
        await readFile(path.join(backup, "agents", "Users-owner-dev-paseo", "a1.json"), "utf8"),
      ).cwd,
    ).toBe(FROM);
  });

  it("changes nothing on a second run", async () => {
    await run();
    const before = await read("projects/workspaces.json");
    const second = await run();
    expect(second).toMatchObject({
      projects: 0,
      workspaces: 0,
      agents: 0,
      backupDirectory: null,
    });
    expect(await read("projects/workspaces.json")).toEqual(before);
  });

  // Every file the migration could touch, byte for byte, plus whether backups exist.
  const snapshot = async () => {
    const files = [
      "projects/projects.json",
      "projects/workspaces.json",
      "agents/Users-owner-dev-paseo/a1.json",
      "agents/Users-owner-dev-vorteo/a1.json",
    ];
    const bytes = await Promise.all(
      files.map((file) => readFile(path.join(home, file), "utf8").catch(() => null)),
    );
    const backups = await readdir(path.join(home, "backups")).catch(() => []);
    return { bytes, backups };
  };

  it("refuses a different existing target without writing any registry or agent file", async () => {
    await mkdir(path.join(agents, "Users-owner-dev-vorteo"), { recursive: true });
    await writeFile(
      path.join(agents, "Users-owner-dev-vorteo", "a1.json"),
      JSON.stringify({ id: "a1", cwd: TO, title: "newer record" }),
    );
    const before = await snapshot();
    await expect(run()).rejects.toThrow(/different agent record already exists/);
    expect(await snapshot()).toEqual(before);
  });

  it("resumes a run interrupted after the target write and before the source removal", async () => {
    const first = await run();
    const target = path.join(agents, "Users-owner-dev-vorteo", "a1.json");
    const written = await readFile(target, "utf8");
    const identity = (await stat(target)).ino;
    // Put the source back from the backup, as a crash before its removal would leave it.
    await writeFile(
      path.join(agents, "Users-owner-dev-paseo", "a1.json"),
      await readFile(
        path.join(first.backupDirectory!, "agents", "Users-owner-dev-paseo", "a1.json"),
      ),
    );

    const resumed = await run();

    expect(resumed).toMatchObject({ workspaces: 0, agents: 1 });
    expect(await readFile(target, "utf8")).toBe(written);
    // Resuming removes the source without rewriting the target.
    expect((await stat(target)).ino).toBe(identity);
    expect(await readdir(path.join(agents, "Users-owner-dev-paseo"))).toEqual([]);
    expect(await run()).toMatchObject({ agents: 0, backupDirectory: null });
  });

  it("refuses a registry entry it cannot read instead of dropping it", async () => {
    const file = path.join(home, "projects", "workspaces.json");
    const workspaces = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify([...workspaces, null, "stray"]));
    const before = await snapshot();
    await expect(run()).rejects.toThrow(/not a record/);
    expect(await snapshot()).toEqual(before);
  });
});
