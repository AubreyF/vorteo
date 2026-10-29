import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectsFolderPolicy,
  logicalProjectKey,
  logicalProjectsPath,
  projectsFolderWorktreesRoot,
  resolveProjectsFolderConfig,
  setActiveProjectsFolder,
  toLogicalProjectKey,
  toLogicalProjectsPath,
  type ProjectsFolderPolicy,
} from "./projects-folder.js";

describe("Projects folder", () => {
  let temp: string;
  let root: string;
  let policy: ProjectsFolderPolicy;
  beforeEach(async () => {
    temp = await realpath(await mkdtemp(path.join(tmpdir(), "projects-policy-")));
    root = path.join(temp, "dev");
    await mkdir(path.join(root, "app"), { recursive: true });
    await mkdir(path.join(temp, "outside"));
    policy = createProjectsFolderPolicy({ root, aliases: [], allowOutside: [] });
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  const known = (paths: string[] = []) => ({ paths });

  it("accepts folders strictly inside the Projects folder", async () => {
    await expect(
      policy.assertNewProjectDirectory(path.join(root, "app"), known()),
    ).resolves.toBeUndefined();
    await expect(policy.assertParentDirectory(root)).resolves.toBeUndefined();
  });

  it("rejects the Projects folder itself and folders outside it, including through ..", async () => {
    await expect(policy.assertNewProjectDirectory(root, known())).rejects.toMatchObject({
      code: "projects_folder_root",
    });
    await expect(
      policy.assertNewProjectDirectory(path.join(temp, "outside"), known()),
    ).rejects.toMatchObject({ code: "outside_projects_folder" });
    await expect(
      policy.assertNewProjectDirectory(`${root}/app/../../outside`, known()),
    ).rejects.toMatchObject({ code: "outside_projects_folder" });
    await expect(policy.assertParentDirectory(path.join(temp, "outside"))).rejects.toMatchObject({
      code: "outside_projects_folder",
    });
  });

  it.skipIf(process.platform === "win32")("follows symlinks that leave the folder", async () => {
    await symlink(path.join(temp, "outside"), path.join(root, "escape"));
    await expect(
      policy.assertNewProjectDirectory(path.join(root, "escape"), known()),
    ).rejects.toMatchObject({ code: "outside_projects_folder" });
    // A folder that does not exist yet is judged by its deepest existing ancestor.
    await expect(
      policy.assertParentDirectory(path.join(root, "escape", "new", "deeper")),
    ).rejects.toMatchObject({ code: "outside_projects_folder" });
  });

  it("keeps registered projects outside the folder, and the folder itself, usable", async () => {
    const legacy = path.join(temp, "outside");
    await expect(
      policy.assertNewProjectDirectory(legacy, known([legacy])),
    ).resolves.toBeUndefined();
    await expect(policy.assertNewProjectDirectory(root, known([root]))).resolves.toBeUndefined();
  });

  it("allows configured installation folders outside the root", async () => {
    const allowed = createProjectsFolderPolicy({
      root,
      aliases: [],
      allowOutside: [path.join(temp, "outside")],
    });
    await mkdir(path.join(temp, "outside", "task"));
    await expect(
      allowed.assertNewProjectDirectory(path.join(temp, "outside", "task"), known()),
    ).resolves.toBeUndefined();
  });

  it("reads settings from PASEO_HOME and lets the environment choose the root", async () => {
    const home = path.join(temp, "home");
    await mkdir(home);
    expect(resolveProjectsFolderConfig({ paseoHome: home, env: {} })).toBeNull();
    await writeFile(
      path.join(home, "projects-folder.json"),
      JSON.stringify({
        root,
        migrateFrom: ["/Users/old/dev/"],
        aliases: ["/Users/guest/dev"],
        future: true,
      }),
    );
    const config = resolveProjectsFolderConfig({ paseoHome: home, env: {} });
    // Earlier locations are aliases too.
    expect(config).toEqual({
      root,
      aliases: ["/Users/guest/dev", "/Users/old/dev"],
      allowOutside: [],
    });
    expect(projectsFolderWorktreesRoot(config!)).toBe(path.join(root, ".vorteo", "worktrees"));
    const fromEnv = resolveProjectsFolderConfig({
      paseoHome: home,
      env: { PASEO_PROJECTS_ROOT: path.join(temp, "outside") },
    });
    expect(fromEnv?.root).toBe(path.join(temp, "outside"));
    const warnings: string[] = [];
    expect(
      resolveProjectsFolderConfig({
        paseoHome: home,
        env: { PASEO_PROJECTS_ROOT: "relative/dev" },
        warn: (message) => warnings.push(message),
      }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  describe("aliases", () => {
    // Dev reaches the logical root through a symlink to the folder's older mount.
    let physical: string;
    let logical: string;
    let aliased: ProjectsFolderPolicy;
    beforeEach(async () => {
      physical = root;
      logical = path.join(temp, "logical");
      await symlink(physical, logical);
      aliased = createProjectsFolderPolicy({
        root: logical,
        aliases: [physical],
        allowOutside: [],
      });
    });

    it("maps paths at or under an alias to the logical root, and nothing else", () => {
      const folder = { root: "/Users/vtn/dev", aliases: ["/Users/guest/dev/", "/Users/guest"] };
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev")).toBe("/Users/vtn/dev");
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev/app/src")).toBe(
        "/Users/vtn/dev/app/src",
      );
      // The longest alias wins.
      expect(toLogicalProjectsPath(folder, "/Users/guest/other")).toBe("/Users/vtn/dev/other");
      expect(toLogicalProjectsPath(folder, "/Users/guest-two/dev")).toBe("/Users/guest-two/dev");
      expect(toLogicalProjectsPath(folder, "/Users/vtn/dev/app")).toBe("/Users/vtn/dev/app");
    });

    it("maps Windows paths with either separator and any case, keeping the caller's spelling", () => {
      const folder = { root: "C:\\Users\\vtn\\dev", aliases: ["C:\\Users\\guest\\dev\\"] };
      expect(toLogicalProjectsPath(folder, "C:\\Users\\guest\\dev")).toBe("C:\\Users\\vtn\\dev");
      expect(toLogicalProjectsPath(folder, "c:\\users\\GUEST\\dev\\app\\src")).toBe(
        "C:\\Users\\vtn\\dev\\app\\src",
      );
      expect(toLogicalProjectsPath(folder, "C:/Users/guest/dev/app")).toBe(
        "C:\\Users\\vtn\\dev/app",
      );
      expect(toLogicalProjectsPath(folder, "C:\\Users\\guest\\dev-two")).toBe(
        "C:\\Users\\guest\\dev-two",
      );
      // POSIX aliases still compare exactly.
      expect(toLogicalProjectsPath({ root: "/r", aliases: ["/A"] }, "/a/app")).toBe("/a/app");
      expect(toLogicalProjectKey(folder, "host:srv_1:C:\\Users\\guest\\dev\\app")).toBe(
        "host:srv_1:C:\\Users\\vtn\\dev\\app",
      );
    });

    it("reads moved checkouts and drops entries that move nowhere", async () => {
      const home = path.join(temp, "moved-home");
      await mkdir(home);
      await writeFile(
        path.join(home, "projects-folder.json"),
        JSON.stringify({
          root: "/Users/vtn/dev",
          movedPaths: [
            { from: "/Users/vtn/dev/paseo/", to: "/Users/vtn/dev/vorteo" },
            { from: "/Users/vtn/dev/same", to: "/Users/vtn/dev/same" },
            { from: "relative", to: "/Users/vtn/dev/x" },
          ],
        }),
      );
      expect(resolveProjectsFolderConfig({ paseoHome: home, env: {} })?.movedPaths).toEqual([
        { from: "/Users/vtn/dev/paseo", to: "/Users/vtn/dev/vorteo" },
      ]);
    });

    it("leaves exact kept paths alone while paths below them still map", () => {
      const folder = {
        root: "/Users/vtn/dev",
        aliases: ["/Users/guest/dev"],
        keepPaths: ["/Users/guest/dev/freed"],
      };
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev/freed")).toBe(
        "/Users/guest/dev/freed",
      );
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev/freed/src")).toBe(
        "/Users/vtn/dev/freed/src",
      );
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev/app")).toBe("/Users/vtn/dev/app");
      // Kept paths match exactly, never as a string prefix.
      expect(toLogicalProjectsPath(folder, "/Users/guest/dev/freed-iphone-scroll")).toBe(
        "/Users/vtn/dev/freed-iphone-scroll",
      );
    });

    it("treats the root's real path as an alias and keeps the logical root", async () => {
      const home = path.join(temp, "home");
      await mkdir(home);
      const config = resolveProjectsFolderConfig({
        paseoHome: home,
        env: { PASEO_PROJECTS_ROOT: logical },
      });
      expect(config).toEqual({ root: logical, aliases: [physical], allowOutside: [] });
    });

    it("maps daemon paths through the active folder", () => {
      setActiveProjectsFolder({ root: logical, aliases: [physical], allowOutside: [] });
      try {
        expect(logicalProjectsPath(path.join(physical, "app"))).toBe(path.join(logical, "app"));
        expect(logicalProjectKey(`host:srv_1:${physical}/app`)).toBe(`host:srv_1:${logical}/app`);
        expect(logicalProjectKey("remote:github.com/a/b")).toBe("remote:github.com/a/b");
      } finally {
        setActiveProjectsFolder(undefined);
      }
      expect(logicalProjectsPath(path.join(physical, "app"))).toBe(path.join(physical, "app"));
    });

    it("accepts folders through the logical root or the alias", async () => {
      await expect(
        aliased.assertNewProjectDirectory(path.join(logical, "app"), known()),
      ).resolves.toBeUndefined();
      await expect(
        aliased.assertNewProjectDirectory(path.join(physical, "app"), known()),
      ).resolves.toBeUndefined();
      await expect(aliased.assertParentDirectory(physical)).resolves.toBeUndefined();
      await expect(aliased.assertNewProjectDirectory(physical, known())).rejects.toMatchObject({
        code: "projects_folder_root",
      });
      // A registration under the alias still counts for the same folder.
      const legacy = path.join(temp, "outside");
      await expect(
        aliased.assertNewProjectDirectory(path.join(logical, "app"), known([physical + "/app"])),
      ).resolves.toBeUndefined();
      await expect(aliased.assertNewProjectDirectory(legacy, known())).rejects.toMatchObject({
        code: "outside_projects_folder",
      });
    });

    it.skipIf(process.platform === "win32")(
      "still rejects symlinks that leave both the root and its aliases",
      async () => {
        await symlink(path.join(temp, "outside"), path.join(physical, "escape"));
        await expect(
          aliased.assertNewProjectDirectory(path.join(logical, "escape"), known()),
        ).rejects.toMatchObject({ code: "outside_projects_folder" });
        await expect(
          aliased.assertParentDirectory(path.join(physical, "escape", "new")),
        ).rejects.toMatchObject({ code: "outside_projects_folder" });
      },
    );

    it("rejects an alias that does not lead to the folder", async () => {
      const unrelated = createProjectsFolderPolicy({
        root: logical,
        aliases: [path.join(temp, "outside")],
        allowOutside: [],
      });
      await mkdir(path.join(temp, "outside", "x"));
      await expect(
        unrelated.assertNewProjectDirectory(path.join(temp, "outside", "x"), known()),
      ).rejects.toMatchObject({ code: "outside_projects_folder" });
      await expect(
        unrelated.assertParentDirectory(path.join(temp, "outside")),
      ).rejects.toMatchObject({ code: "outside_projects_folder" });
    });
  });
});
