import { expect, test } from "vitest";
import {
  verifyNativeHelperReadiness,
  type NativeHelperReadiness,
} from "./native-helper-process.js";

function fixture(): NativeHelperReadiness {
  const expectedExecutable = "/private/fixture/Helper.app/Contents/MacOS/VorteoPermissionHelper";
  return {
    expectedExecutable,
    expectedUid: 501,
    readStatus: async () => ({
      ok: true,
      code: "safari_permission_-1743",
      protocolVersion: 2,
      process: {
        pid: 42,
        executable: expectedExecutable,
        instanceId: "00000000-0000-4000-8000-000000000001",
      },
    }),
    inspectProcess: async (pid) => ({
      pid,
      uid: 501,
      executable: expectedExecutable,
      startedAt: "Fri Oct 9 01:00:00 2026",
    }),
  };
}
test("helper readiness verifies process identity without claiming Safari consent", async () => {
  const f = fixture();
  await expect(verifyNativeHelperReadiness(f)).resolves.toMatchObject({
    pid: 42,
    executable: f.expectedExecutable,
  });
});
test("legacy status without process identity cannot prove replacement", async () => {
  const f = fixture();
  f.readStatus = async () => ({ ok: true, code: "safari_permission_0", protocolVersion: 2 });
  await expect(verifyNativeHelperReadiness(f)).rejects.toThrow();
});
test("helper readiness rejects changed process, wrong owner and another executable", async () => {
  for (const change of [{ uid: 502 }, { executable: "/another/helper" }, { pid: 43 }]) {
    const f = fixture();
    f.inspectProcess = async (pid) => ({
      pid,
      uid: 501,
      executable: f.expectedExecutable,
      startedAt: "fixed",
      ...change,
    });
    await expect(verifyNativeHelperReadiness(f)).rejects.toThrow("selected executable");
  }
  const f = fixture();
  let calls = 0;
  f.inspectProcess = async (pid) => ({
    pid,
    uid: 501,
    executable: f.expectedExecutable,
    startedAt: String(calls++),
  });
  await expect(verifyNativeHelperReadiness(f)).rejects.toThrow("changed during readiness");
});
test("helper readiness refuses an unchanged old instance after installation", async () => {
  const f = fixture();
  f.previous = {
    pid: 42,
    executable: f.expectedExecutable,
    instanceId: "00000000-0000-4000-8000-000000000001",
  };
  await expect(verifyNativeHelperReadiness(f)).rejects.toThrow("still running");
});
