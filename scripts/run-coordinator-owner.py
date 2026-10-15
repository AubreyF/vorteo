#!/usr/bin/env python3
"""Run the fixed Host bootstrap entrypoint under an inherited native lock.

The trusted launcher verifies artifact digests and mount boundaries before using
this helper. This script is not an agent command or an authorization endpoint.
"""
import ctypes
import datetime
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


class PreclaimProofError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


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


def private_document(file):
    private_path(file)
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or before.st_nlink != 1 or before.st_mode & 0o077
                or before.st_size > 4 * 1024 * 1024):
            raise ValueError("Invalid preclaim journal")
        with os.fdopen(os.dup(descriptor), "r", encoding="utf-8") as stream:
            value = json.load(stream)
        after = os.fstat(descriptor)
        current = os.lstat(file)
        fields = lambda item: (item.st_dev, item.st_ino, item.st_size,
                               item.st_mtime_ns, item.st_ctime_ns, item.st_mode)
        if fields(before) != fields(after) or fields(before) != fields(current):
            raise ValueError("Preclaim journal changed while reading")
        return value
    finally:
        os.close(descriptor)


def verify_owned_descriptor(file, descriptor):
    private_path(file)
    owned = os.fstat(descriptor)
    current = os.lstat(file)
    if (not stat.S_ISREG(owned.st_mode) or owned.st_uid != os.getuid()
            or owned.st_nlink != 1 or owned.st_mode & 0o077
            or (owned.st_dev, owned.st_ino) != (current.st_dev, current.st_ino)):
        raise ValueError("Preclaim ownership descriptor changed")
    probe = os.open(file, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(probe, fcntl.LOCK_UN)
            raise ValueError("Preclaim recovery exclusion is not held")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(probe)


def preclaim_review(state, request_id, revision, generation, digest, stage):
    journal = private_document(os.path.join(state, "coordinator-preclaim-reviews.json"))
    matches = [item for item in journal["requests"] if item["id"] == request_id]
    if journal["version"] != 1 or len(matches) != 1:
        raise ValueError("Preclaim review is unavailable")
    request = matches[0]
    plan = request["plan"]
    actual = hashlib.sha256(json.dumps(plan, ensure_ascii=False, separators=(",", ":"),
                                      allow_nan=False).encode("utf-8")).hexdigest()
    if (request["revision"] != revision or request["status"] != "approved"
            or not request.get("decisionAt") or request["planSha256"] != digest
            or actual != digest or request["execution"]["generation"] != generation
            or request["execution"]["stage"] != stage
            or plan["operation"] != "bootstrap-preclaim-recovery"
            or plan["original"]["status"] != "approved"
            or plan["original"].get("execution") is not None
            or plan["canceled"]["status"] != "canceled"
            or plan["canceled"].get("execution") is not None
            or plan["canceled"].get("decisionAt") is not None
            or plan["original"]["plan"]["state"]["directory"] != state):
        raise PreclaimProofError("review_changed")
    record = private_document(os.path.join(state, "coordinator-preclaim-recovery-" + request_id + ".json"))
    cancellation = record["cancellation"]
    owner_cancellation = plan.get("ownerCancellation")
    approval_pin = plan.get("originalApproval")
    if bool(owner_cancellation) != bool(approval_pin):
        raise PreclaimProofError("cancellation_unproven")
    canceled = dict(plan["canceled"], decisionAt=request["decisionAt"])
    if owner_cancellation:
        original = plan["original"]
        retained = json.loads(preclaim_protected_bytes(approval_pin["path"], approval_pin["sha256"]))
        expected = dict(original, revision=owner_cancellation["revision"], status="canceled",
                        decisionAt=owner_cancellation["decisionAt"])
        timestamp = lambda value: datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if (retained != original or owner_cancellation != expected
                or owner_cancellation != dict(plan["canceled"], decisionAt=owner_cancellation["decisionAt"])
                or owner_cancellation["revision"] == original["revision"]
                or timestamp(owner_cancellation["decisionAt"]) < timestamp(original["decisionAt"])):
            raise PreclaimProofError("cancellation_unproven")
        canceled = owner_cancellation
    if (record["fenced"] is not True or cancellation["recoveryId"] != request_id
            or cancellation["recoveryGeneration"] != generation
            or cancellation["recoveryPlanSha256"] != digest
            or cancellation["original"] != plan["original"]
            or cancellation["canceled"] != canceled
            or cancellation.get("ownerCancellation") != owner_cancellation
            or cancellation["executor"] != plan["executor"]):
        raise PreclaimProofError("cancellation_unproven")
    originals = []
    for name in ("coordinator-bootstrap.json", "coordinator-bootstrap-pending.json"):
        file = os.path.join(state, name)
        try:
            old = private_document(file)
        except FileNotFoundError:
            continue
        originals.extend(item for item in old["requests"] if item["id"] == plan["original"]["id"])
    if not originals or any(item != canceled for item in originals):
        raise PreclaimProofError("cancellation_unproven")
    return request


def preclaim_group_members(group):
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_listpgrppids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    library.proc_listpgrppids.restype = ctypes.c_int
    capacity = 65536
    members = (ctypes.c_int * capacity)()
    ctypes.set_errno(0)
    count = library.proc_listpgrppids(group, members, ctypes.sizeof(members))
    if count < 0 or count >= capacity or ctypes.get_errno() != 0:
        raise PreclaimProofError("children_unproven")
    result = list(members[:count])
    if any(pid <= 0 for pid in result) or len(set(result)) != len(result):
        raise PreclaimProofError("children_unproven")
    return sorted(result)


def preclaim_terminal_ownership(state, request_id, revision, generation, digest, claimed=False):
    """Acquire only the reviewed inode through inherited descriptor 4.

    The caller retains that same open file description after this verifier exits.
    This proves absence and kernel ownership, not selection or terminal success.
    """
    info = private_path(state, directory=True)
    if info.st_mode & 0o077:
        raise ValueError("Preclaim state must be private")
    for value in (request_id, revision, generation):
        if str(uuid.UUID(value)) != value:
            raise ValueError("Invalid preclaim identity")
    verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)

    def reviewed():
        if not claimed:
            return preclaim_review(state, request_id, revision, generation, digest, "verifying")
        records = private_document(os.path.join(state, "coordinator-claimed-reviews.json"))
        matches = [item for item in records["requests"] if item["id"] == request_id]
        if len(matches) != 1 or matches[0].get("execution", {}).get("stage") not in ("verifying", "succeeded"):
            raise PreclaimProofError("review_changed")
        return claimed_review(state, request_id, revision, generation, digest, matches[0]["execution"]["stage"])

    request = reviewed()
    plan = request["plan"]
    lock = plan["executionLock"]
    file = os.path.join(state, "coordinator-bootstrap-execution.lock")
    private_path(file)
    opened = os.fstat(4)
    current = os.lstat(file)
    if (lock["path"] != file or str(opened.st_dev) != lock["device"]
            or str(opened.st_ino) != lock["inode"]
            or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
            or not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid()
            or opened.st_nlink != 1 or opened.st_mode & 0o077):
        raise PreclaimProofError("execution_lock_changed")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int

    def require_exit():
        buffer = ctypes.create_string_buffer(4096)
        ctypes.set_errno(0)
        count = library.proc_pidinfo(plan["executor"]["identity"]["pid"], 3, 0, buffer, len(buffer))
        if count != 0 or ctypes.get_errno() != errno.ESRCH:
            raise PreclaimProofError("executor_exit_unproven")
        if preclaim_group_members(plan["executor"]["identity"]["pid"]):
            raise PreclaimProofError("children_unproven")

    require_exit()
    fcntl.flock(4, fcntl.LOCK_EX | fcntl.LOCK_NB)
    require_exit()
    verify_owned_descriptor(file, 4)
    if reviewed() != request:
        raise ValueError("Preclaim review changed during verification")



