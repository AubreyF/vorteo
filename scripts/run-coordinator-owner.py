#!/usr/bin/env python3
"""Run the fixed Host bootstrap entrypoint under an inherited native lock.

The trusted launcher verifies artifact digests and mount boundaries before using
this helper. This script is not an agent command or an authorization endpoint.
"""
import ctypes
import errno
import json
import hashlib
import signal
import time
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



def wait_for_executor(descriptor, token, timeout=180, grace=10, progress=None):
    """Fence only the recorded process generation, then acquire its kernel lock.

    This independent process still runs if Node's event loop or an artifact read
    stalls. An audit token includes the PID version, so PID reuse cannot redirect
    either signal. Lock ownership, not a deadline, proves exclusive recovery.
    """
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.proc_signal_with_audittoken.restype = ctypes.c_int
    audit = (ctypes.c_uint32 * 8)(*token)
    deadline = time.monotonic() + timeout
    observed_stage = progress() if progress else None
    terminated = False
    killed = False
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            pass
        if progress and not terminated:
            stage = progress()
            if stage != observed_stage:
                observed_stage = stage
                deadline = time.monotonic() + timeout
        if time.monotonic() >= deadline and not killed:
            requested_signal = signal.SIGKILL if terminated else signal.SIGTERM
            result = library.proc_signal_with_audittoken(ctypes.byref(audit), requested_signal)
            if result not in (0, errno.ESRCH):
                raise ValueError("Exact updater could not be fenced")
            if terminated:
                killed = True
            terminated = True
            deadline = time.monotonic() + grace
        if killed and time.monotonic() >= deadline:
            raise ValueError("Updater ownership remains unresolved")
        time.sleep(0.05)


def executor_audit_record(parent, generation):
    record_path = os.path.join(parent, "coordinator-executor-" + generation + ".json")
    private_path(record_path)
    with open(record_path, "r", encoding="utf-8") as stream:
        record = json.load(stream)
    token = record.get("auditToken")
    if (record.get("generation") != generation or record.get("pid") != os.getppid()
            or not isinstance(token, list) or len(token) != 8
            or any(type(word) is not int or not 0 <= word <= 0xffffffff for word in token)
            or token[1] != os.getuid() or token[5] != record["pid"]):
        raise ValueError("Watchdog executor identity changed")
    return record


def read_executor_stage(parent, record):
    matches = []
    # Main wins after promotion, including after its execution stage advances.
    # Only the Node journal reader reconciles promotion evidence before effects.
    for name in ("coordinator-bootstrap.json", "coordinator-bootstrap-pending.json"):
        journal = os.path.join(parent, name)
        try:
            private_path(journal)
        except FileNotFoundError:
            continue
        with open(journal, "r", encoding="utf-8") as stream:
            requests = json.load(stream)["requests"]
        matches = [item for item in requests if item.get("id") == record["id"]]
        if matches:
            break
    if len(matches) != 1 or matches[0].get("status") != "approved":
        raise ValueError("Watchdog approval is unavailable")
    request = matches[0]
    plan = request.get("plan", {})
    digest = hashlib.sha256(json.dumps(plan, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    if (plan.get("automaticRecovery") not in ("restore-previous", "restore-compatible")
            or digest != record.get("planSha256") or request.get("planSha256") != digest):
        raise ValueError("Watchdog recovery plan changed")
    execution = request.get("execution", {})
    if execution.get("generation") != record["generation"]:
        raise ValueError("Watchdog generation changed")
    return execution["stage"]


def main():
    if sys.platform != "darwin" or len(sys.argv) not in (7, 8):
        raise ValueError("Native bootstrap ownership required")
    lock_path, node, entrypoint, setup, role, generation = sys.argv[1:7]
    if role not in ("executor", "watchdog") or str(uuid.UUID(generation)) != generation:
        raise ValueError("Invalid bootstrap ownership")
    automatic = len(sys.argv) == 8 and sys.argv[7] == "automatic-recovery"
    if len(sys.argv) == 8 and (not automatic or role != "watchdog"):
        raise ValueError("Invalid recovery mode")
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
            record = executor_audit_record(parent, generation) if automatic else None
            if record is not None:
                read_executor_stage(parent, record)
            print("waiting", flush=True)
        if automatic:
            wait_for_executor(descriptor, record["auditToken"],
                              progress=lambda: read_executor_stage(parent, record))
        else:
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
