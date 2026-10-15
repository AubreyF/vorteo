import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createMaintenanceControlApp } from "./coordinator-bootstrap-maintenance-control.js";
import {
  readMaintenanceRuntimeReadiness,
  readRegisteredMaintenanceRuntimeReadiness,
  type MaintenanceRuntimeIdentity,
} from "./coordinator-bootstrap-maintenance-service-status.js";

test.each([
  "registered",
  "descriptor-birth",
  "descriptor-changed",
  "descriptor-removed",
  "mounted",
  "ready",
  "not-ready",
  "source",
  "birth",
  "custody",
  "unsupported",
  "oversized",
  "malformed",
  "aborted",
])("existing bridge runtime readiness: %s", async (mode) => {
  const expected: MaintenanceRuntimeIdentity = {
    installationId: randomUUID(),
    target: "maintenance-controller",
    identitySha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    process: {
      pid: 1234,
      parentPid: 1,
      uid: 501,
      bootId: randomUUID(),
      startIdentity: "123:4",
      executable: "/fixture/node",
      argumentsSha256: "d".repeat(64),
    },
  };
  let operations = 0;
  const unavailable = async (): Promise<never> => {
    operations++;
    throw new Error("No owner operation expected");
  };
  const native = structuredClone(expected);
  if (mode === "source") native.sourceCommit = "e".repeat(40);
  if (mode === "birth") native.process.startIdentity = "124:5";
  if (mode === "malformed") native.process.pid = -1;
  if (mode === "oversized") native.process.executable = "/" + "x".repeat(20_000);
  const app = createMaintenanceControlApp({
    installationId: expected.installationId,
    ...(mode === "unsupported"
      ? {}
      : {
          runtimeStatus: async () => {
            if (mode === "descriptor-changed") await writeFile(descriptorFile, "{}");
            return { ...native, ready: mode !== "not-ready" };
          },
        }),
    status: () => ({
      version: 1,
      installationId: expected.installationId,
      available: false,
      phase: "unprovisioned",
      requests: 0,
      provisioning: {
        admissionSha256: "a".repeat(64),
        requestId: randomUUID(),
        sourceCommit: "b".repeat(40),
        artifactSha256: "c".repeat(64),
      },
    }),
    service: () => undefined,
    readOwnerConfiguration: unavailable,
    provision: unavailable,
  });
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "maintenance-status-")));
  const descriptorFile = path.join(directory, `maintenance-control-${expected.process.pid}.json`);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    const controller = new AbortController();
    if (mode === "aborted") controller.abort();
    await writeFile(
      descriptorFile,
      JSON.stringify({
        version: 1,
        admissionSha256: "a".repeat(64),
        requestId: randomUUID(),
        address: "127.0.0.1",
        port: address.port,
        process: {
          ...expected.process,
          ...(mode === "descriptor-birth" ? { startIdentity: "wrong" } : {}),
        },
      }),
      { mode: 0o600 },
    );
    const registered = [
      "registered",
      "descriptor-birth",
      "descriptor-changed",
      "descriptor-removed",
      "mounted",
    ].includes(mode);
    let current = true;
    const read = () =>
      (registered ? readRegisteredMaintenanceRuntimeReadiness : readMaintenanceRuntimeReadiness)({
        installationRoot: directory,
        writableMountRoots: mode === "mounted" ? [directory] : [],
        port: address.port,
        expected,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) throw new Error("Custody changed");
        },
      });
    if (
      [
        "source",
        "birth",
        "unsupported",
        "oversized",
        "aborted",
        "malformed",
        "descriptor-birth",
        "descriptor-changed",
        "mounted",
      ].includes(mode)
    )
      await expect(read()).rejects.toThrow();
    else {
      const result = await read();
      expect(result.ready).toBe(mode !== "not-ready");
      result.assertCurrent();
      if (mode === "custody") {
        current = false;
        expect(result.assertCurrent).toThrow("Custody changed");
      }
      if (mode === "descriptor-removed") {
        unlinkSync(descriptorFile);
        expect(result.assertCurrent).toThrow();
      }
      controller.abort();
      expect(result.assertCurrent).toThrow();
    }
    expect(
      (
        await fetch(
          `http://127.0.0.1:${address.port}/api/installation/maintenance/runtime-status?nonce=invalid`,
        )
      ).status,
    ).toBe(mode === "unsupported" ? 404 : 400);
    expect(operations).toBe(0);
  } finally {
    server.closeAllConnections();
    const closed = once(server, "close");
    server.close();
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