def preclaim_protected_bytes(file, digest):
    private_path(file)
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if (before.st_size > 1024 * 1024 or not stat.S_ISREG(before.st_mode)
                or before.st_uid != os.getuid() or before.st_nlink != 1 or before.st_mode & 0o022):
            raise ValueError("Preclaim dependency is too large")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            source = stream.read(1024 * 1024 + 1)
        after = os.fstat(descriptor)
        current = os.lstat(file)
        fields = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_uid,
                               item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if (fields(before) != fields(after) or fields(before) != fields(current)
                or hashlib.sha256(source).hexdigest() != digest):
            raise ValueError("Preclaim dependency changed")
        return source
    finally:
        os.close(descriptor)


def preclaim_write_once(file, value):
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(descriptor), "w", encoding="utf-8") as stream:
            json.dump(value, stream)
            stream.flush()
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory = os.open(os.path.dirname(file), os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def preclaim_boot_nanoseconds():
    # Python 3.9 on macOS makes time.monotonic() relative to each interpreter.
    # Durable receipts cross interpreter lifetimes and need the kernel epoch.
    class Timebase(ctypes.Structure):
        _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    library.mach_absolute_time.argtypes = []
    library.mach_absolute_time.restype = ctypes.c_uint64
    library.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
    library.mach_timebase_info.restype = ctypes.c_int
    base = Timebase()
    if library.mach_timebase_info(ctypes.byref(base)) != 0 or base.denom == 0:
        raise ValueError("Native grace clock unavailable")
    return library.mach_absolute_time() * base.numer // base.denom


def preclaim_effect(state, request_id, revision, generation, digest, effect, inspector, inspector_digest):
    """Internal managed-runner boundary, never an agent-facing signal command.

    The runner supplies its immutable inspector and holds descriptor 3. A durable
    exclusive dispatch file consumes this attempt before the audit-token signal.
    A lost result can only be reconciled by observation, never by replay.
    """
    info = private_path(state, directory=True)
    if info.st_mode & 0o077 or effect not in ("terminate", "kill"):
        raise ValueError("Invalid preclaim effect")
    for value in (request_id, revision, generation):
        if str(uuid.UUID(value)) != value:
            raise ValueError("Invalid preclaim identity")
    verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)
    request = preclaim_review(state, request_id, revision, generation, digest, "effect_pending")
    plan = request["plan"]
    record = private_document(os.path.join(state, "coordinator-preclaim-recovery-" + request_id + ".json"))
    if (not record.get("terminateIntentAt")
            or (effect == "terminate" and record.get("killIntentAt") is not None)
            or (effect == "kill" and (not record.get("killIntentAt")
                or plan["signalPolicy"]["escalation"] != "SIGKILL"))):
        raise PreclaimProofError("effect_unreserved")
    scope = {"__name__": "preclaim_native_inspector"}
    exec(compile(preclaim_protected_bytes(inspector, inspector_digest), inspector, "exec"), scope)
    def inspect(*args):
        try:
            return scope["inspect"](*args)
        except scope["InspectionError"]:
            raise PreclaimProofError("process_changed")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    library.proc_listchildpids.restype = ctypes.c_int
    library.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.proc_signal_with_audittoken.restype = ctypes.c_int

    def verify():
        verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)
        if preclaim_review(state, request_id, revision, generation, digest, "effect_pending") != request:
            raise PreclaimProofError("review_changed")
        lock = plan["executionLock"]
        if lock["path"] != os.path.join(state, "coordinator-bootstrap-execution.lock"):
            raise PreclaimProofError("execution_lock_changed")
        selected = private_path(lock["path"])
        if str(selected.st_dev) != lock["device"] or str(selected.st_ino) != lock["inode"]:
            raise PreclaimProofError("execution_lock_changed")
        for key in ("selectedLauncher", "selectedConfiguration", "setup", "executorEntrypoint"):
            preclaim_protected_bytes(plan[key]["path"], plan[key]["sha256"])
        if inspect(plan["coordinatorProcess"]["pid"]) != plan["coordinatorProcess"]:
            raise PreclaimProofError("process_changed")
        observed = inspect(plan["executor"]["identity"]["pid"], "--audit-token")
        expected = plan["executor"]
        if observed["identity"]["parentPid"] == 1 and expected["identity"]["parentPid"] != 1:
            retained_file = plan["retainedObservation"]
            retained = json.loads(preclaim_protected_bytes(retained_file["path"], retained_file["sha256"]))
            original = plan["original"]
            binding = {key: original[key] for key in ("id", "revision", "planSha256")}
            if (retained["request"] != binding or retained["executor"] != expected
                    or retained["host"] != plan["hostProcess"]
                    or retained["coordinator"] != plan["coordinatorProcess"]):
                raise PreclaimProofError("process_changed")
            inspect(plan["hostProcess"]["pid"], "--require-exited")
            expected = dict(expected, identity=dict(expected["identity"], parentPid=1))
        elif inspect(plan["hostProcess"]["pid"]) != plan["hostProcess"]:
            raise PreclaimProofError("process_changed")
        if observed != expected:
            raise PreclaimProofError("process_changed")
        pid = observed["identity"]["pid"]
        # The fixed managed launcher starts a detached session. Refuse a target
        # that no longer owns that group, or any extra member including orphans.
        if os.getpgid(pid) != pid or os.getsid(pid) != pid or preclaim_group_members(pid) != [pid]:
            raise PreclaimProofError("children_unproven")
        children = (ctypes.c_int * 65536)()
        ctypes.set_errno(0)
        count = library.proc_listchildpids(observed["identity"]["pid"], children, ctypes.sizeof(children))
        if count != 0 or ctypes.get_errno() != 0:
            raise PreclaimProofError("children_unproven")
        if inspect(observed["identity"]["pid"], "--audit-token") != expected:
            raise PreclaimProofError("process_changed")
        if private_document(os.path.join(state, "coordinator-preclaim-recovery-" + request_id + ".json")) != record:
            raise PreclaimProofError("effect_unreserved")

    verify()
    if effect == "kill":
        previous = private_document(os.path.join(state, "coordinator-preclaim-effect-" + generation + "-terminate-sent.json"))
        elapsed = preclaim_boot_nanoseconds() - previous["sentMonotonicNs"]
        if (previous["requestId"] != request_id or previous["revision"] != revision
                or previous["generation"] != generation or previous["planSha256"] != digest
                or previous["effect"] != "terminate" or previous["executor"] != plan["executor"]
                or type(previous["sentMonotonicNs"]) is not int
                or previous["sentMonotonicNs"] <= 0
                or elapsed < plan["signalPolicy"]["graceSeconds"] * 1000000000):
            raise PreclaimProofError("effect_unreserved")
    dispatch = os.path.join(state, "coordinator-preclaim-effect-" + generation + "-" + effect + ".json")
    receipt = {"requestId": request_id, "revision": revision, "generation": generation,
               "planSha256": digest, "effect": effect, "executor": plan["executor"]}
    preclaim_write_once(dispatch, dict(receipt, attemptMonotonicNs=preclaim_boot_nanoseconds()))
    verify()
    token = (ctypes.c_uint32 * 8)(*plan["executor"]["auditToken"])
    requested_signal = signal.SIGTERM if effect == "terminate" else signal.SIGKILL
    result = library.proc_signal_with_audittoken(ctypes.byref(token), requested_signal)
    if result != 0:
        # ESRCH does not prove that the full recovery completed.
        raise PreclaimProofError("effect_outcome_uncertain")
    preclaim_write_once(dispatch[:-5] + "-sent.json", dict(receipt, sentMonotonicNs=preclaim_boot_nanoseconds()))


