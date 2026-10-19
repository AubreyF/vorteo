import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import pino from "pino";
import { archivePersistedWorkspaceRecord } from "../../workspace-archive-service.js";
import { getCheckoutStatus } from "../../../utils/checkout-git.js";
import {
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadata,
} from "../../../utils/worktree-metadata.js";
import { createWorktree, deletePaseoWorktree } from "../../../utils/worktree.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import {
  createWorkspaceRecoveryService,
  unarchiveWorkspaceGuarded,
} from "./workspace-recovery-service.js";
import {
  WorkspaceRecoveryGuardSchema,
  WorkspaceRecoveryRestoreRequestSchema,
  type WorkspaceRecoveryGuard,
} from "@getpaseo/protocol/messages";

const NOW = "2026-07-11T10:12:30.752Z";
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createProject(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  return createPersistedProjectRecord({
    projectId: "/project",
    rootPath: "/project",
    kind: "git",
    displayName: "project",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function createWorkspace(
  overrides: Partial<PersistedWorkspaceRecord> = {},
): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: "wks_15a1b5630ebaab33",
    projectId: "/project",
    cwd: "/worktrees/trigger-1525443412986298439",
    kind: "worktree",
    displayName: "diagnose-repro-tdd",
    title: "TDD reproduction",
    branch: "diagnose-repro-tdd",
    worktreeRoot: "/worktrees/trigger-1525443412986298439",
    isPaseoOwnedWorktree: true,
    mainRepoRoot: "/repo",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: NOW,
    ...overrides,
  });
}

function createHarness(input?: {
  workspace?: PersistedWorkspaceRecord | null;
  project?: PersistedProjectRecord | null;
  directories?: string[];
  paseoHome?: string;
  worktreesRoot?: string;
}) {
  const workspace = input?.workspace === undefined ? createWorkspace() : input.workspace;
  const project = input?.project === undefined ? createProject() : input.project;
  const directories = new Set(input?.directories ?? ["/repo"]);
  const unarchived: string[] = [];
  const service = createWorkspaceRecoveryService({
    paseoHome: input?.paseoHome ?? "/paseo-home",
    worktreesRoot: input?.worktreesRoot ?? "/worktrees",
    getWorkspace: async (workspaceId) =>
      workspace?.workspaceId === workspaceId ? workspace : null,
    getProject: async (projectId) => (project?.projectId === projectId ? project : null),
    isDirectory: async (path) => directories.has(path),
    unarchiveWorkspace: async (record) => {
      unarchived.push(record.workspaceId);
    },
  });
  return { service, unarchived };
}

