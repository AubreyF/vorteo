#!/usr/bin/env python3
"""Read a macOS process identity without returning argv or environment contents."""

import ctypes
import hashlib
import json
import os
import struct
import sys


class InspectionError(Exception):
    pass


class BsdInfo(ctypes.Structure):
    # Layout from the macOS SDK sys/proc_info.h, struct proc_bsdinfo.
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
        "ruid", "rgid", "svuid", "svgid", "reserved",
    )] + [
        ("comm", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
    ] + [(name, ctypes.c_uint32) for name in (
        "nfiles", "pgid", "jobc", "tdev", "tpgid",
    )] + [
        ("nice", ctypes.c_int32),
        ("start_seconds", ctypes.c_uint64),
        ("start_microseconds", ctypes.c_uint64),
    ]


def arguments_digest(data):
    if len(data) < 5:
        raise InspectionError("Process arguments are incomplete")
    count = struct.unpack_from("=i", data)[0]
    if count < 1 or count > 65536:
        raise InspectionError("Process argument count is invalid")
    position = data.find(b"\0", 4)
    if position < 0:
        raise InspectionError("Process executable field is incomplete")
    while position < len(data) and data[position] == 0:
        position += 1
    arguments = []
    for _ in range(count):
        end = data.find(b"\0", position)
        if end < 0:
            raise InspectionError("Process arguments are incomplete")
        arguments.append(data[position:end].decode("utf-8", errors="strict"))
        position = end + 1
    encoded = json.dumps(arguments, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def inspect(pid, require_stopped=False):
    if sys.platform != "darwin" or pid <= 0:
        raise InspectionError("Native macOS process inspection required")
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    library.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    library.proc_pidinfo.restype = ctypes.c_int
    library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    library.proc_pidpath.restype = ctypes.c_int
    library.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    library.sysctlbyname.restype = ctypes.c_int
    library.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    library.sysctl.restype = ctypes.c_int

    library.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    library.proc_listchildpids.restype = ctypes.c_int

    def read_info():
        result = BsdInfo()
        size = ctypes.sizeof(result)
        if library.proc_pidinfo(pid, 3, 0, ctypes.byref(result), size) != size:
            raise InspectionError("Process identity is unavailable")
        if result.pid != pid or result.uid != os.getuid() or result.ruid != os.getuid():
            raise InspectionError("Process owner does not match Host")
        if require_stopped and result.status != 4:  # SSTOP, sys/proc.h
            raise InspectionError("Process is not stopped")
        return (result.pid, result.ppid, result.uid, result.start_seconds, result.start_microseconds)

    def named(name, capacity):
        result = ctypes.create_string_buffer(capacity)
        size = ctypes.c_size_t(capacity)
        if library.sysctlbyname(name, result, ctypes.byref(size), None, 0) != 0:
            raise InspectionError("Kernel identity is unavailable")
        return result.raw[:size.value]

    before = read_info()
    boot = named(b"kern.bootsessionuuid", 128).rstrip(b"\0").decode("ascii")
    argmax = struct.unpack("=i", named(b"kern.argmax", 4))[0]
    if argmax < 1 or argmax > 16 * 1024 * 1024:
        raise InspectionError("Kernel argument bound is invalid")
    def read_arguments():
        arguments = ctypes.create_string_buffer(argmax)
        size = ctypes.c_size_t(argmax)
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        if library.sysctl(mib, 3, arguments, ctypes.byref(size), None, 0) != 0:
            raise InspectionError("Process arguments are unavailable")
        return arguments_digest(arguments.raw[:size.value])

    def read_executable():
        executable = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(pid, executable, len(executable)) <= 0:
            raise InspectionError("Process executable is unavailable")
        return executable.value.decode("utf-8", errors="strict")

    def read_children():
        # A stopped parent cannot fork. Refuse a full bounded buffer rather
        # than treating a possibly truncated inventory as complete. libproc
        # returns a PID count for this convenience API, not a byte count.
        capacity = 65536
        children = (ctypes.c_int * capacity)()
        ctypes.set_errno(0)
        count = library.proc_listchildpids(pid, children, ctypes.sizeof(children))
        if count < 0 or count >= capacity or ctypes.get_errno() != 0:
            raise InspectionError("Process children are unavailable")
        values = list(children[:count])
        if any(value <= 0 for value in values) or len(set(values)) != len(values):
            raise InspectionError("Process children are invalid")
        return sorted(values)

    children = read_children() if require_stopped else None
    digest = read_arguments()
    executable = read_executable()
    # exec can change the executable and argv without changing PID or birth time.
    if read_arguments() != digest or read_executable() != executable or read_info() != before:
        raise InspectionError("Process identity changed during inspection")
    if require_stopped and read_children() != children:
        raise InspectionError("Process children changed during inspection")
    if read_info() != before:
        raise InspectionError("Process identity changed after child inspection")
    result = {
        "pid": pid,
        "parentPid": before[1],
        "uid": before[2],
        "bootId": boot,
        "startIdentity": f"{before[3]}:{before[4]}",
        "argumentsSha256": digest,
        "executable": executable,
    }
    if require_stopped:
        result["stopped"] = True
        result["childPids"] = children
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3) or (len(sys.argv) == 3 and sys.argv[2] != "--require-stopped"):
            raise InspectionError("Expected a process ID and optional stopped inspection")
        print(json.dumps(inspect(int(sys.argv[1]), len(sys.argv) == 3), separators=(",", ":")))
    except (InspectionError, ValueError, OSError):
        # Do not expose command arguments, environment values or raw system errors.
        print("Coordinator process identity could not be verified", file=sys.stderr)
        sys.exit(1)
