import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
// Reuse the accepted source-schema seam without rebuilding shared declarations.
vi.mock(
  "@getpaseo/protocol/execution-installation",
  () => import("../../../../../protocol/src/execution-installation.js"),
);
import { AuditedProcessObservationSchema } from "../coordinator-bootstrap-process.js";
import type { MaintenanceObservationRuntime } from "../coordinator-bootstrap-maintenance-observation-runtime.js";
import type { NativeBootstrapServiceReader } from "../coordinator-bootstrap-service.js";
import { DEV_REGISTRATION_GATE_PREFIX } from "./dev-registration-provisioner.js";
import {
  createDevRegistrationNativeExecutor,
  type DevRegistrationNativeExecutorInput,
  type DevRegistrationNativeExecutorPorts,
} from "./dev-registration-native-executor.js";

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
function fixture() {
  const uid = process.getuid!();
  const childPid = process.pid + 1000;
  const script = DEV_REGISTRATION_GATE_PREFIX + "throw Error('inert reviewed body');\n";
  const pin = (path: string, text = path) => ({ path, sha256: hash(text) });
  const admission = {
    configurationFile: "/host/config.json",
    launcherFile: "/host/launcher.plist",
    docker: "/host/docker",
    socket: "/host/docker.sock",
    containerId: "a".repeat(64),
    helperPath: "/host/inspect.py",
    helperSha256: hash("reviewed helper"),
  };
  const calls: string[] = [];
  let clock = 0;
  let nativeHook = (_pid: number) => {};
  let runtimeHook = () => {};
  let filesHook = () => {};
  let artifactHook = () => {};
  let mounts = ["/guest-writable"];
  const release = {
    directory: "/host/release",
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    node: pin("/host/node"),
    entrypoint: pin("/host/release/main.js"),
    configuration: pin(admission.configurationFile),
    launcher: pin(admission.launcherFile),
  };
  const processIdentity = (pid: number, parentPid: number, argv: string) =>
    AuditedProcessObservationSchema.parse({
      identity: {
        pid,
        parentPid,
        uid,
        bootId: "11111111-1111-4111-8111-111111111111",
        startIdentity: "123:456",
        argumentsSha256: argv,
        executable: release.node.path,
      },
      auditToken: [0, uid, 0, 0, 0, pid, 0, 7],
    });
  const controller = processIdentity(process.pid, process.ppid, hash("actual controller argv"));
  const child = processIdentity(
    childPid,
    process.pid,
    hash(JSON.stringify([release.node.path, "--input-type=module", "--eval", script])),
  );
  const observations = new Map([
    [process.pid, controller],
    [childPid, child],
  ]);
  function read(pid: number) {
    const observed = observations.get(pid);
    if (!observed) throw Error("Native observation unavailable");
    return observed;
  }
  async function unused(): Promise<never> {
    throw Error("Not part of this factory");
  }
  const reader: NativeBootstrapServiceReader = {
    inspectAuditedProcess: async (pid) => {
      calls.push(`async:${pid}`);
      return read(pid);
    },
    inspectAuditedProcessSync: (pid) => {
      calls.push(`sync:${pid}`);
      nativeHook(pid);
      return read(pid);
    },
    readService: unused,
    inspectProcess: unused,
    inspectRunningProcess: unused,
    verifyProcessExited: unused,
    verifyServiceAbsent: unused,
    inspectStoppedProcess: unused,
  };
  const admissionBytes = Buffer.from(JSON.stringify(admission));
  const runtime: MaintenanceObservationRuntime = {
    installationRoot: "/host",
    stateDirectory: "/host/state",
    account: { uid, home: "/host/home" },
    nativeAdmission: { path: "/host/admission.json", sha256: hash(admissionBytes) },
    admission,
    writableMountRoots: [...mounts],
    ports: { reader, assertCurrent() {} },
    assertCurrent() {
      calls.push("runtime");
      runtimeHook();
    },
  };
  const input: DevRegistrationNativeExecutorInput = {
    runtime,
    hostRelease: release,
    script: pin("/host/registration.mjs", script),
    hostInspector: { path: admission.helperPath, sha256: admission.helperSha256 },
  };
  const documents = new Map([
    [runtime.nativeAdmission.path, admissionBytes],
    [input.script.path, Buffer.from(script)],
    [input.hostInspector.path, Buffer.from("reviewed helper")],
  ]);
  const ports: DevRegistrationNativeExecutorPorts = {
    inspectRelease: async (actual, roots) => {
      calls.push("complete-release");
      expect(actual).toEqual(release);
      expect(roots).toEqual(mounts);
      return {
        assertCurrent() {
          calls.push("artifact");
          artifactHook();
        },
      };
    },
    readFile: async (file) => {
      calls.push(`read:${file.path}`);
      const bytes = documents.get(file.path);
      if (!bytes || hash(bytes) !== file.sha256) throw Error("Pinned document changed");
      return Buffer.from(bytes);
    },
    readDocument: async () =>
      Buffer.from(JSON.stringify({ admissionSetupFile: runtime.nativeAdmission.path })),
    protect: async () => {
      calls.push("protect");
    },
    mountRoots: async () => {
      calls.push("mounts");
      return [...mounts];
    },
    retainFiles: () => () => {
      calls.push("files");
      filesHook();
    },
    now: () => clock,
  };
  return {
    input,
    ports,
    reader,
    calls,
    controller,
    child,
    childPid,
    documents,
    clock: (value: number) => {
      clock = value;
    },
    onNative: (hook: typeof nativeHook) => {
      nativeHook = hook;
    },
    onRuntime: (hook: typeof runtimeHook) => {
      runtimeHook = hook;
    },
    onFiles: (hook: typeof filesHook) => {
      filesHook = hook;
    },
    onArtifact: (hook: typeof artifactHook) => {
      artifactHook = hook;
    },
    mounts: (value: string[]) => {
      mounts = value;
    },
  };
}