describe("workspace recovery", () => {
  test("describes a missing archived worktree from persisted placement", async () => {
    const { service, unarchived } = createHarness();

    await expect(service.inspect("wks_15a1b5630ebaab33")).resolves.toEqual({
      kind: "recoverable",
      workspaceId: "wks_15a1b5630ebaab33",
      workspaceName: "TDD reproduction",
      action: "restore",
      branch: "diagnose-repro-tdd",
    });
    expect(unarchived).toEqual([]);
  });

  test("unarchives an archived workspace whose exact directory remains", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service, unarchived } = createHarness({
      workspace,
      directories: [workspace.cwd],
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "unarchive",
    });
    expect(unarchived).toEqual([workspace.workspaceId]);
  });

  test("does not offer recovery for a missing non-worktree directory", async () => {
    const workspace = createWorkspace({ kind: "directory", branch: null });
    const { service } = createHarness({ workspace });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "workspace_directory_missing",
      message: "The archived workspace directory no longer exists and cannot be recreated.",
    });
  });

  test("uses the persisted source repository instead of the owning project to restore an exact subdirectory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/mixed-project";
    const sourceSubdirectory = join(repoDir, "packages", "app");
    mkdirSync(sourceSubdirectory, { recursive: true });
    writeFileSync(join(sourceSubdirectory, "README.md"), "app\n");
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "add app"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });

    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "mixed-project",
      source: { kind: "checkout-branch", branchName: branch },
      runSetup: false,
      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const projectRoot = join(tempDir, "explicit-non-git-project");
    mkdirSync(projectRoot);
    const project = createProject({
      projectId: "explicit-non-git-project",
      rootPath: projectRoot,
      kind: "non_git",
    });
    const workspace = createWorkspace({
      workspaceId: "ws-mixed-project-recreate",
      projectId: project.projectId,
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (path) => existsSync(path) && statSync(path).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).resolves.toEqual({
      workspaceId: workspace.workspaceId,
      action: "restore",
    });
    expect(existsSync(worktreeRoot)).toBe(true);
    expect(existsSync(workspaceCwd)).toBe(true);
    expect(unarchived).toEqual([workspace.workspaceId]);
  });

  test("keeps an exact-subdirectory workspace archived when its branch lacks that directory", async () => {
    const { tempDir, repoDir } = createGitRepository();
    const branch = "feature/without-subproject";
    execFileSync("git", ["branch", branch], { cwd: repoDir, stdio: "pipe" });
    const paseoHome = join(tempDir, "paseo-home");
    const worktreesRoot = join(tempDir, "worktrees");
    const created = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "without-subproject",
      source: { kind: "checkout-branch", branchName: branch },
      runSetup: false,
      paseoHome,
      worktreesRoot,
    });
    const worktreeRoot = realpathSync(created.worktreePath);
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    rmSync(worktreeRoot, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });

    const project = createProject({ rootPath: repoDir });
    const workspace = createWorkspace({
      workspaceId: "ws-missing-restored-subdirectory",
      cwd: workspaceCwd,
      branch,
      worktreeRoot,
      mainRepoRoot: repoDir,
    });
    const unarchived: string[] = [];
    const service = createWorkspaceRecoveryService({
      paseoHome,
      worktreesRoot,
      getWorkspace: async (workspaceId) =>
        workspaceId === workspace.workspaceId ? workspace : null,
      getProject: async (projectId) => (projectId === project.projectId ? project : null),
      isDirectory: async (targetPath) =>
        existsSync(targetPath) && statSync(targetPath).isDirectory(),
      unarchiveWorkspace: async (record) => {
        unarchived.push(record.workspaceId);
      },
    });

    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "Selected project directory is missing from the restored worktree",
    );
    expect(unarchived).toEqual([]);
    expect(existsSync(worktreeRoot)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: repoDir,
        stdio: "pipe",
      })
        .toString()
        .includes("without-subproject"),
    ).toBe(false);
  });

  test("keeps the workspace archived when its persisted source repository is missing", async () => {
    const workspace = createWorkspace({ mainRepoRoot: "/missing-source" });
    const { service, unarchived } = createHarness({
      workspace,
      directories: ["/project"],
    });

    await expect(service.inspect(workspace.workspaceId)).resolves.toEqual({
      kind: "unavailable",
      workspaceId: workspace.workspaceId,
      reason: "project_directory_missing",
      message: "The source repository needed to restore this worktree no longer exists.",
    });
    await expect(service.restore(workspace.workspaceId)).rejects.toThrow(
      "The source repository needed to restore this worktree no longer exists.",
    );
    expect(unarchived).toEqual([]);
  });
});

