import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import {
  createSystemdBootstrapServiceReader,
  assertPrivateRuntimeDirectory,
  isStoppedSystemdCandidate,
  parseSystemdServiceRecord,
  SystemdCommandFailure,
  systemdLoadedPid,
  verifySystemdServiceOwnership,
  type LinuxProcessInspector,
  type SystemdCommandRunner,
  type SystemdTool,
} from "./coordinator-bootstrap-systemd.js";

// Captured on Debian 13 (systemd 257) from the reader's exact invocations
// against transient user units; see the Linux Host plan.
const MANAGER_SHOW = "MainPID=675457\nActiveState=active\n";
const OWNER = '{"type":"s","data":[":1.1"]}';
const OWNER_PID = '{"type":"u","data":[675457]}';
const RUNNING_UNIT = "local.vorteo.fixture.installation.service";
const RUNNING_SERVICE = `systemd-user/1000/${RUNNING_UNIT}`;
const RUNNING_PATH =
  "/org/freedesktop/systemd1/unit/local_2evorteo_2efixture_2einstallation_2eservice";
const CONTROL_GROUP = `/user.slice/user-1000.slice/user@1000.service/app.slice/${RUNNING_UNIT}`;
const RUNNING_UNIT_PROPERTIES = [
  `{"type":"s","data":"${RUNNING_UNIT}"}`,
  '{"type":"s","data":"loaded"}',
  '{"type":"s","data":"active"}',
  '{"type":"s","data":"running"}',
  `{"type":"s","data":"/run/user/1000/systemd/transient/${RUNNING_UNIT}"}`,
  '{"type":"as","data":[]}',
  '{"type":"b","data":false}',
];
const RUNNING_SERVICE_PROPERTIES = [
  '{"type":"s","data":"simple"}',
  '{"type":"s","data":"none"}',
  '{"type":"u","data":967738}',
  `{"type":"s","data":"${CONTROL_GROUP}"}`,
  '{"type":"a(sasbttttuii)","data":[["/bin/sleep",["/bin/sleep","300"],false,1792370108090398,2620412885647,0,0,967738,0,0]]}',
];
const STOPPED_UNIT = "local.vorteo.stopped.installation.service";
const STOPPED_SERVICE = `systemd-user/1000/${STOPPED_UNIT}`;
const STOPPED_PATH =
  "/org/freedesktop/systemd1/unit/local_2evorteo_2estopped_2einstallation_2eservice";
const STOPPED_UNIT_PROPERTIES = [
  `{"type":"s","data":"${STOPPED_UNIT}"}`,
  '{"type":"s","data":"loaded"}',
  '{"type":"s","data":"failed"}',
  '{"type":"s","data":"failed"}',
  `{"type":"s","data":"/run/user/1000/systemd/transient/${STOPPED_UNIT}"}`,
  '{"type":"as","data":[]}',
  '{"type":"b","data":false}',
];
const STOPPED_SERVICE_PROPERTIES = [
  '{"type":"s","data":"simple"}',
  '{"type":"s","data":"none"}',
  '{"type":"u","data":0}',
  '{"type":"s","data":""}',
  '{"type":"a(sasbttttuii)","data":[["/bin/false",["/bin/false"],false,1792370108633010,2620413428259,1792370108690983,2620413486232,967751,1,1]]}',
];
const ABSENT_STDERR = `Call failed: Unit ${STOPPED_UNIT} not loaded.\n`;

const BUS = "busctl --user --json=short --no-pager";
const MANAGER = "/org/freedesktop/systemd1 org.freedesktop.systemd1.Manager";
const UNIT = "org.freedesktop.systemd1.Unit";
const SERVICE = "org.freedesktop.systemd1.Service";
const UNIT_NAMES = "Id LoadState ActiveState SubState FragmentPath DropInPaths NeedDaemonReload";
const SERVICE_NAMES = "Type NotifyAccess MainPID ControlGroup ExecStart";

type Response = string | SystemdCommandFailure;

/** Typed in-memory runner: each command line maps to a queue of responses;
 * the last response repeats. An unexpected command fails the test. */
