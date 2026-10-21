import {
  closeSync,
  linkSync,
  openSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assertMaintenanceRuntimeProcessesAbsent,
  requireMaintenanceRuntimeAbsence,
} from "./coordinator-bootstrap-maintenance-process-inventory.js";

test.each([
  { uid: 501, complete: false, pids: [] },
  { uid: 502, complete: true, pids: [] },
  { uid: 501, complete: true, pids: [123] },
  { uid: 501, complete: true },
])("rejects incomplete, mismatched or occupied runtime inventory: %j", (value) => {
  expect(() => requireMaintenanceRuntimeAbsence(value, 501)).toThrow();
});

test("accepts an exact complete empty owner inventory", () => {
  expect(() =>
    requireMaintenanceRuntimeAbsence({ uid: 501, complete: true, pids: [] }, 501),
  ).not.toThrow();
});

test.skipIf(process.platform !== "darwin")(
  "native inventory detects this Node executable without signals",
  () => {
    expect(() =>
      assertMaintenanceRuntimeProcessesAbsent({
        uid: process.getuid!(),
        executables: [realpathSync(process.execPath)],
      }),
    ).toThrow("still has a native process");
  },
);

test.skipIf(process.platform !== "darwin")(
  "native inventory proves an unused fixture path absent",
  () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-inventory-")));
    try {
      const file = path.join(root, "unused-node");
      writeFileSync(file, "fixture only", { mode: 0o600 });
      expect(() =>
        assertMaintenanceRuntimeProcessesAbsent({ uid: process.getuid!(), executables: [file] }),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);

test("allows only explicitly verified executor PIDs", () => {
  const value = { uid: 501, complete: true, pids: [123, 456] };
  expect(() => requireMaintenanceRuntimeAbsence(value, 501, [123])).toThrow();
  expect(() => requireMaintenanceRuntimeAbsence(value, 501, [123, 456])).not.toThrow();
});

test.skipIf(process.platform !== "darwin")(
  "native inventory detects an open hard-link alias",
  () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "runtime-alias-")));
    const file = path.join(root, "runtime-node");
    const alias = path.join(root, "alias-node");
    writeFileSync(file, "fixture only", { mode: 0o600 });
    linkSync(file, alias);
    const fd = openSync(alias, "r");
    try {
      expect(() =>
        assertMaintenanceRuntimeProcessesAbsent({ uid: process.getuid!(), executables: [file] }),
      ).toThrow("still has a native process");
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true });
    }
  },
);