def claimed_review(state, request_id, revision, generation, digest, stage):
    journal = private_document(os.path.join(state, "coordinator-claimed-reviews.json"))
    matches = [item for item in journal["requests"] if item["id"] == request_id]
    if journal["version"] != 1 or len(matches) != 1:
        raise PreclaimProofError("review_changed")
    request = matches[0]
    plan = request["plan"]
    original = plan["original"]
    encode_digest = lambda value: hashlib.sha256(json.dumps(value, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
    if (request["revision"] != revision or request["status"] != "approved"
            or not request.get("decisionAt") or request["planSha256"] != digest
            or encode_digest(plan) != digest or request["execution"]["generation"] != generation
            or request["execution"]["stage"] != stage or plan["version"] != 1
            or plan["operation"] != "bootstrap-claimed-recovery"
            or original["status"] != "approved" or not original.get("decisionAt")
            or original["execution"]["stage"] != "claimed"
            or original["execution"].get("rollbackAttemptedAt") is not None
            or original["plan"]["automaticRecovery"] != "restore-compatible"
            or not original["plan"].get("compatibleRecovery")
            or original["planSha256"] != encode_digest(original["plan"])
            or original["plan"]["state"]["directory"] != state
            or request_id == original["id"]):
        raise PreclaimProofError("review_changed")
    fence = private_document(os.path.join(state, "coordinator-claim-fence-" + generation + ".json"))
    fenced = fence["fenced"]
    expected = dict(original, revision=fenced["revision"], execution=dict(original["execution"],
        stage="recovery_required", updatedAt=fenced["execution"]["updatedAt"]))
    if (fence["version"] != 1 or fence["original"] != original or fenced != expected
            or fenced["revision"] == original["revision"]
            or fence["recovery"]["id"] != request_id
            or fence["recovery"]["generation"] != generation
            or fence["recovery"]["planSha256"] != digest):
        raise PreclaimProofError("fence_unproven")
    pending = private_document(os.path.join(state, "coordinator-bootstrap-pending.json"))
    if (pending["version"] != 1
            or [item for item in pending["requests"] if item["id"] == original["id"]] != [fenced]
            or any(item["id"] == original["id"] for item in pending["promotions"])):
        raise PreclaimProofError("fence_unproven")
    try:
        main = private_document(os.path.join(state, "coordinator-bootstrap.json"))
    except FileNotFoundError:
        main = {"version": 1, "requests": []}
    if main["version"] != 1 or any(item["id"] == original["id"] for item in main["requests"]):
        raise PreclaimProofError("fence_unproven")
    return request


def claimed_effect(state, request_id, revision, generation, digest, effect, inspector, inspector_digest):
    """Exact claimed-recovery dispatch, separate from legacy cancellation.

    Node reservations and native send slots use distinct namespaces.

    The runner supplies its immutable inspector and holds descriptor 3. A durable
    exclusive dispatch file consumes this attempt before the audit-token signal.
    A lost result can only be reconciled by observation, never by replay.
    """
    info = private_path(state, directory=True)
    if info.st_mode & 0o077 or effect not in ("terminate", "kill"):
        raise ValueError("Invalid preclaim effect")
    for value in (request_id, revision, generation):
        if str(uuid.UUID(value)) != value:
            raise ValueError("Invalid preclaim identity")
    verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)
    request = claimed_review(state, request_id, revision, generation, digest, "effect_pending")
    plan = request["plan"]
    reservation_file = os.path.join(state, "coordinator-claimed-effect-" + generation + "-" + effect + ".json")
    record = private_document(reservation_file)
    if (record["version"] != 1 or record["effect"] != effect or record["request"] != request
            or not isinstance(record.get("reservedAt"), str)
            or plan["signalPolicy"]["terminate"] != "SIGTERM"
            or type(plan["signalPolicy"]["graceSeconds"]) is not int
            or not 1 <= plan["signalPolicy"]["graceSeconds"] <= 60
            or (effect == "kill" and plan["signalPolicy"]["escalation"] != "SIGKILL")
            or len({plan["executor"]["identity"]["pid"], plan["hostProcess"]["pid"], plan["coordinatorProcess"]["pid"]}) != 3):
        raise PreclaimProofError("effect_unreserved")
    if effect == "kill":
        termination = private_document(os.path.join(state, "coordinator-claimed-effect-" + generation + "-terminate.json"))
        if termination["version"] != 1 or termination["effect"] != "terminate" or termination["request"] != request:
            raise PreclaimProofError("effect_unreserved")
    scope = {"__name__": "preclaim_native_inspector"}
    exec(compile(preclaim_protected_bytes(inspector, inspector_digest), inspector, "exec"), scope)
    def inspect(*args):
        try:
            return scope["inspect"](*args)
        except scope["InspectionError"]:
            raise PreclaimProofError("process_changed")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    library.proc_listchildpids.restype = ctypes.c_int
    library.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
    library.proc_signal_with_audittoken.restype = ctypes.c_int

    def verify():
        verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)
        if claimed_review(state, request_id, revision, generation, digest, "effect_pending") != request:
            raise PreclaimProofError("review_changed")
        lock = plan["executionLock"]
        if lock["path"] != os.path.join(state, "coordinator-bootstrap-execution.lock"):
            raise PreclaimProofError("execution_lock_changed")
        selected = private_path(lock["path"])
        if str(selected.st_dev) != lock["device"] or str(selected.st_ino) != lock["inode"]:
            raise PreclaimProofError("execution_lock_changed")
        for key in ("selectedLauncher", "selectedConfiguration", "setup", "executorEntrypoint"):
            preclaim_protected_bytes(plan[key]["path"], plan[key]["sha256"])
        original = plan["original"]
        retained_file = plan["retainedObservation"]
        retained = json.loads(preclaim_protected_bytes(retained_file["path"], retained_file["sha256"]))
        binding = dict({key: original[key] for key in ("id", "revision", "planSha256")}, generation=original["execution"]["generation"])
        if (retained.get("version") != 1 or retained.get("provenance") != "observed-after-claim"
                or retained["claim"] != binding or retained["dispatchApprovalRevision"] != plan["dispatchApprovalRevision"]
                or retained["setup"] != plan["setup"] or retained["inspector"] != {"path": inspector, "sha256": inspector_digest}
                or retained["executor"] != plan["executor"] or retained["host"] != plan["hostProcess"]
                or retained["coordinator"] != plan["coordinatorProcess"] or retained["executionLock"] != plan["executionLock"]):
            raise PreclaimProofError("process_changed")
        setup = json.loads(preclaim_protected_bytes(plan["setup"]["path"], plan["setup"]["sha256"]))
        if (setup["node"] != plan["runner"]["node"] or setup["entrypoint"] != plan["executorEntrypoint"]
                or setup["renewal"]["hostProcess"] != plan["hostProcess"]
                or setup["renewal"]["request"] != {"id": original["id"], "revision": plan["dispatchApprovalRevision"], "planSha256": original["planSha256"]}):
            raise PreclaimProofError("process_changed")
        if inspect(plan["coordinatorProcess"]["pid"]) != plan["coordinatorProcess"]:
            raise PreclaimProofError("process_changed")
        observed = inspect(plan["executor"]["identity"]["pid"], "--audit-token")
        expected = plan["executor"]
        if observed["identity"]["parentPid"] == 1 and expected["identity"]["parentPid"] != 1:
            retained_file = plan["retainedObservation"]
            retained = json.loads(preclaim_protected_bytes(retained_file["path"], retained_file["sha256"]))
            original = plan["original"]
            binding = dict({key: original[key] for key in ("id", "revision", "planSha256")}, generation=original["execution"]["generation"])
            if (retained.get("provenance") != "observed-after-claim" or retained["claim"] != binding
                    or retained["dispatchApprovalRevision"] != plan["dispatchApprovalRevision"] or retained["executor"] != expected
                    or retained["host"] != plan["hostProcess"]
                    or retained["coordinator"] != plan["coordinatorProcess"]):
                raise PreclaimProofError("process_changed")
            inspect(plan["hostProcess"]["pid"], "--require-exited")
            expected = dict(expected, identity=dict(expected["identity"], parentPid=1))
        elif inspect(plan["hostProcess"]["pid"]) != plan["hostProcess"]:
            raise PreclaimProofError("process_changed")
        if observed != expected:
            raise PreclaimProofError("process_changed")
        pid = observed["identity"]["pid"]
        # The fixed managed launcher starts a detached session. Refuse a target
        # that no longer owns that group, or any extra member including orphans.
        if os.getpgid(pid) != pid or os.getsid(pid) != pid or preclaim_group_members(pid) != [pid]:
            raise PreclaimProofError("children_unproven")
        children = (ctypes.c_int * 65536)()
        ctypes.set_errno(0)
        count = library.proc_listchildpids(observed["identity"]["pid"], children, ctypes.sizeof(children))
        if count != 0 or ctypes.get_errno() != 0:
            raise PreclaimProofError("children_unproven")
        if inspect(observed["identity"]["pid"], "--audit-token") != expected:
            raise PreclaimProofError("process_changed")
        if private_document(reservation_file) != record:
            raise PreclaimProofError("effect_unreserved")

    verify()
    if effect == "kill":
        previous = private_document(os.path.join(state, "coordinator-claimed-send-" + generation + "-terminate-sent.json"))
        elapsed = preclaim_boot_nanoseconds() - previous["sentMonotonicNs"]
        if (previous["requestId"] != request_id or previous["revision"] != revision
                or previous["generation"] != generation or previous["planSha256"] != digest
                or previous["effect"] != "terminate" or previous["executor"] != plan["executor"]
                or type(previous["sentMonotonicNs"]) is not int
                or previous["sentMonotonicNs"] <= 0
                or elapsed < plan["signalPolicy"]["graceSeconds"] * 1000000000):
            raise PreclaimProofError("effect_unreserved")
    dispatch = os.path.join(state, "coordinator-claimed-send-" + generation + "-" + effect + ".json")
    receipt = {"requestId": request_id, "revision": revision, "generation": generation,
               "planSha256": digest, "effect": effect, "executor": plan["executor"]}
    preclaim_write_once(dispatch, dict(receipt, attemptMonotonicNs=preclaim_boot_nanoseconds()))
    verify()
    token = (ctypes.c_uint32 * 8)(*plan["executor"]["auditToken"])
    requested_signal = signal.SIGTERM if effect == "terminate" else signal.SIGKILL
    result = library.proc_signal_with_audittoken(ctypes.byref(token), requested_signal)
    if result != 0:
        # ESRCH does not prove that the full recovery completed.
        raise PreclaimProofError("effect_outcome_uncertain")
    preclaim_write_once(dispatch[:-5] + "-sent.json", dict(receipt, sentMonotonicNs=preclaim_boot_nanoseconds()))


