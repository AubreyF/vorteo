#!/usr/bin/env python3
"""Verify descriptor 3 owns the fixed bootstrap lock without acquiring a new lock."""
import fcntl
import os
import stat
import sys


def main():
    if sys.platform != "darwin" or len(sys.argv) != 2:
        raise ValueError("Native ownership verification required")
    file = sys.argv[1]
    if os.path.realpath(file) != file or os.path.basename(file) != "coordinator-bootstrap-execution.lock":
        raise ValueError("Invalid ownership path")
    parent = os.lstat(os.path.dirname(file))
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("Invalid ownership directory")
    owned = os.fstat(3)
    current = os.lstat(file)
    if (not stat.S_ISREG(owned.st_mode) or owned.st_uid != os.getuid()
            or owned.st_nlink != 1 or owned.st_mode & 0o077
            or (owned.st_dev, owned.st_ino) != (current.st_dev, current.st_ino)):
        raise ValueError("Invalid ownership descriptor")
    probe = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(probe, fcntl.LOCK_UN)
            raise ValueError("Descriptor does not hold ownership")
        # This succeeds only for the same inherited open file description that
        # owns the conflicting lock. Another process's lock cannot satisfy it.
        fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = os.lstat(file)
        if (owned.st_dev, owned.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError("Ownership path changed")
    finally:
        os.close(probe)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        print("Coordinator bootstrap ownership could not be verified", file=sys.stderr)
        sys.exit(1)
