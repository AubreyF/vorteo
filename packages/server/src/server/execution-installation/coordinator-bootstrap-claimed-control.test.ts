import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaimedRepairControlApp } from "./coordinator-bootstrap-claimed-control.js";
import { OwnerSessions } from "./owner-sessions.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";
import type { ClaimedRecoveryReviewService } from "./coordinator-bootstrap-session.js";

const installationId = "22222222-2222-4222-8222-222222222222";
const origin = "https://repair.example.test";
const password = "fixture-owner-password";
const passwordHash = hashSync(password, 4);
const list = {
  type: "installation.claimed_recovery.list_requests.request",
  requestId: "fixture",
};

// The transport has no lifecycle ports. This fake records delegation; native
// effects and exact-plan approval are covered by the owning recovery tests.
class ReviewService implements ClaimedRecoveryReviewService {
  available = true;
  decisions: unknown[] = [];
  observations: unknown[] = [];
  list() {
    return [];
  }
  async prepare(): Promise<never> {
    throw new BootstrapRequestConflict("Fixture plan refused");
  }
  async decide(input: unknown, ownerPassword: string, acknowledged: boolean): Promise<never> {
    this.decisions.push({ input, ownerPassword, acknowledged });
    throw new BootstrapRequestConflict("Fixture decision refused");
  }
  async reconcile(input: unknown) {
    this.observations.push(input);
  }
}

describe("provisioned claimed repair HTTP controls", () => {
  let directory: string;
  let server: Server;
  let endpoint: string;
  let service: ReviewService;
  let configurationChanged: boolean;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "claimed-control-"));
    service = new ReviewService();
    configurationChanged = false;
    const app = createClaimedRepairControlApp({
      installationId,
      service,
      readOwnerConfiguration: async () => {
        if (configurationChanged) throw new Error("private-fixture-path-and-password");
        return {
          public: { origin },
          stateDir: directory,
          ownerPasswordHash: passwordHash,
        };
      },
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    endpoint = `http://127.0.0.1:${address.port}/api/installation/claimed-repair`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  });
  function post(body: unknown = list, headers: Record<string, string> = {}) {
    return fetch(`${endpoint}/owner`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...headers },
      body: JSON.stringify(body),
    });
  }
  it("exposes only numeric public status and performs no decision", async () => {
    const result = await fetch(`${endpoint}/status`);
    expect(await result.json()).toEqual({
      version: 1,
      installationId,
      available: true,
      requests: 0,
    });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(service.decisions).toEqual([]);
  });
  it.each(["", "Bearer agent-scoped-token", "Bearer wrong-owner"])(
    "refuses unauthenticated request %s",
    async (authorization) => {
      expect((await post(list, { authorization })).status).toBe(401);
      expect(service.decisions).toEqual([]);
    },
  );
  it("requires exact origin even with the owner password", async () => {
    expect(
      (
        await post(list, {
          authorization: `Bearer ${password}`,
          origin: "https://outside.example.test",
        })
      ).status,
    ).toBe(403);
  });
  it("authenticates the owner and keeps correlation", async () => {
    const response = await post(list, { authorization: `Bearer ${password}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: "installation.claimed_recovery.list_requests.response",
      payload: { requestId: "fixture", requests: [], error: null },
    });
  });
  it("uses existing owner sessions and observes revocation without writing them", async () => {
    const sessions = new OwnerSessions(path.join(directory, "owner-sessions.json"));
    const token = sessions.create();
    const headers = { cookie: `__Host-vorteo-owner=${token}` };
    expect((await post(list, headers)).status).toBe(200);
    sessions.revoke(token);
    expect((await post(list, headers)).status).toBe(401);
  });
  it("does not accept the insecure cookie for the HTTPS installation", async () => {
    const token = new OwnerSessions(path.join(directory, "owner-sessions.json")).create();
    expect((await post(list, { cookie: `vorteo-owner=${token}` })).status).toBe(401);
  });
  it("refuses arbitrary runtime fields before calling the service", async () => {
    expect(
      (
        await post(
          { ...list, runtimeDirectory: "/tmp/untrusted" },
          { authorization: `Bearer ${password}` },
        )
      ).status,
    ).toBe(400);
  });
  it("rejects legacy hidden approval before delegation", async () => {
    const result = await post(
      {
        type: "installation.claimed_recovery.decide.request",
        requestId: "decision",
        input: {
          id: randomUUID(),
          revision: randomUUID(),
          planSha256: "a".repeat(64),
          decision: "approve",
        },
        ownerPassword: password,
      },
      { authorization: `Bearer ${password}` },
    );
    expect((await result.json()).payload.error).toContain("Reload to review");
    expect(service.decisions).toEqual([]);
  });
  it("delegates exact cancellation without treating HTTP authentication as an approval", async () => {
    const input = {
      id: randomUUID(),
      revision: randomUUID(),
      planSha256: "a".repeat(64),
      decision: "cancel",
    };
    const result = await post(
      {
        type: "installation.claimed_recovery.decide.request",
        requestId: "cancel",
        input,
        ownerPassword: password,
      },
      { authorization: `Bearer ${password}` },
    );
    expect((await result.json()).payload.error).toBe("Fixture decision refused");
    expect(service.decisions).toEqual([{ input, ownerPassword: password, acknowledged: false }]);
  });
  it("delegates an explicit exact approval with its password and review acknowledgment", async () => {
    const input = {
      id: randomUUID(),
      revision: randomUUID(),
      planSha256: "a".repeat(64),
      decision: "approve",
    };
    const result = await post(
      {
        type: "installation.claimed_recovery.decide.request",
        requestId: "approve",
        input,
        ownerPassword: password,
        claimedRecovery: true,
      },
      { authorization: `Bearer ${password}` },
    );
    expect((await result.json()).payload.error).toBe("Fixture decision refused");
    expect(service.decisions).toEqual([{ input, ownerPassword: password, acknowledged: true }]);
  });
  it("routes retained observation without invoking preparation or decisions", async () => {
    const reconcile = {
      id: randomUUID(),
      revision: randomUUID(),
      planSha256: "a".repeat(64),
      generation: randomUUID(),
    };
    const result = await post({ ...list, reconcile }, { authorization: `Bearer ${password}` });
    expect(result.status).toBe(200);
    expect((await result.json()).payload.error).toBeNull();
    expect(service.observations).toEqual([reconcile]);
    expect(service.decisions).toEqual([]);
  });
  it("stops access when pinned configuration changes and hides private failure details", async () => {
    configurationChanged = true;
    const result = await post(list, { authorization: `Bearer ${password}` });
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private-fixture");
    expect(service.decisions).toEqual([]);
  });
});
