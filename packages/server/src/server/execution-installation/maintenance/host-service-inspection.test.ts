import { requireMaintenanceServiceAbsenceResult } from "../coordinator-bootstrap-maintenance-absence.js";
import { expect, test, vi } from "vitest";
import {
  createEnrolledHostServiceInspection,
  type HostServiceInspectionCommands,
} from "./host-service-inspection.js";

function fixture() {
  const uid = process.getuid!();
  const identity = {
    version: 1 as const,
    environment: "host" as const,
    target: "host" as const,
    installationId: "10d1e327-afc5-42da-8bc9-7fa54471adcd",
    custodyOwnerUid: uid,
    installationRoot: "/protected/installation",
    stateDirectory: "/protected/host",
    serviceDomain: `gui/${uid}`,
    serviceLabel: "local.vorteo.10d1e327-afc5-42da-8bc9-7fa54471adcd.host",
    launcherPath: "/protected/host.plist",
    selectionPath: "/protected/current",
  };
  const reader = {
    inspectProcess: vi.fn(async (_pid: number): Promise<unknown> => ({ native: "observed" })),
    verifyProcessExited: vi.fn(async (_pid: number) => undefined),
  };
  const stderr = `Bad request.\nCould not find service "${identity.serviceLabel}" in domain for user gui: ${uid}\n`;
  const command = {
    run: vi.fn<HostServiceInspectionCommands["run"]>(async () => {
      throw { code: 113, signal: null, stderr };
    }),
    runSync: vi.fn<HostServiceInspectionCommands["runSync"]>(() => {
      throw { status: 113, signal: null, stderr };
    }),
    now: vi.fn(() => 0),
  };
  return {
    identity,
    reader,
    command,
    stderr,
    service: `${identity.serviceDomain}/${identity.serviceLabel}`,
  };
}

test("Host service absence accepts its exact enrolled .host label without native effects", async () => {
  const f = fixture();
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await inspection.reader.verifyServiceAbsent(f.service);
  inspection.assertServiceAbsent();
  expect(f.command.run).toHaveBeenCalledWith("/bin/launchctl", ["print", f.service], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  expect(f.command.runSync).toHaveBeenCalledWith("/bin/launchctl", ["print", f.service], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 2000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  });
  expect(f.reader.inspectProcess).not.toHaveBeenCalled();
});

test.each([
  { target: "coordinator" },
  { environment: "container" },
  { custodyOwnerUid: process.getuid!() + 1 },
  { serviceDomain: `gui/${process.getuid!() + 1}` },
  { serviceDomain: "system" },
  { serviceLabel: "unrelated.host" },
])("Host service absence rejects unrelated identity %j before reads", (changed) => {
  const f = fixture();
  expect(() =>
    createEnrolledHostServiceInspection(
      { ...f, identity: { ...f.identity, ...changed } },
      f.command,
    ),
  ).toThrow();
  expect(f.command.run).not.toHaveBeenCalled();
  expect(f.command.runSync).not.toHaveBeenCalled();
});

test("Host service absence rejects a different service before reading it", async () => {
  const f = fixture();
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.verifyServiceAbsent(f.service + ".different")).rejects.toThrow(
    "differs",
  );
  expect(f.command.run).not.toHaveBeenCalled();
});

test.each(["async", "sync"] as const)(
  "Host service absence refuses a successful %s print",
  async (mode) => {
    const f = fixture();
    f.command.run.mockResolvedValue({ stdout: "registered" });
    f.command.runSync.mockReturnValue("registered");
    const inspection = createEnrolledHostServiceInspection(f, f.command);
    if (mode === "async")
      await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow("registered");
    else expect(() => inspection.assertServiceAbsent()).toThrow("registered");
  },
);