function fixtureRunner(overrides: Record<string, Response[]> = {}): SystemdCommandRunner {
  const responses: Record<string, Response[]> = {
    "systemctl show user@1000.service --property=MainPID --property=ActiveState --no-pager": [
      MANAGER_SHOW,
    ],
    [`${BUS} call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.freedesktop.systemd1`]:
      [OWNER],
    [`${BUS} call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetConnectionUnixProcessID s :1.1`]:
      [OWNER_PID],
    [`${BUS} call :1.1 ${MANAGER} GetUnit s ${RUNNING_UNIT}`]: [
      `{"type":"o","data":["${RUNNING_PATH}"]}`,
    ],
    [`${BUS} get-property :1.1 ${RUNNING_PATH} ${UNIT} ${UNIT_NAMES}`]: [
      RUNNING_UNIT_PROPERTIES.join("\n") + "\n",
    ],
    [`${BUS} get-property :1.1 ${RUNNING_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
      RUNNING_SERVICE_PROPERTIES.join("\n") + "\n",
    ],
    [`${BUS} call :1.1 ${MANAGER} GetUnit s ${STOPPED_UNIT}`]: [
      `{"type":"o","data":["${STOPPED_PATH}"]}`,
    ],
    [`${BUS} get-property :1.1 ${STOPPED_PATH} ${UNIT} ${UNIT_NAMES}`]: [
      STOPPED_UNIT_PROPERTIES.join("\n") + "\n",
    ],
    [`${BUS} get-property :1.1 ${STOPPED_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
      STOPPED_SERVICE_PROPERTIES.join("\n") + "\n",
    ],
    ...overrides,
  };
  return {
    async run(tool: SystemdTool, args: readonly string[]) {
      const key = [tool, ...args].join(" ");
      const queue = responses[key];
      if (!queue) throw new Error(`Unexpected command: ${key}`);
      const response = queue.length > 1 ? queue.shift() : queue[0];
      if (response instanceof SystemdCommandFailure) throw response;
      if (response === undefined) throw new Error(`No response: ${key}`);
      return response;
    },
  };
}

const OBSERVATION = {
  pid: 967738,
  parentPid: 675457,
  uid: 1000,
  bootId: "4f1c2a3b-5d6e-4f70-8a9b-0c1d2e3f4a5b",
  startIdentity: "26204:120000",
  argumentsSha256: createHash("sha256")
    .update(JSON.stringify(["/bin/sleep", "300"]))
    .digest("hex"),
  executable: "/usr/bin/sleep",
};

function fixtureProcesses(cgroup = `0::${CONTROL_GROUP}\n`): LinuxProcessInspector {
  const refuse = () => Promise.reject(new Error("Unexpected process inspection"));
  return {
    inspectProcess: refuse,
    inspectRunningProcess: refuse,
    inspectStoppedProcess: refuse,
    verifyProcessExited: refuse,
    async inspectProcessCgroup(pid) {
      if (pid !== OBSERVATION.pid) throw new Error("Unexpected PID");
      return { observation: OBSERVATION, cgroup };
    },
  };
}

function reader(runner = fixtureRunner(), processes = fixtureProcesses()) {
  return createSystemdBootstrapServiceReader({ uid: 1000, runner, processes });
}

function unitLines(lines: string[], index: number, value: string): string {
  return lines.map((line, at) => (at === index ? value : line)).join("\n") + "\n";
}

describe("systemd service record", () => {
  test("reads a running unit through the pinned user manager", async () => {
    const output = await reader().readService(RUNNING_SERVICE);
    expect(parseSystemdServiceRecord(RUNNING_SERVICE, output)).toEqual({
      version: 1,
      service: RUNNING_SERVICE,
      managerPid: 675457,
      busOwner: ":1.1",
      id: RUNNING_UNIT,
      loadState: "loaded",
      activeState: "active",
      subState: "running",
      fragmentPath: `/run/user/1000/systemd/transient/${RUNNING_UNIT}`,
      dropInPaths: [],
      needDaemonReload: false,
      type: "simple",
      notifyAccess: "none",
      mainPid: 967738,
      controlGroup: CONTROL_GROUP,
      execStart: [{ path: "/bin/sleep", argv: ["/bin/sleep", "300"] }],
    });
    expect(systemdLoadedPid(RUNNING_SERVICE, output)).toBe(967738);
  });

  test("refuses another account's service before reading it", async () => {
    await expect(reader().readService(`systemd-user/1001/${RUNNING_UNIT}`)).rejects.toThrow(
      "another Host account",
    );
    await expect(reader().readService(`gui/1000/local.vorteo.x.installation`)).rejects.toThrow();
  });

  test("refuses a bus name not served by the system manager's user manager", async () => {
    const runner = fixtureRunner({
      [`${BUS} call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetConnectionUnixProcessID s :1.1`]:
        ['{"type":"u","data":[4242]}'],
    });
    await expect(reader(runner).readService(RUNNING_SERVICE)).rejects.toThrow(
      "not served by the user manager",
    );
  });

  test("refuses a manager that changes during the read", async () => {
    const runner = fixtureRunner({
      [`${BUS} call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s org.freedesktop.systemd1`]:
        [OWNER, '{"type":"s","data":[":1.9"]}'],
      [`${BUS} call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetConnectionUnixProcessID s :1.9`]:
        [OWNER_PID],
    });
    await expect(reader(runner).readService(RUNNING_SERVICE)).rejects.toThrow(
      "changed during inspection",
    );
  });

  test("refuses an inactive user manager", async () => {
    const runner = fixtureRunner({
      "systemctl show user@1000.service --property=MainPID --property=ActiveState --no-pager": [
        "MainPID=0\nActiveState=inactive\n",
      ],
    });
    await expect(reader(runner).readService(RUNNING_SERVICE)).rejects.toThrow("unavailable");
  });

  test("refuses incomplete or mistyped properties", async () => {
    const short = fixtureRunner({
      [`${BUS} get-property :1.1 ${RUNNING_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
        RUNNING_SERVICE_PROPERTIES.slice(0, 4).join("\n") + "\n",
      ],
    });
    await expect(reader(short).readService(RUNNING_SERVICE)).rejects.toThrow("incomplete");
    const mistyped = fixtureRunner({
      [`${BUS} get-property :1.1 ${RUNNING_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
        unitLines(RUNNING_SERVICE_PROPERTIES, 2, '{"type":"s","data":"967738"}'),
      ],
    });
    await expect(reader(mistyped).readService(RUNNING_SERVICE)).rejects.toThrow(
      "could not be read",
    );
  });

  test("refuses a record for another unit", async () => {
    const output = await reader().readService(RUNNING_SERVICE);
    expect(() => parseSystemdServiceRecord(STOPPED_SERVICE, output)).toThrow("does not match");
    expect(() => systemdLoadedPid(RUNNING_SERVICE, "not json")).toThrow("does not match");
  });
});

test("reader refusals stay typed when the manager cannot be read", async () => {
  const unavailable = fixtureRunner({
    "systemctl show user@1000.service --property=MainPID --property=ActiveState --no-pager": [
      new SystemdCommandFailure("systemctl", 1, "Failed to connect to bus\n"),
    ],
  });
  for (const [operation, message] of [
    [() => reader(unavailable).readService(RUNNING_SERVICE), "could not be read"],
    [
      () => reader(unavailable).verifyServiceAbsent(STOPPED_SERVICE),
      "absence could not be verified",
    ],
    [
      () => reader(unavailable).verifyServiceOwnership(RUNNING_SERVICE, OBSERVATION.pid),
      "ownership could not be verified",
    ],
  ] as const) {
    const refusal = await operation().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BootstrapRequestConflict);
    expect(String(refusal)).toContain(message);
  }
});

describe("stopped systemd candidate", () => {
  test("binds the loaded command exactly", async () => {
    const output = await reader().readService(STOPPED_SERVICE);
    expect(() => systemdLoadedPid(STOPPED_SERVICE, output)).toThrow("missing");
    expect(
      isStoppedSystemdCandidate({
        service: STOPPED_SERVICE,
        output,
        expectedArguments: ["/bin/false"],
      }),
    ).toBe(true);
    expect(() =>
      isStoppedSystemdCandidate({
        service: STOPPED_SERVICE,
        output,
        expectedArguments: ["/bin/false", "x"],
      }),
    ).toThrow("approved candidate");
  });

  test("distinguishes arguments that systemctl show renders identically", async () => {
    const runner = fixtureRunner({
      [`${BUS} get-property :1.1 ${STOPPED_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
        unitLines(
          STOPPED_SERVICE_PROPERTIES,
          4,
          '{"type":"a(sasbttttuii)","data":[["/bin/sh",["/bin/sh","-c","a b"],false,0,0,0,0,0,0,0]]}',
        ),
      ],
    });
    const output = await reader(runner).readService(STOPPED_SERVICE);
    expect(() =>
      isStoppedSystemdCandidate({
        service: STOPPED_SERVICE,
        output,
        expectedArguments: ["/bin/sh", "-c", "a", "b"],
      }),
    ).toThrow("approved candidate");
  });

  test("refuses drop-ins and pending reloads, and reports a running unit as not stopped", async () => {
    for (const [index, value] of [
      [5, '{"type":"as","data":["/home/x/.config/systemd/user/u.service.d/override.conf"]}'],
      [6, '{"type":"b","data":true}'],
    ] as const) {
      const runner = fixtureRunner({
        [`${BUS} get-property :1.1 ${STOPPED_PATH} ${UNIT} ${UNIT_NAMES}`]: [
          unitLines(STOPPED_UNIT_PROPERTIES, index, value),
        ],
      });
      const output = await reader(runner).readService(STOPPED_SERVICE);
      expect(() =>
        isStoppedSystemdCandidate({
          service: STOPPED_SERVICE,
          output,
          expectedArguments: ["/bin/false"],
        }),
      ).toThrow("approved candidate");
    }
    const running = await reader().readService(RUNNING_SERVICE);
    expect(
      isStoppedSystemdCandidate({
        service: RUNNING_SERVICE,
        output: running,
        expectedArguments: ["/bin/sleep", "300"],
      }),
    ).toBe(false);
  });
});

describe("systemd service absence", () => {
  const lookup = `${BUS} call :1.1 ${MANAGER} GetUnit s ${STOPPED_UNIT}`;

  test("accepts only the exact not-loaded refusal", async () => {
    const absent = fixtureRunner({
      [lookup]: [new SystemdCommandFailure("busctl", 1, ABSENT_STDERR)],
    });
    await expect(reader(absent).verifyServiceAbsent(STOPPED_SERVICE)).resolves.toBeUndefined();
    const other = fixtureRunner({
      [lookup]: [new SystemdCommandFailure("busctl", 1, "Call failed: Access denied\n")],
    });
    await expect(reader(other).verifyServiceAbsent(STOPPED_SERVICE)).rejects.toThrow(
      "could not be verified",
    );
    const timeout = fixtureRunner({
      [lookup]: [new SystemdCommandFailure("busctl", null, ABSENT_STDERR)],
    });
    await expect(reader(timeout).verifyServiceAbsent(STOPPED_SERVICE)).rejects.toThrow(
      "could not be verified",
    );
  });

  test("accepts a lingering not-found object but not a loaded unit", async () => {
    const stub = fixtureRunner({
      [`${BUS} get-property :1.1 ${STOPPED_PATH} ${UNIT} LoadState ActiveState`]: [
        '{"type":"s","data":"not-found"}\n{"type":"s","data":"inactive"}\n',
      ],
    });
    await expect(reader(stub).verifyServiceAbsent(STOPPED_SERVICE)).resolves.toBeUndefined();
    const loaded = fixtureRunner({
      [`${BUS} get-property :1.1 ${STOPPED_PATH} ${UNIT} LoadState ActiveState`]: [
        '{"type":"s","data":"loaded"}\n{"type":"s","data":"failed"}\n',
      ],
    });
    await expect(reader(loaded).verifyServiceAbsent(STOPPED_SERVICE)).rejects.toThrow(
      "still loaded",
    );
  });
});

describe("systemd service ownership", () => {
  async function verify(
    change: { process?: Partial<typeof OBSERVATION>; cgroup?: string; service?: string[] } = {},
  ) {
    const runner = change.service
      ? fixtureRunner({
          [`${BUS} get-property :1.1 ${RUNNING_PATH} ${SERVICE} ${SERVICE_NAMES}`]: [
            change.service.join("\n") + "\n",
          ],
        })
      : fixtureRunner();
    const output = await reader(runner).readService(RUNNING_SERVICE);
    verifySystemdServiceOwnership({
      service: RUNNING_SERVICE,
      output,
      process: { ...OBSERVATION, ...change.process },
      cgroup: change.cgroup ?? `0::${CONTROL_GROUP}\n`,
      hostUid: 1000,
    });
  }

  test("accepts the manager-started main process in the unit cgroup", async () => {
    await expect(verify()).resolves.toBeUndefined();
  });

  test("refuses a process that migrated into the unit cgroup", async () => {
    await expect(verify({ process: { pid: 967800 } })).rejects.toThrow("not owned");
  });

  test("refuses a main process not started by the user manager", async () => {
    await expect(verify({ process: { parentPid: 1 } })).rejects.toThrow("not owned");
  });

  test("refuses a same-uid container process", async () => {
    await expect(
      verify({ cgroup: "0::/system.slice/docker-0123456789abcdef.scope\n" }),
    ).rejects.toThrow("not owned");
  });

  test("refuses a unit cgroup outside the account's user manager", async () => {
    const outside = unitLines(
      RUNNING_SERVICE_PROPERTIES,
      3,
      `{"type":"s","data":"/system.slice/${RUNNING_UNIT}"}`,
    ).trimEnd();
    await expect(
      verify({ service: outside.split("\n"), cgroup: `0::/system.slice/${RUNNING_UNIT}\n` }),
    ).rejects.toThrow("not owned");
  });

  test("refuses units whose main PID other processes can reassign", async () => {
    const notify = unitLines(RUNNING_SERVICE_PROPERTIES, 1, '{"type":"s","data":"all"}');
    await expect(verify({ service: notify.trimEnd().split("\n") })).rejects.toThrow("not owned");
    const forking = unitLines(RUNNING_SERVICE_PROPERTIES, 0, '{"type":"s","data":"forking"}');
    await expect(verify({ service: forking.trimEnd().split("\n") })).rejects.toThrow("not owned");
  });

  test("refuses another account's process", async () => {
    await expect(verify({ process: { uid: 1001 } })).rejects.toThrow("not owned");
  });

  test("the reader binds the cgroup read between two identical records", async () => {
    await expect(
      reader().verifyServiceOwnership(RUNNING_SERVICE, OBSERVATION.pid),
    ).resolves.toEqual(OBSERVATION);
    const changing = fixtureRunner({
      [`${BUS} get-property :1.1 ${RUNNING_PATH} ${UNIT} ${UNIT_NAMES}`]: [
        RUNNING_UNIT_PROPERTIES.join("\n") + "\n",
        unitLines(RUNNING_UNIT_PROPERTIES, 3, '{"type":"s","data":"stop-sigterm"}'),
      ],
    });
    await expect(
      reader(changing).verifyServiceOwnership(RUNNING_SERVICE, OBSERVATION.pid),
    ).rejects.toThrow("changed during verification");
    await expect(
      reader(
        fixtureRunner(),
        fixtureProcesses("0::/user.slice/user-1000.slice/session-2.scope\n"),
      ).verifyServiceOwnership(RUNNING_SERVICE, OBSERVATION.pid),
    ).rejects.toThrow("not owned");
  });
});

describe("Host user bus mount isolation", () => {
  test.each(["ancestor", "directory", "descendant"] as const)(
    "refuses a guest mount at the runtime %s",
    async (overlap) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "systemd-runtime-")));
      const directory = path.join(root, "user");
      const child = path.join(directory, "shared");
      await mkdir(child, { recursive: true, mode: 0o700 });
      const mounts = { ancestor: root, directory, descendant: child };
      const mount = mounts[overlap];
      try {
        await expect(
          assertPrivateRuntimeDirectory({
            directory,
            uid: process.getuid?.() ?? 1000,
            writableMountRoots: [mount],
          }),
        ).rejects.toThrow("overlaps a writable container mount");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
