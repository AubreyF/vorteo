import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { CoordinatorBootstrapPlan } from "@getpaseo/protocol/coordinator-bootstrap";
import { BootstrapRequestConflict, bootstrapRecoveryRelease } from "./coordinator-bootstrap.js";
import {
  assertBootstrapPathsProtected,
  readBootstrapPreparedFile,
  verifyBootstrapReleaseArtifacts,
} from "./coordinator-bootstrap-artifact.js";
import {
  readBootstrapLauncher,
  verifyBootstrapLaunchers,
} from "./coordinator-bootstrap-service.js";

interface BootstrapLauncherSelection {
  plan: CoordinatorBootstrapPlan;
  launcherFile: string;
  configurationFile: string;
  writableMountRoots: readonly string[];
  /** Recheck durable selection intent and inherited native ownership immediately
   * before rename. The caller must already prove old process/service absence. */
  authorizeSelection(): Promise<void>;
}

/** Select only the approved launcher bytes. Configurations and release trees
 * stay at their immutable prepared paths; rollback files are never overwritten. */
export async function selectBootstrapLauncher(input: BootstrapLauncherSelection): Promise<void> {
  const { plan, launcherFile, writableMountRoots } = input;
  if (launcherFile === plan.previous.launcher.path || launcherFile === plan.candidate.launcher.path)
    throw new BootstrapRequestConflict(
      "Selected launcher cannot overwrite prepared rollback or candidate",
    );
  const parent = path.dirname(launcherFile);
  await assertBootstrapPathsProtected([parent, launcherFile], writableMountRoots);
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o022) !== 0
  )
    throw new BootstrapRequestConflict("Selected launcher parent is not owned and protected");
  await verifyBootstrapReleaseArtifacts(plan.previous, writableMountRoots);
  await verifyBootstrapReleaseArtifacts(plan.candidate, writableMountRoots);
  const current = { path: launcherFile, sha256: plan.previous.launcher.sha256 };
  const [previous, candidate, selected] = await Promise.all([
    readBootstrapLauncher(plan.previous.launcher, writableMountRoots),
    readBootstrapLauncher(plan.candidate.launcher, writableMountRoots),
    readBootstrapLauncher(current, writableMountRoots),
  ]);
  verifyBootstrapLaunchers({
    plan,
    configurationFile: input.configurationFile,
    current: selected,
    previous,
    candidate,
  });
  const bytes = await readBootstrapPreparedFile(plan.candidate.launcher, writableMountRoots);
  await writeLauncher({
    parent,
    parentStat,
    launcherFile,
    current,
    bytes,
    writableMountRoots,
    authorizeSelection: input.authorizeSelection,
  });
}

/** Rollback may see either the old selection or the exact candidate, never a third release. */
export async function restoreBootstrapLauncher(input: BootstrapLauncherSelection): Promise<void> {
  const { plan, launcherFile, writableMountRoots } = input;
  if (launcherFile === plan.previous.launcher.path || launcherFile === plan.candidate.launcher.path)
    throw new BootstrapRequestConflict("Rollback cannot overwrite preserved launchers");
  const parent = path.dirname(launcherFile);
  await assertBootstrapPathsProtected([parent, launcherFile], writableMountRoots);
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o022) !== 0
  )
    throw new BootstrapRequestConflict("Rollback launcher parent is not protected");
  const recovery = bootstrapRecoveryRelease(plan);
  if (launcherFile === recovery.launcher.path)
    throw new BootstrapRequestConflict("Rollback cannot overwrite preserved recovery launcher");
  await verifyBootstrapReleaseArtifacts(recovery, writableMountRoots);
  const bytes = await readBootstrapPreparedFile(recovery.launcher, writableMountRoots);
  let current = { path: launcherFile, sha256: plan.previous.launcher.sha256 };
  try {
    await readBootstrapPreparedFile(current, writableMountRoots);
  } catch {
    current = { path: launcherFile, sha256: plan.candidate.launcher.sha256 };
    await readBootstrapPreparedFile(current, writableMountRoots);
  }
  await writeLauncher({
    parent,
    parentStat,
    launcherFile,
    current,
    bytes,
    writableMountRoots,
    authorizeSelection: input.authorizeSelection,
  });
}

async function writeLauncher(input: {
  parent: string;
  parentStat: Awaited<ReturnType<typeof lstat>>;
  launcherFile: string;
  current: { path: string; sha256: string };
  bytes: Buffer;
  writableMountRoots: readonly string[];
  authorizeSelection(): Promise<void>;
}): Promise<void> {
  const { parent, parentStat, launcherFile, current, bytes, writableMountRoots } = input;
  const temporary = path.join(parent, `.coordinator-selection-${randomUUID()}`);
  const descriptor = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let renamed = false;
  try {
    await descriptor.writeFile(bytes);
    await descriptor.sync();
    await readBootstrapPreparedFile(current, writableMountRoots);
    await input.authorizeSelection();
    await readBootstrapPreparedFile(current, writableMountRoots);
    const currentParent = await lstat(parent);
    if (currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino)
      throw new BootstrapRequestConflict("Selected launcher directory changed");
    await rename(temporary, launcherFile);
    renamed = true;
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await readBootstrapPreparedFile(
      { path: launcherFile, sha256: createHash("sha256").update(bytes).digest("hex") },
      writableMountRoots,
    );
  } finally {
    await descriptor.close();
    if (!renamed) await unlink(temporary);
  }
}
