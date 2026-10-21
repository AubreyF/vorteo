import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  assertMaintenanceServiceAbsent,
  inspectMaintenanceServicePresence,
  requireMaintenanceServiceAbsenceResult,
} from "./coordinator-bootstrap-maintenance-absence.js";

const uid = process.getuid?.();
const label = "local.vorteo.absence-fixture.installation";
const service = `gui/${uid}/${label}`;
const missing = {
  status: 113,
  signal: null,
  stderr: `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}\n`,
};

test("accepts only the exact native absence response", () => {
  expect(() => requireMaintenanceServiceAbsenceResult(service, missing)).not.toThrow();
});

test.each([
  { ...missing, status: 1 },
  { ...missing, signal: "SIGTERM" },
  { ...missing, stderr: "permission denied" },
  { ...missing, stderr: missing.stderr.replace(label, "different-label") },
  new Error("timed out"),
])("refuses failed inspection as absence: %j", (error) => {
  expect(() => requireMaintenanceServiceAbsenceResult(service, error)).toThrow(
    "absence is unproven",
  );
});

test("refuses a different user domain", () => {
  expect(() => requireMaintenanceServiceAbsenceResult(`gui/999999/${label}`, missing)).toThrow(
    "user custody",
  );
});

test.skipIf(process.platform !== "darwin")(
  "reads native absence without registering a service",
  () => {
    const unique = `gui/${uid}/local.vorteo.absence-${randomUUID()}.installation`;
    expect(inspectMaintenanceServicePresence(unique)).toBe("absent");
    expect(() => assertMaintenanceServiceAbsent(unique)).not.toThrow();
  },
);
