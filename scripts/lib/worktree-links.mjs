// One-time repair for git worktrees that a Dev container created before the daemon rewrote
// their links to the Projects folder's logical path. Git records both link files with the
// container's real path, such as `/Users/<old guest user>/dev/...`, which the Host cannot
// open, so the Host lists those worktrees as prunable and a Host `git worktree prune` would
// delete their metadata. This maps each link under an old prefix to the same place under the
// folder, as `rewriteWorktreeLinksToLogicalPaths` in packages/server/src/utils/worktree.ts
// does for new worktrees. See docs/execution-installation.md#repair-older-dev-worktree-links.
import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const WORKTREE_LINK_BACKUP_INFIX = ".before-worktree-link-rewrite-";
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".vorteo", ".git"]);
const GITDIR_PREFIX = "gitdir: ";
const UNREADABLE = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

function isAtOrUnder(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function mapToFolder(value, { folder, from }) {
  const prefix = from.find((candidate) => isAtOrUnder(value, candidate));
  return prefix === undefined ? null : path.posix.join(folder, value.slice(prefix.length));
}

/** Classifies one absolute link target: under an old prefix, already logical, or elsewhere. */
function classify(target, options) {
  if (!path.isAbsolute(target)) return { kind: "relative" };
  const mapped = mapToFolder(target, options);
  if (mapped !== null) return { kind: "old", hostPath: mapped };
  if (isAtOrUnder(target, options.folder)) return { kind: "logical", hostPath: target };
  return { kind: "outside" };
}

function samePlace(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch (error) {
    if (UNREADABLE.has(error.code)) return false;
    throw error;
  }
}

/** Main repositories (a `.git` directory) and other `.git` files under the folder. */
function findCheckouts(folder, depth) {
  const repositories = [];
  const linkFiles = [];
  const pending = [{ directory: folder, level: 0 }];
  while (pending.length > 0) {
    const { directory, level } = pending.shift();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      // Unreadable folders, or ones removed during the scan, hold nothing to repair.
      if (UNREADABLE.has(error.code)) continue;
      throw error;
    }
    const marker = entries.find((entry) => entry.name === ".git");
    if (marker?.isDirectory()) repositories.push(directory);
    if (marker?.isFile()) linkFiles.push(path.join(directory, ".git"));
    if (level >= depth) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
        pending.push({
          directory: path.join(directory, entry.name),
          level: level + 1,
        });
    }
  }
  return { repositories: repositories.toSorted(), linkFiles };
}

function readGitFileTarget(file) {
  const text = readFileSync(file, "utf8");
  return text.startsWith(GITDIR_PREFIX)
    ? { text, target: text.slice(GITDIR_PREFIX.length).trim() }
    : null;
}

/** Plans the rewrite for one `.git/worktrees/<name>` entry: changes, or why it is skipped. */
function planWorktree({ repository, name, keptHostPaths, options }) {
  const adminDirectory = path.join(repository, ".git", "worktrees", name);
  const gitdirFile = path.join(adminDirectory, "gitdir");
  const base = { repository, worktree: name };
  if (!existsSync(gitdirFile)) return { skip: { ...base, reason: "has no gitdir link file" } };
  const gitdirText = readFileSync(gitdirFile, "utf8");
  const gitdirTarget = gitdirText.trim();
  const link = classify(gitdirTarget, options);
  if (link.kind === "relative")
    return {
      skip: { ...base, link: gitdirTarget, reason: "uses a relative link" },
    };
  if (link.kind === "outside") {
    const reason = existsSync(gitdirTarget)
      ? "is outside the Projects folder"
      : "is outside the Projects folder and missing on the Host, so a Host git worktree prune would delete its metadata";
    return { skip: { ...base, link: gitdirTarget, reason } };
  }
  if (path.basename(link.hostPath) !== ".git")
    return {
      skip: {
        ...base,
        link: gitdirTarget,
        reason: "does not name a worktree's .git file",
      },
    };
  const worktreeDirectory = path.dirname(link.hostPath);
  if (keptHostPaths.has(worktreeDirectory))
    return { skip: { ...base, link: gitdirTarget, reason: "kept path" } };
  if (!existsSync(link.hostPath) || !statSync(link.hostPath).isFile())
    return {
      skip: {
        ...base,
        link: gitdirTarget,
        reason: "its worktree does not exist under either form",
      },
    };

  const worktreeLink = readGitFileTarget(link.hostPath);
  if (!worktreeLink)
    return {
      skip: {
        ...base,
        link: link.hostPath,
        reason: "its .git file has no gitdir line",
      },
    };
  const back = classify(worktreeLink.target, options);
  if (back.kind === "outside")
    return {
      skip: {
        ...base,
        link: worktreeLink.target,
        reason: "its .git file names a git directory outside the Projects folder",
      },
    };
  const backHostPath =
    back.kind === "relative" ? path.resolve(worktreeDirectory, worktreeLink.target) : back.hostPath;
  if (!samePlace(backHostPath, adminDirectory))
    return {
      skip: {
        ...base,
        link: worktreeLink.target,
        reason: "its .git file names a different repository's worktree",
      },
    };

  const changes = [];
  if (link.kind === "old")
    changes.push({
      ...base,
      file: gitdirFile,
      backupBase: gitdirFile,
      current: gitdirText,
      next: `${link.hostPath}\n`,
    });
  if (back.kind === "old")
    changes.push({
      ...base,
      file: link.hostPath,
      // Kept in the admin directory: next to the worktree's .git it would show as an
      // untracked file that `git add -A` could commit.
      backupBase: path.join(adminDirectory, "worktree-git-file"),
      current: worktreeLink.text,
      next: `${GITDIR_PREFIX}${back.hostPath}\n`,
    });
  if (changes.length === 0)
    return {
      skip: {
        ...base,
        link: gitdirTarget,
        reason: "already uses the logical path",
      },
      worktreeDirectory,
    };
  return { changes, worktreeDirectory };
}

