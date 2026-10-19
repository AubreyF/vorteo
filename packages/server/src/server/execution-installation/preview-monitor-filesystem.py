"""Managed filesystem primitive. No service invocation, recovery replay or rollback.

The coordinator transport binds root=/, uid=gid=0 and the immutable
container ID from protected configuration. Tests map that filesystem to a private
disposable root owned by their current account; they never use the live target.
"""

import hashlib
import json
import os
import re
import stat
import uuid
import base64
import ctypes
import sys


TARGET = "home/paseo/.local/bin/paseo-preview"
RECEIPTS = "var/lib/vorteo/preview-monitor-maintenance"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
MAX_BYTES = 1024 * 1024


class MonitorUncertain(Exception):
    def __init__(self, receipt):
        super().__init__("Monitor replacement requires inspection; never replay or roll back automatically")
        self.receipt = receipt


def directory_identity(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)


def file_identity(info):
    return directory_identity(info) + (info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class PinnedDirectories:
    def __init__(self, binding):
        self.binding = binding
        self.descriptors = []
        self.edges = []
        root = binding["root"]
        if os.path.realpath(root) != root:
            raise ValueError("Filesystem root must be canonical")
        try:
            self.root = self.adopt(os.open(root, DIRECTORY_FLAGS))
        except Exception:
            self.close()
            raise
        self.root_identity = directory_identity(os.fstat(self.root))

    def adopt(self, descriptor):
        self.descriptors.append(descriptor)
        self.require_directory(os.fstat(descriptor))
        return descriptor

    def require_directory(self, info):
        owned = info.st_uid == self.binding["uid"] and info.st_gid == self.binding["gid"]
        if not stat.S_ISDIR(info.st_mode) or (not owned and info.st_uid != self.binding.get("parentUid", self.binding["uid"])) or info.st_mode & 0o022:
            raise ValueError("Monitor parent must retain protected ownership and permissions")

    def open(self, relative):
        parent = self.root
        for name in relative.split("/"):
            if not name or name in (".", ".."):
                raise ValueError("Noncanonical directory component")
            child = self.adopt(os.open(name, DIRECTORY_FLAGS, dir_fd=parent))
            self.edges.append((parent, name, child, directory_identity(os.fstat(child))))
            parent = child
        return parent

    def verify_selected(self):
        # Reopen the root and check every edge, not just canonical pathname text.
        # Descriptor-relative writes cannot follow a replacement ancestor. If the
        # selected path is detached before or after rename, success is forbidden.
        root = os.open(self.binding["root"], DIRECTORY_FLAGS)
        try:
            if directory_identity(os.fstat(root)) != self.root_identity:
                raise ValueError("Selected filesystem root changed")
        finally:
            os.close(root)
        for parent, name, child, expected in self.edges:
            selected = os.stat(name, dir_fd=parent, follow_symlinks=False)
            self.require_directory(selected)
            if directory_identity(selected) != expected or directory_identity(os.fstat(child)) != expected:
                raise ValueError("Selected monitor ancestry changed")

    def close(self):
        for descriptor in reversed(self.descriptors):
            os.close(descriptor)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_target(parent, binding, name="paseo-preview", protected=True):
    descriptor = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        owned = before.st_uid == binding["uid"] and before.st_gid == binding["gid"]
        if not stat.S_ISREG(before.st_mode) or (protected and (not owned or before.st_nlink != 1)):
            raise ValueError("Monitor must be one protected regular file")
        if (protected and stat.S_IMODE(before.st_mode) != 0o755) or before.st_size > MAX_BYTES:
            raise ValueError("Monitor mode or size changed")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            value = stream.read(MAX_BYTES + 1)
        selected = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if file_identity(before) != file_identity(os.fstat(descriptor)) or file_identity(before) != file_identity(selected):
            raise ValueError("Monitor changed while reading")
        return value, file_identity(before)
    finally:
        os.close(descriptor)



def exchange_monitor(parent, staged):
    # Exchange preserves the entry actually displaced, including a replacement
    # arriving after our final read. Ordinary rename would silently discard it.
    # Fail closed on unsupported platforms/filesystems; there is no fallback.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "linux":
        exchange = libc.renameat2
        flags = 2  # RENAME_EXCHANGE
    elif sys.platform == "darwin":
        exchange = libc.renameatx_np
        flags = 2  # RENAME_SWAP, used by disposable native Host fixtures
    else:
        raise OSError("Atomic monitor exchange is unsupported")
    exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    exchange.restype = ctypes.c_int
    if exchange(parent, os.fsencode(staged), parent, b"paseo-preview", flags) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))


def exchanged_identity(identity):
    # Rename changes ctime on Linux. All other recorded inode attributes,
    # including device/inode and mtime, must match across the exchange.
    return identity[:-1]