function createGitRepository(): { tempDir: string; repoDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "paseo-workspace-recovery-"));
  tempDirectories.push(tempDir);
  const repoDir = join(tempDir, "repo");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Paseo Test"], {
    cwd: repoDir,
    stdio: "pipe",
  });
  writeFileSync(join(repoDir, "README.md"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

async function createBaseRecoveryFixture(baseBranch: string | null) {
  const { tempDir, repoDir } = createGitRepository();
  const paseoHome = join(tempDir, "paseo-home");
  const created = await createWorktree({
    cwd: repoDir,
    paseoHome,
    worktreeSlug: "base-recovery",
    source: { kind: "branch-off", branchName: "feature", baseBranch: "main" },
    runSetup: false,
  });
  writeFileSync(join(created.worktreePath, "feature.txt"), "feature\n");
  execFileSync("git", ["add", "."], { cwd: created.worktreePath });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "feature"], {
    cwd: created.worktreePath,
    stdio: "pipe",
  });
  const workspace = createWorkspace({
    workspaceId: "base-recovery",
    cwd: created.worktreePath,
    worktreeRoot: created.worktreePath,
    mainRepoRoot: repoDir,
    branch: "feature",
    baseBranch,
    archivedAt: null,
  });
  const project = createProject({ rootPath: repoDir });
  const registry = new FileBackedWorkspaceRegistry(
    join(tempDir, "workspaces.json"),
    pino({ level: "silent" }),
  );
  await registry.upsert(workspace);
  const service = createWorkspaceRecoveryService({
    paseoHome,
    getWorkspace: (id) => registry.get(id),
    getProject: async () => project,
    isDirectory: async (target) => existsSync(target) && statSync(target).isDirectory(),
    unarchiveWorkspace: async (record) => {
      await registry.update(record.workspaceId, (value) => ({ ...value, archivedAt: null }));
    },
  });
  async function archiveAndRemove() {
    await archivePersistedWorkspaceRecord({
      workspaceId: workspace.workspaceId,
      workspaceRegistry: registry,
    });
    await deletePaseoWorktree({ cwd: repoDir, worktreePath: workspace.cwd, paseoHome });
    expect(existsSync(workspace.cwd)).toBe(false);
  }
  return { workspace, registry, service, paseoHome, repoDir, tempDir, archiveAndRemove };
}

test("preserves ordinary checkout behavior when no separate base was recorded", async () => {
  const fixture = await createBaseRecoveryFixture(null);
  writePaseoWorktreeMetadata(fixture.workspace.cwd, { baseRefName: "feature" });
  await fixture.archiveAndRemove();
  await fixture.service.restore(fixture.workspace.workspaceId);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.baseBranch).toBeNull();
  expect(
    await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome }),
  ).toMatchObject({ currentBranch: "feature", baseRef: "feature" });
});

test("restores a branchless workspace from its recorded base so work can continue", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/release");
  execFileSync("git", ["switch", "-c", "release"], { cwd: fixture.repoDir, stdio: "pipe" });
  writeFileSync(join(fixture.repoDir, "release.txt"), "release\n");
  execFileSync("git", ["add", "release.txt"], { cwd: fixture.repoDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "release"], { cwd: fixture.repoDir, stdio: "pipe" });
  execFileSync("git", ["switch", "main"], { cwd: fixture.repoDir, stdio: "pipe" });
  await fixture.registry.update(fixture.workspace.workspaceId, (workspace) => ({
    ...workspace,
    branch: null,
  }));
  await fixture.archiveAndRemove();

  await expect(fixture.service.inspect(fixture.workspace.workspaceId)).resolves.toMatchObject({
    kind: "recoverable",
    action: "restore",
    branch: null,
  });
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });

  const checkout = await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome });
  expect(checkout.currentBranch).toBeTruthy();
  expect(checkout.currentBranch).not.toBe("feature");
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(
    execFileSync("git", ["rev-parse", "release"], {
      cwd: fixture.repoDir,
      encoding: "utf8",
    }).trim(),
  );
});

test("restores a branchless workspace from the repository default when its base is missing", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/deleted-base");
  await fixture.registry.update(fixture.workspace.workspaceId, (workspace) => ({
    ...workspace,
    branch: null,
  }));
  await fixture.archiveAndRemove();

  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(
    execFileSync("git", ["rev-parse", "main"], { cwd: fixture.repoDir, encoding: "utf8" }).trim(),
  );
});

test("restores the branch HEAD with a base name when the exact base is missing", async () => {
  const fixture = await createBaseRecoveryFixture("refs/remotes/upstream/main");
  const headBeforeArchive = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture.workspace.cwd,
    encoding: "utf8",
  }).trim();
  await fixture.archiveAndRemove();
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).resolves.toEqual({
    workspaceId: fixture.workspace.workspaceId,
    action: "restore",
  });
  expect(existsSync(fixture.workspace.cwd)).toBe(true);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.archivedAt).toBeNull();
  const metadata = readPaseoWorktreeMetadata(fixture.workspace.cwd);
  expect(metadata).toMatchObject({ baseRefName: "main" });
  expect(metadata?.baseRef).toBeUndefined();
  expect(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace.cwd,
      encoding: "utf8",
    }).trim(),
  ).toBe(headBeforeArchive);
});

