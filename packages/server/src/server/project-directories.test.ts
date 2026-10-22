import { mkdtemp, mkdir, realpath, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browseProjectDirectories } from "./project-directories.js";

describe("shared project directories", () => {
  let temp: string;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "project-folders-"));
    await mkdir(path.join(temp, "share"));
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  function browse(input: Partial<Parameters<typeof browseProjectDirectories>[0]>, mounted = true) {
    const share = path.join(temp, "share");
    return browseProjectDirectories(
      { type: "project.directory.browse.request", requestId: "test", ...input },
      {
        home: temp,
        container: true,
        mountPaths: new Set(mounted ? [share] : []),
        config: {
          version: 1,
          hostHome: path.resolve("/Users/example"),
          shares: [
            {
              id: "documents",
              hostPath: path.resolve("/Users/example/Documents"),
              containerPath: share,
            },
          ],
        },
      },
    );
  }
  it("resolves host home paths to container paths and lists only immediate folders", async () => {
    await mkdir(path.join(temp, "share", "Codex", "child"), { recursive: true });
    const result = await browse({ hostPath: "~/Documents/Codex" });
    expect(result.error).toBeNull();
    expect(result.directory).toMatchObject({
      rootId: "documents",
      containerPath: path.join(temp, "share", "Codex"),
      hostPath: path.resolve("/Users/example/Documents/Codex"),
      entries: [{ name: "child", path: path.join("Codex", "child") }],
    });
  });
  it("distinguishes an unshared host path from an absent mount and an absent directory", async () => {
    expect((await browse({ hostPath: "~/Downloads" })).errorCode).toBe("not_shared");
    expect((await browse({ hostPath: "~/Documents" }, false)).errorCode).toBe("mount_unavailable");
    expect((await browse({ hostPath: "~/Documents/missing" })).errorCode).toBe("not_found");
    expect((await browse({ hostPath: "~/Documents-other" })).errorCode).toBe("not_shared");
  });
  it.skipIf(process.platform === "win32")("prevents lexical and symlink escapes", async () => {
    await mkdir(path.join(temp, "outside"));
    await symlink(path.join(temp, "outside"), path.join(temp, "share", "escape"));
    expect((await browse({ rootId: "documents", path: "../outside" })).errorCode).toBe(
      "outside_root",
    );
    expect((await browse({ rootId: "documents", path: "escape" })).errorCode).toBe("outside_root");
    expect((await browse({ rootId: "documents" })).directory?.entries).toEqual([]);
  });
  it("paginates directories and allows hidden folders explicitly", async () => {
    for (let i = 0; i < 102; i++) await mkdir(path.join(temp, "share", String(i).padStart(3, "0")));
    await mkdir(path.join(temp, "share", ".hidden"));
    const first = (await browse({ rootId: "documents" })).directory!;
    expect(first.entries).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    expect((await browse({ rootId: "documents", offset: 100 })).directory?.entries).toHaveLength(2);
    expect(
      (await browse({ rootId: "documents", showHidden: true })).directory?.entries[0].name,
    ).toBe(".hidden");
  });
  it.skipIf(process.platform === "win32")("reports denied directory reads", async () => {
    const denied = path.join(temp, "share", "denied");
    await mkdir(denied);
    await chmod(denied, 0);
    try {
      expect((await browse({ rootId: "documents", path: "denied" })).errorCode).toBe(
        "permission_denied",
      );
    } finally {
      await chmod(denied, 0o700);
    }
  });
});

describe("Projects folder browsing", () => {
  let temp: string;
  let projects: string;
  beforeEach(async () => {
    temp = await realpath(await mkdtemp(path.join(tmpdir(), "projects-folder-")));
    projects = path.join(temp, "dev");
    await mkdir(path.join(projects, "app", ".git"), { recursive: true });
    await mkdir(path.join(projects, "notes"));
    await mkdir(path.join(projects, ".vorteo", "worktrees"), { recursive: true });
  });
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  function browse(input: Partial<Parameters<typeof browseProjectDirectories>[0]>) {
    return browseProjectDirectories(
      { type: "project.directory.browse.request", requestId: "test", ...input },
      {
        home: temp,
        container: true,
        mountPaths: new Set(),
        config: {
          version: 1,
          hostHome: temp,
          shares: [{ id: "old", hostPath: temp, containerPath: "/shared/old" }],
        },
        projectsRoot: projects,
        projectIdsByPath: new Map([[path.join(projects, "app"), "prj_app"]]),
      },
    );
  }

  it("offers only the Projects folder and opens it by default", async () => {
    const result = await browse({});
    expect(result.roots).toEqual([
      { id: "projects", label: "Projects", containerPath: projects, hostPath: projects },
    ]);
    expect(result.directory?.parent).toBeNull();
    expect(result.directory?.entries).toEqual([
      { name: "app", path: "app", git: true, projectId: "prj_app" },
      { name: "notes", path: "notes", git: false },
    ]);
  });

  it("never lists the worktree state folder, even with hidden folders shown", async () => {
    const names = (await browse({ showHidden: true })).directory?.entries.map(
      (entry) => entry.name,
    );
    expect(names).toEqual(["app", "notes"]);
  });

  it.skipIf(process.platform === "win32")("keeps symlink and parent escapes out", async () => {
    await mkdir(path.join(temp, "outside"));
    await symlink(path.join(temp, "outside"), path.join(projects, "escape"));
    expect((await browse({ rootId: "projects", path: "escape" })).errorCode).toBe("outside_root");
    expect((await browse({ rootId: "projects", path: "../outside" })).errorCode).toBe(
      "outside_root",
    );
    expect((await browse({ hostPath: path.join(temp, "outside") })).errorCode).toBe("not_shared");
    expect((await browse({ hostPath: path.join(projects, "notes") })).directory?.path).toBe(
      "notes",
    );
  });
});