def write_new(parent, name, value, mode, binding):
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        with os.fdopen(os.dup(descriptor), "wb") as stream:
            stream.write(value)
            stream.flush()
        os.fchown(descriptor, binding["uid"], binding["gid"])
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
        identity = file_identity(os.fstat(descriptor))
    finally:
        os.close(descriptor)
    os.fsync(parent)
    return identity


def save_receipt(directory, receipt, binding):
    temporary = "receipt." + str(uuid.uuid4())
    value = (json.dumps(receipt, sort_keys=True) + "\n").encode()
    write_new(directory, temporary, value, 0o600, binding)
    os.replace(temporary, "receipt.json", src_dir_fd=directory, dst_dir_fd=directory)
    os.fsync(directory)


def validate_request(request, binding):
    request = dict(request)
    for field in ("id", "revision"):
        if str(uuid.UUID(request[field])) != request[field]:
            raise ValueError("Noncanonical request identity")
    for field in ("planSha256", "containerId", "beforeSha256", "candidateSha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", request[field]):
            raise ValueError("Invalid reviewed digest or container identity")
    if request["containerId"] != binding["containerId"]:
        raise ValueError("Immutable container identity changed")
    if request["destination"] != "/" + TARGET:
        raise ValueError("Monitor destination must be fixed")
    for field in ("candidate", "previous"):
        encoded = request[field + "Base64"]
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_BYTES + 2) // 3):
            raise ValueError("Monitor artifacts must be bounded base64")
        request[field] = base64.b64decode(encoded, validate=True)
        if len(request[field]) > MAX_BYTES:
            raise ValueError("Monitor artifacts must be bounded reviewed bytes")
    if digest(request["candidate"]) != request["candidateSha256"] or digest(request["previous"]) != request["beforeSha256"]:
        raise ValueError("Reviewed monitor bytes changed")
    if request["beforeSha256"] == request["candidateSha256"]:
        raise ValueError("Monitor candidate must differ from retained bytes")
    return request