/**
 * Reads, never writes. Lists every link file to rewrite with its current and new text, and
 * every worktree left alone with the reason. `from` holds the old prefixes; `keepPaths` holds
 * exact repository roots, in either form, whose worktrees are never touched.
 */
export function scanWorktreeLinks({ folder, from, keepPaths = [], depth = 4 }) {
  const options = {
    folder: path.resolve(folder),
    from: [...new Set(from.map((prefix) => path.resolve(prefix)))].toSorted(
      (left, right) => right.length - left.length,
    ),
  };
  const keptHostPaths = new Set(
    keepPaths.map((kept) => mapToFolder(path.resolve(kept), options) ?? path.resolve(kept)),
  );
  const { repositories, linkFiles } = findCheckouts(options.folder, depth);
  const changes = [];
  const skipped = [];
  const covered = new Set();
  for (const repository of repositories) {
    const adminRoot = path.join(repository, ".git", "worktrees");
    const names = existsSync(adminRoot)
      ? readdirSync(adminRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .toSorted()
      : [];
    if (names.length === 0) continue;
    if (keptHostPaths.has(repository)) {
      skipped.push({
        repository,
        worktree: `${names.length} worktree(s)`,
        reason: "kept path",
      });
      continue;
    }
    for (const name of names) {
      const plan = planWorktree({ repository, name, keptHostPaths, options });
      if (plan.worktreeDirectory) covered.add(path.join(plan.worktreeDirectory, ".git"));
      if (plan.skip) skipped.push(plan.skip);
      if (plan.changes) changes.push(...plan.changes);
    }
  }
  for (const file of linkFiles) {
    if (covered.has(file)) continue;
    const link = readGitFileTarget(file);
    const target = link ? classify(link.target, options) : null;
    if (target?.kind !== "old") continue;
    const repository = target.hostPath.split("/.git/")[0];
    skipped.push({
      repository: path.dirname(file),
      link: link.target,
      reason: keptHostPaths.has(repository)
        ? "kept path"
        : "names an old path, but no scanned repository lists it as a worktree",
    });
  }
  return {
    folder: options.folder,
    from: options.from,
    keepPaths,
    depth,
    changes,
    skipped,
  };
}

/** Backs up and atomically rewrites each planned file. Refuses a file changed since the scan. */
export function applyWorktreeLinkChanges(changes, time = new Date()) {
  const stamp = time.toISOString().replaceAll(":", "-");
  const written = [];
  for (const change of changes) {
    if (readFileSync(change.file, "utf8") !== change.current)
      throw new Error(`${change.file} changed since the scan; run the command again`);
    const backup = `${change.backupBase}${WORKTREE_LINK_BACKUP_INFIX}${stamp}`;
    copyFileSync(change.file, backup, constants.COPYFILE_EXCL);
    const temporary = `${change.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, change.next, {
      mode: statSync(change.file).mode & 0o777,
      flag: "wx",
    });
    renameSync(temporary, change.file);
    written.push({ file: change.file, backup });
  }
  return written;
}

/** The report printed by repair-projects-folder-worktree-links. */
export function formatWorktreeLinkReport({ scan, written }) {
  const lines = [
    written
      ? "Applied."
      : "Dry run: nothing was written. Run again with --apply to rewrite these links.",
    `Projects folder: ${scan.folder}`,
    `Old prefixes: ${scan.from.join(", ")}`,
    `Kept paths: ${scan.keepPaths.length ? scan.keepPaths.join(", ") : "none"}`,
    `Scan depth: ${scan.depth}`,
    "",
    `${written ? "Rewrote" : "Would rewrite"} ${scan.changes.length} link file(s):`,
  ];
  for (const change of scan.changes) {
    lines.push(
      `  ${change.repository} [${change.worktree}]`,
      `    file: ${change.file}`,
      `    from: ${change.current.trim()}`,
      `    to:   ${change.next.trim()}`,
    );
  }
  const reasons = new Map();
  for (const entry of scan.skipped)
    reasons.set(entry.reason, [...(reasons.get(entry.reason) ?? []), entry]);
  lines.push("", `Skipped ${scan.skipped.length} worktree(s):`);
  for (const [reason, entries] of reasons) {
    lines.push(`  ${reason} (${entries.length}):`);
    for (const entry of entries)
      lines.push(
        `    ${entry.repository}${
          entry.worktree ? ` [${entry.worktree}]` : ""
        }${entry.link ? `: ${entry.link}` : ""}`,
      );
  }
  if (written) {
    lines.push("", "Backups:");
    for (const entry of written) lines.push(`  ${entry.file} <- ${entry.backup}`);
  }
  return lines.join("\n") + "\n";
}
