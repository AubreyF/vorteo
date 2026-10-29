#!/usr/bin/env python3
"""Report, and optionally remove, stale agent scratch directories in a container.

Agents create checkouts and build caches under /tmp. A long-lived container
never clears them, so its writable layer grows without bound. An entry is
stale only when nothing inside changed within the retention period, every part
of it can be read, no process uses it, and every Git repository inside it, at
any depth, has no uncommitted, stashed or unpushed work. Bare repositories are
always kept. The default is a dry run; --delete also requires that every
process can be inspected, rechecks each entry before removing it and reports
removals that fail.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def busy_paths(proc=Path('/proc')):
    """Paths a process uses: working directory, root, executable, open files and mapped files.

    A running program's executable and shared libraries appear only in exe and maps, not as open
    file descriptors. Missing them once deleted the Node runtime a daemon was running from.
    """
    held = set()
    for entry in proc.iterdir() if proc.is_dir() else []:
        if not entry.name.isdigit():
            continue
        links = [entry / 'cwd', entry / 'root', entry / 'exe']
        try:
            links += list((entry / 'fd').iterdir())
        except OSError:
            pass
        for link in links:
            try:
                held.add(os.readlink(link).removesuffix(' (deleted)'))
            except OSError:
                continue
        try:
            for line in (entry / 'maps').read_text().splitlines():
                fields = line.split(None, 5)
                if len(fields) == 6 and fields[5].startswith('/'):
                    held.add(fields[5].removesuffix(' (deleted)'))
        except OSError:
            pass
    return held


def visibility_gaps(proc=Path('/proc')):
    """Reasons the process table cannot be fully inspected; any gap makes deletion unsafe."""
    if not proc.is_dir():
        return ['process table unavailable']
    gaps = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        for probe in (lambda: os.readlink(entry / 'exe'), lambda: list((entry / 'fd').iterdir()),
                      lambda: (entry / 'maps').read_text()):
            try:
                probe()
            except PermissionError:
                gaps.append(f'process {entry.name} cannot be inspected')
                break
            except OSError:
                # The process exited or is a kernel thread without an executable.
                continue
    return gaps


def scan(path, cutoff):
    """Walk an entry once: a reason to keep it, and every Git repository found inside."""
    try:
        info = path.lstat()
    except OSError:
        return 'cannot be inspected', []
    if info.st_mtime > cutoff:
        return 'recently modified', []
    if path.is_symlink() or not path.is_dir():
        return None, []
    errors, repositories = [], []

    def failed(error):
        errors.append(error)

    for directory, names, files in os.walk(path, onerror=failed):
        here = Path(directory)
        if '.git' in names or '.git' in files:
            repositories.append(here)
            if '.git' in names:
                # Git's own metadata is inspected through git, not walked.
                names.remove('.git')
        elif {'HEAD', 'objects', 'refs'} <= set(names + files):
            return 'contains a bare repository', repositories
        for name in names + files:
            try:
                if os.lstat(os.path.join(directory, name)).st_mtime > cutoff:
                    return 'recently modified', repositories
            except OSError:
                return 'cannot be inspected', repositories
    if errors:
        return 'part of it cannot be read', repositories
    return None, repositories


def unsafe_git(repository, run=subprocess.run):
    """Reason to keep a repository, or None when every local commit also exists on a remote."""
    git = shutil.which('git')
    if not git:
        return 'git unavailable to inspect a repository'

    def ask(*arguments):
        return run([git, '-C', str(repository), *arguments], capture_output=True, text=True, timeout=60)

    status = ask('status', '--porcelain')
    if status.returncode != 0:
        return 'git status failed'
    if status.stdout.strip():
        return 'uncommitted changes'
    stash = ask('stash', 'list')
    if stash.returncode != 0 or stash.stdout.strip():
        return 'stashed changes'
    # Any branch, tag or detached HEAD commit missing from every remote exists only here.
    unpushed = ask('log', '--oneline', '-1', 'HEAD', '--branches', '--tags', '--not', '--remotes')
    if unpushed.returncode != 0 or unpushed.stdout.strip():
        return 'unpushed commits'
    return None


def inside(held, path):
    prefix = str(path)
    return any(item == prefix or item.startswith(prefix + os.sep) for item in held)


def keep_reason(entry, cutoff, held, run=subprocess.run):
    if inside(held, entry):
        return 'in use by a process'
    reason, repositories = scan(entry, cutoff)
    if reason:
        return reason
    for repository in repositories:
        reason = unsafe_git(repository, run)
        if reason:
            label = '' if repository == entry else f' in {repository.relative_to(entry)}'
            return reason + label
    return None


def plan(root, days, now=None, held=None, run=subprocess.run):
    cutoff = (now or time.time()) - days * 86400
    held = busy_paths() if held is None else held
    stale, kept = [], []
    for entry in sorted(Path(root).iterdir()):
        reason = keep_reason(entry, cutoff, held, run)
        (kept if reason else stale).append({'path': str(entry), **({'reason': reason} if reason else {})})
    return stale, kept


def remove(stale, days, run=subprocess.run, proc=Path('/proc')):
    """Delete stale entries after rechecking each one; report what could not be removed."""
    removed, failed = [], []
    for item in stale:
        path = Path(item['path'])
        # Work may have resumed during the scan, so every safety check runs again here.
        reason = keep_reason(path, time.time() - days * 86400, busy_paths(proc), run)
        if reason:
            failed.append({'path': str(path), 'reason': 'kept at deletion: ' + reason})
            continue
        errors = []
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, onerror=lambda function, target, info: errors.append(f'{target}: {info[1]}'))
        else:
            try:
                path.unlink()
            except OSError as error:
                errors.append(str(error))
        if errors or os.path.lexists(path):
            failed.append({'path': str(path), 'reason': 'removal incomplete', 'errors': errors[:5]})
        else:
            removed.append(str(path))
    return removed, failed


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', default='/tmp')
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--delete', action='store_true')
    args = parser.parse_args(argv)
    if args.days < 1:
        raise ValueError('Retention must be at least one day')
    root = Path(args.root).resolve()
    if root == Path('/'):
        raise ValueError('Refusing to reap the filesystem root')
    gaps = visibility_gaps()
    if args.delete and gaps:
        # Without full visibility a running program's files could look unused.
        raise ValueError('Refusing to delete: ' + '; '.join(gaps[:5]))
    stale, kept = plan(root, args.days)
    removed, failed = remove(stale, args.days) if args.delete else ([], [])
    json.dump({'root': str(root), 'days': args.days, 'visibilityGaps': gaps[:20], 'stale': stale,
               'kept': kept, 'removed': removed, 'failed': failed}, sys.stdout, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
