import { describe, expect, it } from "vitest";
import { ClaimedRepairClient } from "./claimed-repair-client";

const installationId = "22222222-2222-4222-8222-222222222222";
const identity = {
  id: "33333333-3333-4333-8333-333333333333",
  revision: "44444444-4444-4444-8444-444444444444",
  planSha256: "a".repeat(64),
};
const status = { version: 1, installationId, available: true, requests: 0 };
function json(value: unknown, code = 200) {
  return new Response(JSON.stringify(value), {
    status: code,
    headers: { "content-type": "application/json" },
  });
}
function fixture() {
  const requests: { url: string; init: RequestInit }[] = [];
  let now = 0;
  let statusResponse = () => json(status);
  let ownerResponse = (message: Record<string, unknown>) =>
    json({
      type: String(message.type).replace(/\.request$/, ".response"),
      payload: { requestId: message.requestId, requests: [], error: null },
    });
  const client = new ClaimedRepairClient(installationId, {
    now: () => now,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return url.endsWith("/status")
        ? statusResponse()
        : ownerResponse(JSON.parse(String(init.body)));
    },
  });
  return {
    client,
    requests,
    advance: () => {
      now += 60_000;
    },
    status: (value: typeof statusResponse) => {
      statusResponse = value;
    },
    owner: (value: typeof ownerResponse) => {
      ownerResponse = value;
    },
  };
}

describe("independently provisioned repair client", () => {
  it("waits for initial owner provisioning without sending a recovery request", async () => {
    const f = fixture();
    f.status(() =>
      json({
        ...status,
        available: false,
        provisioning: {
          admissionSha256: "a".repeat(64),
          sourceCommit: "b".repeat(40),
          artifactSha256: "c".repeat(64),
          originalId: identity.id,
        },
      }),
    );
    expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
    expect(f.requests).toHaveLength(1);
    f.status(() => json(status));
    expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
    expect(f.requests).toHaveLength(3);
  });
  it("discovers this installation and reads with same-origin owner session", async () => {
    const f = fixture();
    expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].init).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      method: "POST",
    });
    expect(f.requests[1].init.headers).not.toHaveProperty("Authorization");
  });
  it.each([404, 200])(
    "treats an initially absent legacy route as unsupported (%s)",
    async (code) => {
      const f = fixture();
      f.status(() => new Response("legacy HTML", { status: code }));
      expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
      expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
      expect(f.requests).toHaveLength(1);
      f.advance();
      f.status(() => json(status));
      expect(await f.client.listCoordinatorBootstrapRequests()).toEqual([]);
      expect(f.requests).toHaveLength(3);
    },
  );
  it("never erases a supported route when it later returns 404", async () => {
    const f = fixture();
    await f.client.listCoordinatorBootstrapRequests();
    f.status(() => new Response("missing", { status: 404 }));
    await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow("unreachable");
  });
  it("rejects a different installation before sending owner credentials", async () => {
    const f = fixture();
    f.status(() => json({ ...status, installationId: identity.id }));
    await expect(
      f.client.decideCoordinatorBootstrap({ ...identity, decision: "approve" }, "private"),
    ).rejects.toThrow("another installation");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].init).not.toHaveProperty("body");
  });
  it("refuses unavailable and malformed readiness", async () => {
    const f = fixture();
    f.status(() => json({ ...status, available: false }));
    await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow("unavailable");
    f.status(() => json({ available: true }));
    await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow();
  });
  it("requires owner access and rejects mismatched response correlation", async () => {
    const f = fixture();
    f.owner(() => json({}, 401));
    await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow("Unlock");
    f.owner(() =>
      json({
        type: "installation.claimed_recovery.list_requests.response",
        payload: { requestId: "wrong", requests: [], error: null },
      }),
    );
    await expect(f.client.listCoordinatorBootstrapRequests()).rejects.toThrow("does not match");
  });
  it("sends exact reviewed approval once and never retains its password", async () => {
    const f = fixture();
    await f.client.decideCoordinatorBootstrap(
      { ...identity, decision: "approve" },
      "private-fixture",
    );
    expect(JSON.parse(String(f.requests[1].init.body))).toMatchObject({
      input: { ...identity, decision: "approve" },
      claimedRecovery: true,
      ownerPassword: "private-fixture",
    });
    await f.client.listCoordinatorBootstrapRequests();
    expect(JSON.stringify(f.requests.slice(2))).not.toContain("private-fixture");
  });
  it("refuses a decision before support instead of using another lifecycle route", async () => {
    const f = fixture();
    f.status(() => new Response("", { status: 404 }));
    await expect(
      f.client.decideCoordinatorBootstrap({ ...identity, decision: "cancel" }, "private"),
    ).rejects.toThrow("unavailable");
    expect(f.requests).toHaveLength(1);
  });
  it("observes only the retained generation without issuing a decision", async () => {
    const f = fixture();
    const reconcile = { ...identity, generation: "55555555-5555-4555-8555-555555555555" };
    await f.client.verifyRetainedOutcome(reconcile);
    expect(JSON.parse(String(f.requests[1].init.body))).toMatchObject({
      type: "installation.claimed_recovery.list_requests.request",
      reconcile,
    });
  });
});
