import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { verifyRecoveryExecutorExit } from "./coordinator-bootstrap-maintenance-recovery-proof.js";

function fixture(changedBoot = true) {
  const installationId = randomUUID();
  const expected = {
    pid: 4100,
    parentPid: 1,
    uid: 501,
    bootId: randomUUID(),
    startIdentity: "1000:1",
    executable: "/private/fixture/node",
    argumentsSha256: "a".repeat(64),
  };
  const currentBoot = {
    installationId,
    process: { ...expected, bootId: changedBoot ? randomUUID() : expected.bootId },
    assertCurrent: vi.fn(() => undefined),
  };
  const reader = { verifyProcessExited: vi.fn(async () => undefined) };
  return { installationId, expected, currentBoot, reader };
}

test("verified new boot proves the retained lifetime ended despite numeric PID reuse", async () => {
  const input = fixture();
  input.reader.verifyProcessExited.mockRejectedValue(new Error("PID now occupied"));
  const assertCurrent = await verifyRecoveryExecutorExit(input);
  expect(input.reader.verifyProcessExited).not.toHaveBeenCalled();
  assertCurrent();
  expect(input.currentBoot.assertCurrent).toHaveBeenCalledTimes(3);
});

test("same boot still requires independent exit proof", async () => {
  const input = fixture(false);
  input.reader.verifyProcessExited.mockRejectedValue(new Error("still live"));
  await expect(verifyRecoveryExecutorExit(input)).rejects.toThrow("lifetime exit is unproven");
  expect(input.reader.verifyProcessExited).toHaveBeenCalledWith(input.expected.pid);
});

test("without a current boot witness ordinary exit proof is unchanged", async () => {
  const { currentBoot: _unused, ...input } = fixture();
  await verifyRecoveryExecutorExit(input);
  expect(input.reader.verifyProcessExited).toHaveBeenCalledWith(input.expected.pid);
});

test.each(["installation", "uid", "inspection"] as const)(
  "refuses untrusted current boot: %s",
  async (mode) => {
    const input = fixture();
    if (mode === "installation") input.currentBoot.installationId = randomUUID();
    if (mode === "uid") input.currentBoot.process.uid++;
    if (mode === "inspection")
      input.currentBoot.assertCurrent.mockImplementation(() => {
        throw new Error("native inspection failed");
      });
    await expect(verifyRecoveryExecutorExit(input)).rejects.toThrow();
  },
);

test("final admission refuses changed boot witness and native custody", async () => {
  const input = fixture();
  const assertCurrent = await verifyRecoveryExecutorExit(input);
  input.currentBoot.process.bootId = randomUUID();
  expect(assertCurrent).toThrow("boot custody is unproven");
  const another = fixture();
  const assertAnother = await verifyRecoveryExecutorExit(another);
  another.currentBoot.assertCurrent.mockImplementation(() => {
    throw new Error("native custody changed");
  });
  expect(assertAnother).toThrow("native custody changed");
});