def preclaim_launch(setup_file, request_id, revision, digest, generation=None, claimed=False):
    """Launch one exact review under nonblocking, shared recovery exclusion.

    The selected Host writes the protected snapshot. The launch attempt is
    durable before exec and cannot be replayed after an uncertain exec outcome.
    This does not claim cancellation or authorize effects by itself.
    """
    namespace = "claimed" if claimed else "preclaim"
    kind = "bootstrap-" + namespace + "-recovery"
    prefix = "coordinator-" + namespace
    for value in (request_id, revision) + ((generation,) if generation else ()):
        if str(uuid.UUID(value)) != value:
            raise ValueError("Invalid recovery launch identity")
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise ValueError("Invalid recovery launch digest")
    setup = private_document(setup_file)
    state = setup["stateDirectory"]
    if (setup["version"] != 1 or setup["kind"] != kind
            or setup["request"]["id"] != request_id or setup["request"]["planSha256"] != digest
            or (generation is None and setup["request"]["revision"] != revision)
            or setup_file != os.path.join(state, prefix + "-launch-" + request_id + "-" + setup["request"]["revision"] + ".json")
            or private_path(state, directory=True).st_mode & 0o077):
        raise ValueError("Recovery launch setup changed")
    node, entry = setup["node"], setup["entrypoint"]
    if os.path.basename(entry["path"]) != "coordinator-bootstrap-runner.js":
        raise ValueError("Recovery launch entrypoint changed")

    def verify_file(item):
        private_path(item["path"])
        fd = os.open(item["path"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                    or before.st_nlink != 1 or before.st_mode & 0o022):
                raise ValueError("Recovery launch dependency unprotected")
            hashed = hashlib.sha256()
            with os.fdopen(os.dup(fd), "rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    hashed.update(block)
            fields = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_uid, x.st_nlink,
                                x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            if (fields(before) != fields(os.fstat(fd)) or fields(before) != fields(os.lstat(item["path"]))
                    or hashed.hexdigest() != item["sha256"]):
                raise ValueError("Recovery launch dependency changed")
        finally:
            os.close(fd)

    def review():
        journal = private_document(os.path.join(state, prefix + "-reviews.json"))
        matches = [r for r in journal["requests"] if r["id"] == request_id]
        if journal["version"] != 1 or len(matches) != 1:
            raise ValueError("Recovery launch review unavailable")
        request = matches[0]
        actual = hashlib.sha256(json.dumps(request["plan"], ensure_ascii=False,
                              separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
        if (request["revision"] != revision or request["status"] != "approved"
                or not request.get("decisionAt")
                or (generation is None and request.get("execution") is not None)
                or (generation is not None and (request.get("execution") or {}).get("generation") != generation)
                or request["planSha256"] != digest or actual != digest
                or request["plan"]["operation"] != kind
                or request["plan"]["original"]["plan"]["state"]["directory"] != state):
            raise ValueError("Recovery launch review changed")
        if claimed:
            original = request["plan"]["original"]
            reference = {key: original[key] for key in ("id", "revision", "planSha256")}
            if (reference != setup["original"] or original["status"] != "approved"
                    or not original.get("decisionAt") or original["execution"]["stage"] != "claimed"):
                raise ValueError("Claimed recovery target changed")
        return request

    expected = review()
    lock = os.path.join(state, "coordinator-preclaim-execution.lock")
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid()
                or opened.st_nlink != 1 or opened.st_mode & 0o077):
            raise ValueError("Recovery launch lock unprotected")
        # A busy runner is refused, never queued behind an invisible hold.
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verify_owned_descriptor(lock, descriptor)
        verify_file(node)
        verify_file(entry)
        if private_document(setup_file) != setup or review() != expected:
            raise ValueError("Recovery launch changed during validation")
        if generation is None:
            preclaim_write_once(os.path.join(state, prefix + "-attempt-" + request_id + "-" + revision + ".json"),
                                {"version": 1, "request": setup["request"], "setup": setup_file,
                                 "launcherPid": os.getpid(), "attemptId": str(uuid.uuid4())})
        # Cancellation may win after the attempt is retained. Consuming that
        # attempt is intentional; absence of a claim never permits replay.
        if review() != expected:
            raise ValueError("Recovery launch canceled before exec")
        verify_owned_descriptor(lock, descriptor)
        os.set_inheritable(descriptor, True)
        environment = {"PATH": "/usr/bin:/bin", ("VORTEO_CLAIMED_LOCK_FD" if claimed else "VORTEO_PRECLAIM_LOCK_FD"): str(descriptor)}
        os.execve(node["path"], [node["path"], entry["path"], setup_file,
                               namespace + ("-observer" if generation else "-executor"), request_id, revision, digest]
                  + ([generation] if generation else []), environment)
    finally:
        os.close(descriptor)


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
    if sys.platform == "darwin" and len(sys.argv) == 3 and sys.argv[1] == "preclaim-isolated":
        pid = int(sys.argv[2])
        if (pid <= 1 or os.getpgid(pid) != pid or os.getsid(pid) != pid
                or preclaim_group_members(pid) != [pid]):
            raise PreclaimProofError("children_unproven")
        return
    if sys.platform == "darwin" and len(sys.argv) == 7 and sys.argv[1] == "claimed-observe":
        preclaim_launch(*sys.argv[2:], claimed=True)
        return
    if sys.platform == "darwin" and len(sys.argv) == 6 and sys.argv[1] == "claimed-launch":
        preclaim_launch(*sys.argv[2:], claimed=True)
        return
    if sys.platform == "darwin" and len(sys.argv) == 7 and sys.argv[1] == "preclaim-observe":
        preclaim_launch(*sys.argv[2:])
        return
    if sys.platform == "darwin" and len(sys.argv) == 6 and sys.argv[1] == "preclaim-launch":
        preclaim_launch(*sys.argv[2:])
        return
    if sys.platform == "darwin" and len(sys.argv) == 3 and sys.argv[1] == "preclaim-owned":
        state = sys.argv[2]
        if private_path(state, directory=True).st_mode & 0o077:
            raise ValueError("Preclaim state must be private")
        verify_owned_descriptor(os.path.join(state, "coordinator-preclaim-execution.lock"), 3)
        return
    if sys.platform == "darwin" and len(sys.argv) == 10 and sys.argv[1] == "claimed-effect":
        claimed_effect(*sys.argv[2:])
        return
    if sys.platform == "darwin" and len(sys.argv) == 10 and sys.argv[1] == "preclaim-effect":
        preclaim_effect(*sys.argv[2:])
        return
    if sys.platform == "darwin" and len(sys.argv) == 7 and sys.argv[1] == "claimed-verify":
        preclaim_terminal_ownership(*sys.argv[2:], claimed=True)
        return
    if sys.platform == "darwin" and len(sys.argv) == 7 and sys.argv[1] == "preclaim-verify":
        preclaim_terminal_ownership(*sys.argv[2:])
        return
    if sys.platform != "darwin" or len(sys.argv) not in (7, 8):
        raise ValueError("Native bootstrap ownership required")
    lock_path, node, entrypoint, setup, role, generation = sys.argv[1:7]
    if role not in ("executor", "watchdog", "boot-watchdog") or str(uuid.UUID(generation)) != generation:
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
    except (OSError, ValueError, KeyError, TypeError) as error:
        if len(sys.argv) > 1 and sys.argv[1] in ("preclaim-verify", "preclaim-effect", "claimed-effect", "claimed-verify"):
            code = error.code if isinstance(error, PreclaimProofError) else "verification_failed"
            print("preclaim:" + code, file=sys.stderr)
        else:
            print("Coordinator bootstrap ownership could not be acquired", file=sys.stderr)
        sys.exit(1)