test("supplies exactly Host proof and actual-child attestation, with no effects", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  expect(Object.keys(result).sort()).toEqual(["attestChild", "gatedHostProof"]);
  expect(result.gatedHostProof.node).toEqual(f.input.hostRelease.node);
  expect(f.calls.indexOf("protect")).toBeLessThan(f.calls.findIndex((c) => c.startsWith("read:")));
  expect(f.calls).toContain("complete-release");
  const child = await result.attestChild(f.childPid);
  expect(child.executor).toEqual({
    ...f.child.identity,
    auditToken: f.child.auditToken,
    executable: f.input.hostRelease.node,
    entrypoint: f.input.script,
    artifactSha256: f.input.hostRelease.artifactSha256,
  });
  const before = f.calls.length;
  child.assertCurrent();
  expect(f.calls.slice(before).filter((c) => c.startsWith("sync:"))).toEqual([
    `sync:${process.pid}`,
    `sync:${f.childPid}`,
  ]);
  expect(f.calls.filter((c) => c === "mounts")).toHaveLength(3);
});

test("refuses an old reader before any file or native read", async () => {
  const f = fixture();
  delete f.reader.inspectAuditedProcessSync;
  await expect(createDevRegistrationNativeExecutor(f.input, f.ports)).rejects.toThrow(
    "Synchronous",
  );
  expect(f.calls).toEqual([]);
});

for (const field of ["helper path", "helper hash", "configuration", "account"]) {
  test(`refuses mismatched ${field} before reads`, async () => {
    const f = fixture();
    if (field === "helper path") f.input.hostInspector.path = "/other/helper";
    if (field === "helper hash") f.input.hostInspector.sha256 = "0".repeat(64);
    if (field === "configuration") f.input.hostRelease.configuration.path = "/other/config";
    if (field === "account") f.input.runtime.account.uid += 1;
    await expect(createDevRegistrationNativeExecutor(f.input, f.ports)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
}
for (const field of ["pid", "parentPid", "uid", "executable", "audit pid", "audit uid"]) {
  test(`independently checks actual controller ${field}`, async () => {
    const f = fixture();
    if (field === "pid") f.controller.identity.pid += 1;
    if (field === "parentPid") f.controller.identity.parentPid += 1;
    if (field === "uid") f.controller.identity.uid += 1;
    if (field === "executable") f.controller.identity.executable = "/linux/candidate/node";
    if (field === "audit pid") f.controller.auditToken[5] += 1;
    if (field === "audit uid") f.controller.auditToken[1] += 1;
    await expect(createDevRegistrationNativeExecutor(f.input, f.ports)).rejects.toThrow(
      "controller",
    );
  });
}
for (const field of [
  "pid",
  "parentPid",
  "uid",
  "bootId",
  "executable",
  "argumentsSha256",
  "audit pid",
  "audit uid",
]) {
  test(`refuses child ${field} substitution`, async () => {
    const f = fixture();
    const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
    if (field === "pid") f.child.identity.pid += 1;
    if (field === "parentPid") f.child.identity.parentPid += 1;
    if (field === "uid") f.child.identity.uid += 1;
    if (field === "bootId") f.child.identity.bootId = "22222222-2222-4222-8222-222222222222";
    if (field === "executable") f.child.identity.executable = "/linux/node";
    if (field === "argumentsSha256")
      f.child.identity.argumentsSha256 = hash("different body or argv");
    if (field === "audit pid") f.child.auditToken[5] += 1;
    if (field === "audit uid") f.child.auditToken[1] += 1;
    await expect(result.attestChild(f.childPid)).rejects.toThrow("child");
  });
}
for (const field of ["birth", "boot", "argv", "parent", "audit version"]) {
  test(`synchronous recheck retains exact child ${field}`, async () => {
    const f = fixture();
    const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
    const proof = await result.attestChild(f.childPid);
    if (field === "birth") f.child.identity.startIdentity = "124:1";
    if (field === "boot") f.child.identity.bootId = "22222222-2222-4222-8222-222222222222";
    if (field === "argv") f.child.identity.argumentsSha256 = hash("other");
    if (field === "parent") f.child.identity.parentPid += 1;
    if (field === "audit version") f.child.auditToken[7] += 1;
    expect(() => proof.assertCurrent()).toThrow("lifetime changed");
  });
}

test("does not retain mutable reader-owned observations as authority", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.controller.identity.startIdentity = "124:1";
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("lifetime changed");
});

test("refuses native errors without treating them as exit or absence", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() => {
    throw Error("native denied");
  });
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("native denied");
});

