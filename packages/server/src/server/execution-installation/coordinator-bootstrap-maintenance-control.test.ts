import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSync } from "bcryptjs";
import { expect, test, vi } from "vitest";
import { createMaintenanceControlApp } from "./coordinator-bootstrap-maintenance-control.js";

test.each(["legacy", "enrollment"] as const)(
  "maintenance transport authenticates every owner operation: %s",
  async (mode) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "maintenance-control-")));
    const installationId = randomUUID();
    const admissionSha256 = "a".repeat(64);
    let passwordHash = hashSync("fixture-owner", 4);
    const provision = vi.fn(async () => {});
    const list = vi.fn(() => []);
    const decide = vi.fn(async () => {
      throw new Error("No fixture dispatch");
    });
    const decision = { id: randomUUID(), revision: randomUUID(), manifestSha256: "e".repeat(64) };
    const enroll = vi.fn(async () => {});
    const observe = vi.fn(async () => {});
    const app = createMaintenanceControlApp({
      ...(mode === "enrollment" ? { enrollment: { decision, enroll, observe } } : {}),
      installationId,
      status: () => ({
        version: 1,
        installationId,
        available: false,
        phase: "unprovisioned",
        requests: 0,
        provisioning: {
          admissionSha256,
          requestId: randomUUID(),
          sourceCommit: "b".repeat(40),
          artifactSha256: "c".repeat(64),
        },
      }),
      service: () => ({
        list,
        decide,
        prepare: async () => {
          throw new Error("No remote preparation");
        },
      }),
      readOwnerConfiguration: async () => ({
        public: { origin: "https://fixture.example.test", installationId },
        ownerPasswordHash: passwordHash,
        stateDir: directory,
      }),
      provision,
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const base = `http://127.0.0.1:${address.port}/api/installation/maintenance`;
    const post = (
      body: unknown,
      token = "fixture-owner",
      origin = "https://fixture.example.test",
    ) =>
      fetch(`${base}/owner`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const query = {
      type: "installation.bootstrap.list_requests.request",
      requestId: "fixture-query",
    };
    try {
      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      expect(status.headers.get("cache-control")).toBe("no-store");
      expect(await status.json()).toMatchObject({
        installationId,
        phase: "unprovisioned",
        available: false,
      });
      expect((await post(query, "")).status).toBe(401);
      expect((await post(query, "fixture-owner", "https://outside.example.test")).status).toBe(403);
      expect(list).not.toHaveBeenCalled();
      expect(
        (
          await post({
            type: "installation.bootstrap.reconcile_automatic.request",
            requestId: "automatic",
            id: randomUUID(),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post({
            type: "installation.bootstrap.prepare.request",
            requestId: "prepare",
            input: {},
          })
        ).status,
      ).toBe(400);
      const proposal = {
        type: "installation.maintenance.provision.request",
        admissionSha256,
        ownerPassword: "fixture-owner",
      };
      if (mode === "enrollment") {
        const enrollment = {
          type: "installation.maintenance.enroll.request",
          ...decision,
          ownerPassword: "fixture-owner",
        };
        expect((await post(enrollment, "")).status).toBe(401);
        expect(
          (await post(enrollment, "fixture-owner", "https://outside.example.test")).status,
        ).toBe(403);
        expect((await post({ ...enrollment, revision: randomUUID() })).status).toBe(400);
        expect((await post({ ...enrollment, manifestSha256: "0".repeat(64) })).status).toBe(400);
        expect((await post({ ...enrollment, manifest: {} })).status).toBe(400);
        expect((await post(proposal)).status).toBe(400);
        expect((await post({ type: "installation.bootstrap.decide.request" })).status).toBe(400);
        expect(enroll).not.toHaveBeenCalled();
        expect(provision).not.toHaveBeenCalled();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        enroll.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
        const outstanding = post(enrollment);
        await entered.promise;
        try {
          expect((await post(enrollment)).status).toBe(409);
          expect((await post(query)).status).toBe(200);
        } finally {
          release.resolve();
          await outstanding;
        }
        expect(enroll).toHaveBeenCalledTimes(1);
        enroll.mockRejectedValueOnce(new Error("private fixture error"));
        const failed = await post(enrollment);
        expect(failed.status).toBe(503);
        expect(await failed.text()).not.toContain("private fixture error");
        expect((await post(enrollment)).status).toBe(200);
        const observation = { type: "installation.maintenance.observe.request", ...decision };
        expect((await post(observation, "")).status).toBe(401);
        expect((await post({ ...observation, id: randomUUID() })).status).toBe(400);
        expect((await post({ ...observation, ownerPassword: "extra" })).status).toBe(400);
        expect(observe).not.toHaveBeenCalled();
        const enrollCalls = enroll.mock.calls.length;
        expect((await post(observation)).status).toBe(200);
        expect((await post(observation)).status).toBe(200);
        expect(observe).toHaveBeenCalledTimes(2);
        expect(enroll).toHaveBeenCalledTimes(enrollCalls);
        expect(decide).not.toHaveBeenCalled();
        return;
      }
      expect((await post({ ...proposal, admissionSha256: "f".repeat(64) })).status).toBe(400);
      expect((await post({ ...proposal, runtime: "/arbitrary" })).status).toBe(400);
      expect(provision).not.toHaveBeenCalled();
      expect((await post(proposal)).status).toBe(200);
      expect(provision).toHaveBeenCalledTimes(1);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      provision.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
      const outstanding = post(proposal);
      await entered.promise;
      try {
        expect((await post(proposal)).status).toBe(409);
        expect(provision).toHaveBeenCalledTimes(2);
        expect((await post(query)).status).toBe(200);
      } finally {
        release.resolve();
        await outstanding;
      }
      provision.mockRejectedValueOnce(new Error("fixture validation failed"));
      expect((await post(proposal)).status).toBe(503);
      expect((await post(proposal)).status).toBe(200);
      const response = await post(query);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        type: "installation.bootstrap.list_requests.response",
        payload: { requestId: "fixture-query", requests: [], error: null },
      });
      expect(decide).not.toHaveBeenCalled();
      passwordHash = hashSync("changed-owner", 4);
      expect((await post(query)).status).toBe(401);
      expect((await post(query, "changed-owner")).status).toBe(200);
    } finally {
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
