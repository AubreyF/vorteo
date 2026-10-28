#!/usr/bin/env python3
"""Report, and optionally remove, stale agent scratch directories in a container.

Agents create checkouts and build caches under /tmp. A long-lived container
never clears them, so its writable layer grows without bound. An entry is
stale only when nothing inside changed within the retention period, no process
uses it, and any Git checkout in it has no uncommitted or unpushed work.
The default is a dry run; pass --delete to remove what the report lists.
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
    """Paths held by any process as its working directory, root or open file."""
    held = set()
    for entry in proc.iterdir() if proc.is_dir() else []:
        if not entry.name.isdigit():
            continue
        links = [entry / 'cwd', entry / 'root']
        try:
            links += list((entry / 'fd').iterdir())
        except OSError:
            pass
        for link in links:
            try:
                held.add(os.readlink(link))
            except OSError:
                continue
    return held


def recently_modified(path, cutoff):
    """True when the entry or anything beneath it changed after the cutoff."""
    try:
        if path.lstat().st_mtime > cutoff:
            return True
    except OSError:
        return True
    if path.is_symlink() or not path.is_dir():
        return False
    for directory, names, files in os.walk(path, onerror=lambda error: None):
        for name in names + files:
            try:
                if os.lstat(os.path.join(directory, name)).st_mtime > cutoff:
                    return True
            except OSError:
                return True
    return False


def unsafe_git(path, run=subprocess.run):
    """Reason to keep a checkout, or None when it holds no unique work."""
    if not (path / '.git').exists():
        return None
    git = shutil.which('git')
    if not git:
        return 'git unavailable to inspect checkout'

    def ask(*arguments):
        return run([git, '-C', str(path), *arguments], capture_output=True, text=True, timeout=60)

    status = ask('status', '--porcelain')
    if status.returncode != 0:
        return 'git status failed'
    if status.stdout.strip():
        return 'uncommitted changes'
    # Commits that no remote branch contains exist only here (and in the shared object store).
    unpushed = ask('log', '--oneline', '-1', 'HEAD', '--not', '--remotes')
    if unpushed.returncode != 0 or unpushed.stdout.strip():
        return 'unpushed commits'
    return None


def inside(held, path):
    prefix = str(path)
    return any(item == prefix or item.startswith(prefix + os.sep) for item in held)


def plan(root, days, now=None, held=None, run=subprocess.run):
    cutoff = (now or time.time()) - days * 86400
    held = busy_paths() if held is None else held
    stale, kept = [], []
    for entry in sorted(Path(root).iterdir()):
        reason = None
        if inside(held, entry):
            reason = 'in use by a process'
        elif recently_modified(entry, cutoff):
            reason = 'recently modified'
        else:
            reason = unsafe_git(entry, run)
        (kept if reason else stale).append({'path': str(entry), **({'reason': reason} if reason else {})})
    return stale, kept


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
    stale, kept = plan(root, args.days)
    removed = []
    if args.delete:
        held = busy_paths()
        for item in stale:
            path = Path(item['path'])
            # Recheck immediately before removal; work may have resumed during the scan.
            if inside(held, path) or recently_modified(path, time.time() - args.days * 86400):
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
            removed.append(str(path))
    json.dump({'root': str(root), 'days': args.days, 'stale': stale, 'kept': kept, 'removed': removed},
              sys.stdout, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
