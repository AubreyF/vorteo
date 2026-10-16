import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSync } from "bcryptjs";
import { expect, test, vi } from "vitest";
import { createMaintenanceControlApp } from "./coordinator-bootstrap-maintenance-control.js";
import { createBootstrapOwnerReviewApp } from "./coordinator-bootstrap-owner-review.js";
import { createPreclaimRepairControlApp } from "./coordinator-bootstrap-preclaim-control.js";
import { BootstrapAuthenticationRequired } from "./coordinator-bootstrap.js";

test.each([false, true])(
  "independent preclaim cancellation uses the displayed revision before claim (%s)",
  async (claimed) => {
    const binding = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    let revision = binding.revision;
    let status: "pending" | "approved" | "canceled" = "pending";
    const decisions: unknown[] = [];
    let origin = "";
    const app = createBootstrapOwnerReviewApp({
      binding,
      scope: "preclaim-recovery",
      origin: () => origin,
      client: {
        async listCoordinatorBootstrapRequests() {
          return [
            {
              ...binding,
              revision,
              status,
              reason: "Retained fixture",
              ...(claimed && status === "approved" ? { execution: { stage: "claimed" } } : {}),
            },
          ];
        },
        async decideCoordinatorBootstrap(input, password) {
          if (password !== "fixture-owner")
            throw new BootstrapAuthenticationRequired("fixture refusal");
          decisions.push(input);
          revision = randomUUID();
          status = input.decision === "approve" ? "approved" : "canceled";
          return [];
        },
      },
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    origin = `http://127.0.0.1:${address.port}`;
    const post = (decision: string, requestRevision: string, password = "fixture-owner") =>
      fetch(origin + "/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ decision, revision: requestRevision, ownerPassword: password }),
      });
    try {
      expect((await post("approve", revision, "wrong")).status).toBe(401);
      expect(decisions).toEqual([]);
      expect((await post("approve", revision)).status).toBe(200);
      const approvedRevision = revision;
      expect((await post("approve", revision)).status).toBe(409);
      expect((await post("cancel", binding.revision)).status).toBe(409);
      if (claimed) {
        expect((await post("cancel", approvedRevision)).status).toBe(409);
        expect(decisions).toEqual([{ ...binding, decision: "approve" }]);
      } else {
        expect((await post("cancel", approvedRevision, "wrong")).status).toBe(401);
        expect((await post("cancel", approvedRevision)).status).toBe(200);
        expect(decisions).toEqual([
          { ...binding, decision: "approve" },
          { ...binding, revision: approvedRevision, decision: "cancel" },
        ]);
        expect((await post("cancel", revision)).status).toBe(409);
        expect(status).toBe("canceled");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  },
);

test.each(["success", "lost-response"])(
  "independent preclaim admission keeps the separate one-shot owner decision: %s",
  async (mode) => {
    const binding = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    const digest = "b".repeat(64);
    let status: "pending" | "approved" = "pending";
    let origin = "";
    const decisions: unknown[] = [];
    const admitted: string[] = [];
    const app = createPreclaimRepairControlApp({
      admissionSha256: digest,
      origin: () => origin,
      proposal: { originalId: "retained-fixture", scope: "retire only the reviewed executor" },
      provision: async (password) => {
        if (password !== "fixture-owner")
          throw new BootstrapAuthenticationRequired("private fixture password");
        admitted.push("exact runtime");
        return {
          binding,
          client: {
            listCoordinatorBootstrapRequests: async () => [
              { ...binding, status, reason: "Retire only the exact fixture executor" },
            ],
            decideCoordinatorBootstrap: async (decision, ownerPassword) => {
              expect(ownerPassword).toBe("fixture-owner");
              decisions.push(decision);
              status = "approved";
              if (mode === "lost-response") throw new Error("private native diagnostic");
              return [];
            },
          },
        };
      },
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    origin = `http://127.0.0.1:${address.port}`;
    const post = (route: string, body: unknown, requestOrigin = origin) =>
      fetch(origin + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: requestOrigin },
        body: JSON.stringify(body),
      });
    try {
      expect(await (await fetch(origin)).text()).toContain("Authorize this exact review runtime");
      expect(
        (
          await post(
            "/provision",
            { admissionSha256: digest, ownerPassword: "fixture-owner" },
            "https://outside.example",
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post("/provision", {
            admissionSha256: "c".repeat(64),
            ownerPassword: "fixture-owner",
          })
        ).status,
      ).toBe(409);
      const refused = await post("/provision", { admissionSha256: digest, ownerPassword: "wrong" });
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain("private fixture password");
      expect(admitted).toEqual([]);
      expect(decisions).toEqual([]);
      expect(
        (await post("/provision", { admissionSha256: digest, ownerPassword: "fixture-owner" }))
          .status,
      ).toBe(200);
      expect(admitted).toEqual(["exact runtime"]);
      expect(decisions).toEqual([]);
      const html = await (await fetch(origin)).text();
      expect(html).toContain("Retire only the reviewed stalled executor");
      expect(html).not.toContain("The exact plan replaces the coordinator.");
      const decision = { decision: "approve", ownerPassword: "fixture-owner" };
      expect((await post("/decision", decision)).status).toBe(mode === "success" ? 200 : 503);
      expect((await post("/decision", decision)).status).toBe(409);
      expect(decisions).toEqual([{ ...binding, decision: "approve" }]);
      expect(await (await fetch(origin + "/review")).json()).toMatchObject({
        attempted: true,
        request: { status: "approved" },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  },
);

test.each(["success", "lost-response", "changed-review"])(
  "independent owner review preserves exact tracked decision: %s",
  async (mode) => {
    const binding = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    let status: "pending" | "approved" = "pending";
    let revision = binding.revision;
    const decisions: unknown[] = [];
    let origin = "";
    const app = createBootstrapOwnerReviewApp({
      binding,
      origin: () => origin,
      client: {
        async listCoordinatorBootstrapRequests() {
          return [{ ...binding, revision, status, reason: "Exact retained fixture" }];
        },
        async decideCoordinatorBootstrap(input, password) {
          decisions.push(input);
          expect(password).toBe("fixture-owner");
          status = "approved";
          if (mode === "lost-response") throw new Error("private fixture failure");
          return [];
        },
      },
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    origin = `http://127.0.0.1:${address.port}`;
    const post = (requestOrigin = origin, extra = {}) =>
      fetch(origin + "/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: requestOrigin },
        body: JSON.stringify({ decision: "approve", ownerPassword: "fixture-owner", ...extra }),
      });
    try {
      const page = await fetch(origin);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Approve this exact coordinator migration");
      expect((await fetch(origin + "/review")).status).toBe(200);
      expect(decisions).toEqual([]);
      expect((await post("https://outside.example")).status).toBe(403);
      const invalidHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          origin + "/review",
          { headers: { Host: "outside.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(invalidHost).toBe(403);
      expect((await post(origin, { id: randomUUID() })).status).toBe(503);
      expect(decisions).toEqual([]);
      if (mode === "changed-review") revision = randomUUID();
      const response = await post();
      if (mode === "changed-review") {
        expect(response.status).toBe(409);
        expect(decisions).toEqual([]);
      } else {
        expect(response.status).toBe(mode === "success" ? 200 : 503);
        expect(await response.text()).not.toContain("private fixture failure");
        expect(decisions).toEqual([{ ...binding, decision: "approve" }]);
        const observed = await (await fetch(origin + "/review")).json();
        expect(observed).toMatchObject({ attempted: true, request: { status: "approved" } });
        expect((await post()).status).toBe(409);
        expect(decisions).toHaveLength(1);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

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
