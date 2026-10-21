import { expect, test } from "vitest";
import { MaintenanceClient } from "./maintenance-client";

const installationId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const status = {
  version: 1,
  installationId,
  available: true,
  phase: "ready",
  requests: 1,
  provisioning: {
    admissionSha256: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64),
    requestId: id,
  },
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function fixture() {
  let read = () => json(status);
  const sent: Record<string, unknown>[] = [];
  const client = new MaintenanceClient(installationId, {
    now: () => 0,
    fetch: async (url, init) => {
      if (url.endsWith("/status")) return read();
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (body.type === "installation.maintenance.provision.request")
        return json({ provisioned: true });
      return json({
        type: body.type.replace(/\.request$/, ".response"),
        payload: { requestId: body.requestId, requests: [], error: null },
      });
    },
  });
  return {
    client,
    sent,
    status: (value: () => Response) => {
      read = value;
    },
  };
}
const decision = {
  id,
  revision: "44444444-4444-4444-8444-444444444444",
  planSha256: "d".repeat(64),
  decision: "approve" as const,
};

test("maintenance reads retained status while unavailable but never sends approval", async () => {
  const f = fixture();
  f.status(() => json({ ...status, available: false, phase: "unavailable" }));
  expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
  expect(f.sent[0]).toMatchObject({
    compatibleRecovery: true,
    bootRecovery: true,
    automaticStatus: true,
  });
  await expect(f.client.decideCoordinatorBootstrap(decision, "fixture-secret")).rejects.toThrow(
    "unavailable",
  );
  expect(f.sent).toHaveLength(1);
});

test("maintenance sends an exact decision only after matching installation and request readiness", async () => {
  const f = fixture();
  f.status(() => json({ ...status, installationId: id }));
  await expect(f.client.decideCoordinatorBootstrap(decision, "fixture-secret")).rejects.toThrow(
    "another installation",
  );
  f.status(() => json(status));
  await expect(
    f.client.decideCoordinatorBootstrap({ ...decision, id: installationId }, "fixture-secret"),
  ).rejects.toThrow("changed");
  expect(f.sent).toHaveLength(0);
  await f.client.decideCoordinatorBootstrap(decision, "fixture-secret");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({
    input: decision,
    compatibleRecovery: true,
    bootRecovery: true,
    ownerPassword: "fixture-secret",
  });
  f.status(() => new Response("missing", { status: 404 }));
  await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow("unreachable");
});

test("maintenance setup refuses changed or already pending provisioning before sending credentials", async () => {
  const f = fixture();
  await expect(
    f.client.provision(status.provisioning.admissionSha256, "fixture-secret"),
  ).rejects.toThrow("changed");
  f.status(() => json({ ...status, available: false, phase: "unprovisioned", requests: 0 }));
  await expect(f.client.provision("e".repeat(64), "fixture-secret")).rejects.toThrow("changed");
  expect(f.sent).toHaveLength(0);
  await f.client.provision(status.provisioning.admissionSha256, "fixture-secret");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({
    type: "installation.maintenance.provision.request",
    admissionSha256: status.provisioning.admissionSha256,
  });
});