def replace_monitor(request, binding, checkpoint=lambda _phase: None):
    request = validate_request(request, binding)
    pinned = PinnedDirectories(binding)
    try:
        parent = pinned.open("home/paseo/.local/bin")
        if request.get("ancestrySha256") != ancestry_digest(pinned) and request.get("ancestrySha256") is not None:
            raise ValueError("Reviewed monitor ancestry changed")
        # Create only fixed private receipt directories under protected /var/lib.
        # Existing directory ownership and permissions are never repaired.
        if binding.get("production"):
            state = pinned.open("var/lib")
            for name in ("vorteo", "preview-monitor-maintenance"):
                try:
                    os.mkdir(name, 0o700, dir_fd=state)
                    os.fsync(state)
                except FileExistsError:
                    pass
                child = pinned.adopt(os.open(name, DIRECTORY_FLAGS, dir_fd=state))
                info = os.fstat(child)
                if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                    raise ValueError("Receipt ancestry must be root private")
                pinned.edges.append((state, name, child, directory_identity(info)))
                state = child
            receipts = state
        else:
            receipts = pinned.open(RECEIPTS)
        if stat.S_IMODE(os.fstat(receipts).st_mode) != 0o700:
            raise ValueError("Monitor receipts require an existing private directory")
        pinned.verify_selected()
        before, before_identity = read_target(parent, binding)
        if before != request["previous"]:
            raise ValueError("Monitor selection changed before dispatch")
        # Exclusive creation is also the durable no-replay fence. A partial job
        # directory or abandoned lock requires inspection, never automatic cleanup.
        os.mkdir(request["id"], 0o700, dir_fd=receipts)
        os.fsync(receipts)
        job = pinned.adopt(os.open(request["id"], DIRECTORY_FLAGS, dir_fd=receipts))
        pinned.edges.append((receipts, request["id"], job, directory_identity(os.fstat(job))))
        receipt = {
            "id": request["id"], "revision": request["revision"],
            "planSha256": request["planSha256"], "containerId": binding["containerId"],
            "destination": request["destination"], "beforeSha256": digest(before),
            "candidateSha256": request["candidateSha256"], "status": "uncertain",
            "phase": "retaining-before", "commitAttempted": False,
        }
        try:
            write_new(job, "before", before, 0o600, binding)
            save_receipt(job, receipt, binding)
            os.mkdir(".paseo-preview-maintenance-lock", 0o700, dir_fd=parent)
            os.fsync(parent)
            lock = pinned.adopt(os.open(".paseo-preview-maintenance-lock", DIRECTORY_FLAGS, dir_fd=parent))
            lock_edge = (parent, ".paseo-preview-maintenance-lock", lock, directory_identity(os.fstat(lock)))
            pinned.edges.append(lock_edge)
            staged = ".paseo-preview." + request["id"] + ".staged"
            staged_identity = write_new(parent, staged, request["candidate"], 0o755, binding)
            checkpoint("before-commit")
            pinned.verify_selected()
            current, identity = read_target(parent, binding)
            if current != before or identity != before_identity:
                raise ValueError("Monitor selection changed before commit")
            if file_identity(os.stat(staged, dir_fd=parent, follow_symlinks=False)) != staged_identity:
                raise ValueError("Staged monitor file changed")
            receipt.update(phase="commit-intent", commitAttempted=True,
                           displacedPath="/home/paseo/.local/bin/" + staged)
            save_receipt(job, receipt, binding)
            # Check again after the durable intent write; hooks test the final race.
            checkpoint("commit-intent")
            pinned.verify_selected()
            current, identity = read_target(parent, binding)
            if current != before or identity != before_identity:
                raise ValueError("Monitor selection changed at commit")
            if file_identity(os.stat(staged, dir_fd=parent, follow_symlinks=False)) != staged_identity:
                raise ValueError("Staged monitor changed at commit")
            exchange_monitor(parent, staged)
            os.fsync(parent)
            # Retain the actual displaced bytes in the private job directory
            # before checking whether they were the approved selection. Keep the
            # exchanged entry too, never delete it or automatically swap back.
            displaced, displaced_identity = read_target(parent, binding, staged, protected=False)
            write_new(job, "displaced", displaced, 0o600, binding)
            receipt.update(displacedSha256=digest(displaced))
            save_receipt(job, receipt, binding)
            if displaced != before or exchanged_identity(displaced_identity) != exchanged_identity(before_identity):
                raise ValueError("Unreviewed monitor entry displaced at commit")
            checkpoint("after-commit")
            pinned.verify_selected()
            installed, selected_identity = read_target(parent, binding)
            if installed != request["candidate"] or exchanged_identity(selected_identity) != exchanged_identity(staged_identity):
                raise ValueError("Selected monitor does not match approved bytes")
            receipt.update(status="installed", phase="verified")
            save_receipt(job, receipt, binding)
            checkpoint("after-receipt")
            pinned.verify_selected()
            installed, selected_identity = read_target(parent, binding)
            if installed != request["candidate"] or exchanged_identity(selected_identity) != exchanged_identity(staged_identity):
                raise ValueError("Selected monitor changed after receipt")
            os.rmdir(".paseo-preview-maintenance-lock", dir_fd=parent)
            os.fsync(parent)
            pinned.edges.remove(lock_edge)
            pinned.verify_selected()
            installed, selected_identity = read_target(parent, binding)
            if installed != request["candidate"] or exchanged_identity(selected_identity) != exchanged_identity(staged_identity):
                raise ValueError("Selected monitor changed before return")
            return receipt
        except Exception as error:
            receipt.update(status="uncertain", phase="inspection-required", error=type(error).__name__)
            save_receipt(job, receipt, binding)
            raise MonitorUncertain(receipt) from error
    finally:
        pinned.close()


def ancestry_digest(pinned):
    identities = [pinned.root_identity] + [edge[3] for edge in pinned.edges]
    return digest(json.dumps(identities, separators=(",", ":")).encode())


def inspect_monitor(binding):
    pinned = PinnedDirectories(binding)
    try:
        parent = pinned.open("home/paseo/.local/bin")
        pinned.verify_selected()
        value, identity = read_target(parent, binding)
        ancestry = ancestry_digest(pinned)
        pinned.verify_selected()
        return {"containerId": binding["containerId"], "destination": "/" + TARGET,
                "canonicalPath": "/" + TARGET, "sha256": digest(value), "uid": identity[2],
                "gid": identity[3], "mode": stat.S_IMODE(identity[4]),
                "regularFile": True, "links": identity[5], "ancestrySha256": ancestry}
    finally:
        pinned.close()


def coordinator_main(container_id):
    # Trusted transport supplies immutable ID in code, never in request fields.
    import sys
    binding = {"root": "/", "uid": 0, "gid": 0, "parentUid": 1000,
               "containerId": container_id, "production": True}
    try:
        envelope = json.loads(sys.stdin.buffer.read(3 * MAX_BYTES + 16384))
        if envelope["operation"] == "inspect":
            result = inspect_monitor(binding)
        elif envelope["operation"] == "replace":
            result = replace_monitor(envelope["request"], binding)
        else:
            raise ValueError("Unsupported monitor operation")
        print(json.dumps({"ok": True, "result": result}))
    except MonitorUncertain as error:
        print(json.dumps({"ok": False, "uncertain": True, "receipt": error.receipt}))
    except Exception as error:
        print(json.dumps({"ok": False, "uncertain": True, "error": type(error).__name__}))
