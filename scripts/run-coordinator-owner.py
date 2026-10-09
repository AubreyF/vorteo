#!/usr/bin/env python3
"""Run the fixed Host bootstrap entrypoint under an inherited native lock.

The trusted launcher verifies artifact digests and mount boundaries before using
this helper. This script is not an agent command or an authorization endpoint.
"""
import fcntl
import os
import stat
import sys
import uuid


def private_path(value, directory=False):
    if not os.path.isabs(value) or os.path.realpath(value) != value:
        raise ValueError("Noncanonical ownership path")
    info = os.lstat(value)
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not expected or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError("Unprotected ownership path")
    if not directory and info.st_nlink != 1:
        raise ValueError("Linked ownership file")
    return info


def main():
    if sys.platform != "darwin" or len(sys.argv) != 7:
        raise ValueError("Native bootstrap ownership required")
    lock_path, node, entrypoint, setup, role, generation = sys.argv[1:]
    if role not in ("executor", "watchdog") or str(uuid.UUID(generation)) != generation:
        raise ValueError("Invalid bootstrap ownership")
    parent = os.path.dirname(lock_path)
    info = private_path(parent, directory=True)
    if info.st_mode & 0o077 or os.path.basename(lock_path) != "coordinator-bootstrap-execution.lock":
        raise ValueError("Ownership directory must be private")
    for file in (node, entrypoint, setup):
        private_path(file)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid()
                or opened.st_nlink != 1 or opened.st_mode & 0o077):
            raise ValueError("Unsafe ownership lock")
        # Never unlink this inode. Waiters and the current owner must lock the
        # same kernel object. Process exit releases flock even after SIGKILL.
        if role == "watchdog":
            print("waiting", flush=True)
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        current = os.lstat(lock_path)
        if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError("Ownership lock replaced")
        os.set_inheritable(descriptor, True)
        environment = dict(os.environ)
        environment["VORTEO_BOOTSTRAP_LOCK_FD"] = str(descriptor)
        os.execve(node, [node, entrypoint, setup, role, generation], environment)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("Coordinator bootstrap ownership could not be acquired", file=sys.stderr)
        sys.exit(1)