test("restore fetches a deleted local branch from origin and retains its base", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/main");
  const remote = join(fixture.tempDir, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: fixture.repoDir });
  execFileSync("git", ["push", "origin", "feature"], { cwd: fixture.repoDir, stdio: "pipe" });
  await fixture.archiveAndRemove();
  execFileSync("git", ["branch", "-D", "feature"], { cwd: fixture.repoDir });
  await fixture.service.restore(fixture.workspace.workspaceId);
  expect(readPaseoWorktreeMetadata(fixture.workspace.cwd)?.baseRef).toBe("refs/heads/main");
  expect(
    await getCheckoutStatus(fixture.workspace.cwd, { paseoHome: fixture.paseoHome }),
  ).toMatchObject({
    currentBranch: "feature",
    baseRef: "main",
    aheadBehind: { ahead: 1, behind: 0 },
  });
});

test("restore rejects a branch checked out elsewhere without inventing another branch", async () => {
  const fixture = await createBaseRecoveryFixture("refs/heads/main");
  await fixture.archiveAndRemove();
  execFileSync("git", ["switch", "feature"], { cwd: fixture.repoDir, stdio: "pipe" });
  await expect(fixture.service.restore(fixture.workspace.workspaceId)).rejects.toThrow(
    /already checked out/,
  );
  expect(existsSync(fixture.workspace.cwd)).toBe(false);
  expect((await fixture.registry.get(fixture.workspace.workspaceId))?.archivedAt).not.toBeNull();
  expect(
    execFileSync("git", ["branch", "--list", "feature*"], {
      cwd: fixture.repoDir,
      encoding: "utf8",
    }).trim(),
  ).toBe("* feature");
});

async function createGuardedRecoveryFixture() {
  const root = mkdtempSync(join(tmpdir(), "paseo-guarded-recovery-"));
  tempDirectories.push(root);
  const cwd = join(root, "retained");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "retained.txt"), "preserved");
  const workspace = createWorkspace({ cwd, worktreeRoot: cwd, mainRepoRoot: root });
  const project = createProject({ rootPath: root });
  const registry = new FileBackedWorkspaceRegistry(
    join(root, "workspaces.json"),
    pino({ level: "silent" }),
  );
  await registry.upsert(workspace);
  let beforeMutation = async () => {};
  let afterDirectoryCheck = () => {};
  const service = createWorkspaceRecoveryService({
    serverId: "srv_recovery",
    paseoHome: root,
    getWorkspace: (id) => registry.get(id),
    getProject: async () => project,
    isDirectory: async (path) => {
      const present = existsSync(path) && statSync(path).isDirectory();
      afterDirectoryCheck();
      return present;
    },
    unarchiveWorkspace: async () => {
      throw new Error("Guard fell through to ordinary recovery");
    },
    unarchiveWorkspaceGuarded: async (expected) => {
      await beforeMutation();
      await unarchiveWorkspaceGuarded(registry, expected);
    },
  });
  const inspected = await service.inspect(workspace.workspaceId);
  if (inspected.kind !== "recoverable" || !inspected.guard)
    throw new Error("Missing recovery guard");
  const guard: WorkspaceRecoveryGuard = inspected.guard;
  return {
    root,
    workspace,
    project,
    registry,
    guard,
    service,
    beforeMutation: (operation: () => Promise<void>) => {
      beforeMutation = operation;
    },
    afterDirectoryCheck: (operation: () => void) => {
      afterDirectoryCheck = operation;
    },
  };
}

test("guarded recovery rejects action changing from unarchive to recreation", async () => {
  const f = await createGuardedRecoveryFixture();
  expect(await f.service.inspect(f.workspace.workspaceId)).toMatchObject({ action: "unarchive" });
  rmSync(f.workspace.cwd, { recursive: true });
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "action or retained identity changed",
  );
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
  expect(existsSync(f.workspace.cwd)).toBe(false);
  expect(f.project.archivedAt).toBeNull();
});

