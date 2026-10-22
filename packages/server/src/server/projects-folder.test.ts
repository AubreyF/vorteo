import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectsFolderPolicy,
  projectsFolderWorktreesRoot,
  resolveProjectsFolderConfig,
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
    policy = createProjectsFolderPolicy({ root, migrateFrom: [], allowOutside: [] });
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
      migrateFrom: [],
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
      JSON.stringify({ root, migrateFrom: ["/Users/old/dev/"], future: true }),
    );
    const config = resolveProjectsFolderConfig({ paseoHome: home, env: {} });
    expect(config).toEqual({ root, migrateFrom: ["/Users/old/dev"], allowOutside: [] });
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
});