for (const source of ["runtime", "files", "artifact", "native"]) {
  test(`rechecks immutable input after ${source} callback`, async () => {
    const f = fixture();
    const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
    const change = () => {
      f.input.script.sha256 = "d".repeat(64);
    };
    if (source === "runtime") f.onRuntime(change);
    if (source === "files") f.onFiles(change);
    if (source === "artifact") f.onArtifact(change);
    if (source === "native") f.onNative(change);
    expect(() => result.gatedHostProof.assertCurrent()).toThrow("inputs or callbacks changed");
  });
}

test("rejects replacement of retained native method", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.reader.inspectAuditedProcessSync = () => f.controller;
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("callbacks changed");
});

test("checks mount expiry after a native call", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() => f.clock(30_000));
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("expired");
});

test("caps total synchronous work and never starts an unbudgeted next read", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  const proof = await result.attestChild(f.childPid);
  f.onNative(() => f.clock(12_001));
  const before = f.calls.length;
  expect(() => proof.assertCurrent()).toThrow("budget exhausted");
  expect(f.calls.slice(before).filter((c) => c.startsWith("sync:"))).toHaveLength(1);
});

test("refuses over-budget last native return", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() => f.clock(22_000));
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("total budget");
});

test("requires unchanged fresh mount roots at actual child attestation", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.mounts(["/host"]);
  await expect(result.attestChild(f.childPid)).rejects.toThrow("mounts changed");
});

test("rejects published proof mutation after native callbacks", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  const proof = await result.attestChild(f.childPid);
  f.onNative(() => {
    proof.executor.auditToken[7] += 1;
  });
  expect(() => proof.assertCurrent()).toThrow("snapshot changed");
});

test("checks Host proof mutation after native callbacks", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() => {
    result.gatedHostProof.node.sha256 = "d".repeat(64);
  });
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("snapshot changed");
});

for (const failure of ["anchor", "admission", "script", "gate", "release", "protection"]) {
  test(`refuses ${failure} custody failure before native inspection`, async () => {
    const f = fixture();
    if (failure === "anchor")
      f.ports.readDocument = async () => Buffer.from('{"admissionSetupFile":"/other"}');
    if (failure === "admission")
      f.documents.set(f.input.runtime.nativeAdmission.path, Buffer.from("{}"));
    if (failure === "script") f.documents.set(f.input.script.path, Buffer.from("changed"));
    if (failure === "gate") {
      const bytes = Buffer.from("ungated reviewed script");
      f.input.script.sha256 = hash(bytes);
      f.documents.set(f.input.script.path, bytes);
    }
    if (failure === "release")
      f.ports.inspectRelease = async () => {
        throw Error("bad complete artifact");
      };
    if (failure === "protection")
      f.ports.protect = async () => {
        throw Error("guest mount overlap");
      };
    await expect(createDevRegistrationNativeExecutor(f.input, f.ports)).rejects.toThrow();
    expect(f.calls.some((c) => c.startsWith("async:") || c.startsWith("sync:"))).toBe(false);
  });
}

for (const pid of [0, -1, Number.NaN, process.pid]) {
  test(`refuses invalid actual child PID ${pid}`, async () => {
    const f = fixture();
    const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
    const before = f.calls.length;
    await expect(result.attestChild(pid)).rejects.toThrow("Actual gated child PID");
    expect(f.calls.length).toBe(before);
  });
}

test("rechecks retained file custody after native collection", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() =>
    f.onFiles(() => {
      throw Error("retained inode changed");
    }),
  );
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("retained inode changed");
});

test("rechecks complete release custody after native collection", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.onNative(() =>
    f.onArtifact(() => {
      throw Error("release changed");
    }),
  );
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("release changed");
});

test("rejects runtime replacement instead of silently using a different anchor", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.input.runtime = { ...f.input.runtime };
  expect(() => result.gatedHostProof.assertCurrent()).toThrow("inputs or callbacks changed");
});

test("retains original trusted port callbacks", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  f.ports.now = () => {
    throw Error("replacement clock");
  };
  expect(() => result.gatedHostProof.assertCurrent()).not.toThrow();
});

test("never passes its private release snapshot to artifact callbacks", async () => {
  const f = fixture();
  const original = f.ports.inspectRelease;
  f.ports.inspectRelease = async (release, roots, limits) => {
    const result = await original(release, roots, limits);
    release.node.path = "/injected/linux-node";
    return result;
  };
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  expect(result.gatedHostProof.node.path).toBe("/host/node");
});

test("the final synchronous assertion contains no mount refresh or async reader call", async () => {
  const f = fixture();
  const result = await createDevRegistrationNativeExecutor(f.input, f.ports);
  const proof = await result.attestChild(f.childPid);
  const before = f.calls.length;
  expect(proof.assertCurrent()).toBeUndefined();
  expect(f.calls.slice(before).some((c) => c === "mounts" || c.startsWith("async:"))).toBe(false);
});