test.each([
  { serverId: "srv_other" },
  { projectId: "other-project" },
  { cwd: "/other-directory" },
  { kind: "directory" as const },
  { archivedAt: "changed" },
  { updatedAt: "changed" },
])("guarded recovery rejects changed binding %j without mutation", async (change) => {
  const f = await createGuardedRecoveryFixture();
  await expect(
    f.service.restore(f.workspace.workspaceId, { ...f.guard, ...change }),
  ).rejects.toThrow("identity changed");
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
  expect(f.project.archivedAt).toBeNull();
  expect(existsSync(join(f.workspace.cwd, "retained.txt"))).toBe(true);
});

test("guarded recovery rejects record drift at the serialized mutation boundary", async () => {
  const f = await createGuardedRecoveryFixture();
  f.beforeMutation(async () => {
    await f.registry.update(f.workspace.workspaceId, (current) => ({
      ...current,
      title: "Changed concurrently",
    }));
  });
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "record changed before unarchive",
  );
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual({
    ...f.workspace,
    title: "Changed concurrently",
  });
});

test("guarded recovery rejects a missing record at the mutation boundary", async () => {
  const f = await createGuardedRecoveryFixture();
  f.beforeMutation(() => f.registry.remove(f.workspace.workspaceId));
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "record is no longer available",
  );
  expect(await f.registry.get(f.workspace.workspaceId)).toBeNull();
  expect(existsSync(join(f.workspace.cwd, "retained.txt"))).toBe(true);
});

test("guarded unarchive preserves retained identity without changing project or files", async () => {
  const f = await createGuardedRecoveryFixture();
  const projectBefore = structuredClone(f.project);
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).resolves.toEqual({
    workspaceId: f.workspace.workspaceId,
    action: "unarchive",
  });
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual({
    ...f.workspace,
    archivedAt: null,
    updatedAt: expect.any(String),
  });
  expect(f.project).toEqual(projectBefore);
  expect(existsSync(join(f.workspace.cwd, "retained.txt"))).toBe(true);
});

test("guard schema preserves ordinary recovery and rejects recreation authority", () => {
  const legacy = {
    type: "workspace.recovery.restore.request",
    workspaceId: "workspace",
    requestId: "request",
  };
  expect(WorkspaceRecoveryRestoreRequestSchema.parse(legacy)).toEqual(legacy);
  expect(
    WorkspaceRecoveryGuardSchema.safeParse({
      action: "restore",
      serverId: "srv_recovery",
      projectId: "project",
      cwd: "/cwd",
      kind: "worktree",
      archivedAt: NOW,
      updatedAt: NOW,
    }).success,
  ).toBe(false);
});

test("guarded recovery rejects another workspace and stale full record hashes", async () => {
  const f = await createGuardedRecoveryFixture();
  const other = { ...f.workspace, workspaceId: "another-workspace" };
  await f.registry.upsert(other);
  await expect(f.service.restore(other.workspaceId, f.guard)).rejects.toThrow("identity changed");
  expect(await f.registry.get(other.workspaceId)).toEqual(other);
  await f.registry.update(f.workspace.workspaceId, (current) => ({
    ...current,
    branch: "changed-without-timestamp",
  }));
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "identity changed",
  );
  expect((await f.registry.get(f.workspace.workspaceId))?.archivedAt).toBe(NOW);
});

test("guarded recovery rejects directory loss during inspection without recreation", async () => {
  const f = await createGuardedRecoveryFixture();
  f.afterDirectoryCheck(() => rmSync(f.workspace.cwd, { recursive: true, force: true }));
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "directory is no longer available",
  );
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
  expect(existsSync(f.workspace.cwd)).toBe(false);
});

test("guarded recovery refuses to reactivate the archived parent project", async () => {
  const f = await createGuardedRecoveryFixture();
  f.project.archivedAt = NOW;
  await expect(f.service.restore(f.workspace.workspaceId, f.guard)).rejects.toThrow(
    "project to remain active",
  );
  expect(f.project.archivedAt).toBe(NOW);
  expect(await f.registry.get(f.workspace.workspaceId)).toEqual(f.workspace);
});