test.each([
  ["wrong status", { code: 1, status: 1 }],
  ["string status", { code: "113", status: "113" }],
  ["signal", { signal: "SIGTERM" }],
  ["killed", { killed: true }],
  ["output", { stdout: "unexpected" }],
  ["permission", { stderr: "Permission denied" }],
  [
    "wrong label",
    { stderr: 'Bad request.\nCould not find service "another" in domain for user gui: 0' },
  ],
  ["missing result", { code: undefined, status: undefined }],
])("Host service absence refuses %s in both native result forms", async (_kind, changed) => {
  const f = fixture();
  f.command.run.mockRejectedValue({ code: 113, signal: null, stderr: f.stderr, ...changed });
  f.command.runSync.mockImplementation(() => {
    throw { status: 113, signal: null, stderr: f.stderr, ...changed };
  });
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow("unproven");
  expect(() => inspection.assertServiceAbsent()).toThrow("unproven");
});

test("Host service absence does not interchange async code and sync status", async () => {
  const f = fixture();
  f.command.run.mockRejectedValue({ status: 113, stderr: f.stderr });
  f.command.runSync.mockImplementation(() => {
    throw { code: 113, stderr: f.stderr };
  });
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow("unproven");
  expect(() => inspection.assertServiceAbsent()).toThrow("unproven");
});

test.each(["async", "sync"] as const)(
  "Host service absence checks %s deadline after return",
  async (mode) => {
    const f = fixture();
    let time = 0;
    f.command.now.mockImplementation(() => time);
    f.command.run.mockImplementation(async () => {
      time = 2000;
      throw { code: 113, stderr: f.stderr };
    });
    f.command.runSync.mockImplementation(() => {
      time = 2000;
      throw { status: 113, stderr: f.stderr };
    });
    const inspection = createEnrolledHostServiceInspection(f, f.command);
    if (mode === "async")
      await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow("deadline");
    else expect(() => inspection.assertServiceAbsent()).toThrow("deadline");
  },
);

test("Host service absence retains identity and command callbacks across an await", async () => {
  const f = fixture();
  f.command.run.mockImplementation(async () => {
    f.identity.serviceLabel += ".changed";
    throw { code: 113, stderr: f.stderr };
  });
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow("custody changed");
});

test("Host service absence refuses a synchronous callback substitution", () => {
  const f = fixture();
  f.command.runSync.mockImplementation(() => {
    f.command.now = vi.fn(() => 0);
    throw { status: 113, stderr: f.stderr };
  });
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  expect(() => inspection.assertServiceAbsent()).toThrow("custody changed");
});

test("Host service inspection forwards captured process readers with original receiver", async () => {
  const f = fixture();
  const seen: unknown[] = [];
  f.reader.inspectProcess = vi.fn(async function (this: typeof f.reader, pid: number) {
    seen.push(this, pid);
    return { native: "observed" };
  });
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.inspectProcess(42)).resolves.toEqual({ native: "observed" });
  await inspection.reader.verifyProcessExited(42);
  expect(seen).toEqual([f.reader, 42]);
  expect(f.reader.verifyProcessExited).toHaveBeenCalledWith(42);
  f.reader.verifyProcessExited = vi.fn(async () => undefined);
  await expect(inspection.reader.verifyProcessExited(42)).rejects.toThrow("custody changed");
  expect(f.command.run).not.toHaveBeenCalled();
});

test("Host service adapter leaves the existing maintenance label boundary strict", async () => {
  const f = fixture();
  expect(() =>
    requireMaintenanceServiceAbsenceResult(f.service, {
      status: 113,
      signal: null,
      stderr: f.stderr,
    }),
  ).toThrow("user custody");
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  await expect(inspection.reader.verifyServiceAbsent(f.service)).resolves.toBeUndefined();
});

test("Host service absence rechecks the calling account before reading", async () => {
  const f = fixture();
  const inspection = createEnrolledHostServiceInspection(f, f.command);
  const uid = vi.spyOn(process, "getuid").mockReturnValue(f.identity.custodyOwnerUid + 1);
  try {
    await expect(inspection.reader.verifyServiceAbsent(f.service)).rejects.toThrow(
      "custody changed",
    );
    expect(() => inspection.assertServiceAbsent()).toThrow("custody changed");
    expect(f.command.run).not.toHaveBeenCalled();
    expect(f.command.runSync).not.toHaveBeenCalled();
  } finally {
    uid.mockRestore();
  }
});
