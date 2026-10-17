import { Script } from "node:vm";
import { createServer, request as httpRequest, type RequestOptions } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSync } from "bcryptjs";
import { expect, test, vi } from "vitest";
import { createMaintenanceControlApp } from "./coordinator-bootstrap-maintenance-control.js";
import { inspectRecoveryApplication } from "./coordinator-bootstrap-maintenance-recovery-diagnostics.js";
import { runIndependentMaintenanceRecovery } from "./coordinator-bootstrap-maintenance-recovery-access.js";
import { createBootstrapOwnerReviewApp } from "./coordinator-bootstrap-owner-review.js";
import { createIndependentBootstrapControlApp } from "./coordinator-bootstrap-preclaim-control.js";
import {
  BootstrapAuthenticationRequired,
  BootstrapRequestConflict,
} from "./coordinator-bootstrap.js";

test.each([
  "missing-script",
  "owner-refused",
  "foreign-health",
  "redirect",
  "foreign-script",
  "oversized-document",
] as const)(
  "application diagnostics distinguish green health from unusable access: %s",
  async (mode) => {
    const installationId = randomUUID();
    const environments = [
      { kind: "host", serverId: "fixture-host", endpoint: "host.example.test", useTls: true },
      { kind: "container", serverId: "fixture-dev", endpoint: "dev.example.test", useTls: true },
    ];
    const authorization: Array<{ path: string; authorization: string | null }> = [];
    const server = createServer((request, response) => {
      authorization.push({
        path: request.url!,
        authorization: request.headers.authorization ?? null,
      });
      if (request.url === "/api/installation/health") {
        if (mode === "redirect") {
          response.writeHead(302, { Location: "/must-not-follow" });
          response.end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            installationId: mode === "foreign-health" ? randomUUID() : installationId,
          }),
        );
      } else if (request.url === "/api/installation/owner/connections") {
        response.statusCode = mode === "owner-refused" ? 401 : 200;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            installationId,
            connections: environments.map((environment) => ({
              ...environment,
              password: "private-fixture-response",
            })),
          }),
        );
      } else if (request.url === "/") {
        response.setHeader("Content-Type", "text/html");
        const src =
          mode === "foreign-script" ? "https://outside.example.test/entry.js" : "/entry.js";
        const padding = mode === "oversized-document" ? " ".repeat(1024 * 1024) : "";
        response.end(`<html><script src="${src}"></script>${padding}</html>`);
      } else {
        response.statusCode = mode === "missing-script" ? 404 : 200;
        response.setHeader("Content-Type", "application/javascript");
        response.end('document.body.textContent = "fixture";');
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const report = await inspectRecoveryApplication({
        installationId,
        configuration: {
          public: { version: 1, installationId, origin, environments },
          invalidMaintenanceHistory: true,
        },
        ownerCredential: "fixture-owner-only",
        signal: new AbortController().signal,
      });
      const states = Object.fromEntries(report.checks.map((check) => [check.id, check.state]));
      const expected = {
        "missing-script": {
          health: "reached",
          "owner-api": "reached",
          document: "reached",
          scripts: "failed",
        },
        "owner-refused": {
          health: "reached",
          "owner-api": "failed",
          document: "reached",
          scripts: "reached",
        },
        "foreign-health": {
          health: "failed",
          "owner-api": "unverified",
          document: "reached",
          scripts: "reached",
        },
        redirect: {
          health: "unverified",
          "owner-api": "unverified",
          document: "reached",
          scripts: "reached",
        },
        "foreign-script": {
          health: "reached",
          "owner-api": "reached",
          document: "unverified",
          scripts: "unverified",
        },
        "oversized-document": {
          health: "reached",
          "owner-api": "reached",
          document: "unverified",
          scripts: "unverified",
        },
      };
      expect(states).toEqual(expected[mode]);
      expect(report.browserUsability).toBe("unverified");
      expect(report.scope).toBe("recovery-host");
      expect(JSON.stringify(report)).not.toContain("fixture-owner-only");
      expect(JSON.stringify(report)).not.toContain("private-fixture-response");
      const authenticated = authorization.filter((request) => request.authorization !== null);
      expect(authenticated).toEqual(
        mode === "foreign-health" || mode === "redirect"
          ? []
          : [
              {
                path: "/api/installation/owner/connections",
                authorization: "Bearer fixture-owner-only",
              },
            ],
      );
      expect(authorization.some((request) => request.path === "/must-not-follow")).toBe(false);
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

test("application diagnostics cancel a hanging script body without claiming browser readiness", async () => {
  const installationId = randomUUID();
  const entered = Promise.withResolvers<void>();
  const controller = new AbortController();
  const server = createServer((request, response) => {
    if (request.url === "/api/installation/health") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ installationId }));
    } else if (request.url === "/") {
      response.end('<html><script src="/hanging.js"></script></html>');
    } else {
      response.setHeader("Content-Type", "application/javascript");
      response.write("/* incomplete body */");
      entered.resolve();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const pending = inspectRecoveryApplication({
      installationId,
      configuration: {
        public: {
          version: 1,
          installationId,
          origin,
          environments: [
            { kind: "host", serverId: "fixture-host", endpoint: "host.example.test", useTls: true },
            {
              kind: "container",
              serverId: "fixture-dev",
              endpoint: "dev.example.test",
              useTls: true,
            },
          ],
        },
      },
      ownerCredential: "fixture-owner",
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    const report = await pending;
    expect(report.checks.find((check) => check.id === "scripts")?.state).toBe("unverified");
    expect(report.browserUsability).toBe("unverified");
  } finally {
    controller.abort();
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
});

test("independent application diagnostics authenticate without loading broken maintenance history", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "recovery-diagnostics-")));
  const installationId = randomUUID();
  const origin = "https://recovery.example.test:9443";
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const app = createMaintenanceControlApp({
    installationId,
    recoveryOrigin: origin,
    status() {
      throw new Error("Unsupported maintenance history");
    },
    async readOwnerConfiguration() {
      return {
        public: { origin: "https://app.example.test", installationId },
        stateDir: directory,
        ownerPasswordHash: hashSync("fixture-owner", 4),
      };
    },
    service() {
      throw new Error("Unsupported maintenance history");
    },
    async provision() {
      throw new Error("No provisioning");
    },
    async diagnoseApplication(credential, signal) {
      expect(credential).toBe("fixture-owner");
      calls++;
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
      return {
        version: 1,
        installationId,
        applicationOrigin: "https://app.example.test",
        checkedAt: new Date().toISOString(),
        scope: "recovery-host",
        browserUsability: "unverified",
        checks: ["health", "owner-api", "document", "scripts"].map((id) => ({
          id,
          state: "unverified",
          detail: "Fixture observation",
          httpStatus: null,
        })),
      };
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (password: string, extra = {}) =>
    callRecoveryFixture(
      base,
      "/api/installation/maintenance/owner",
      {
        method: "POST",
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${password}`,
        },
      },
      JSON.stringify({
        type: "installation.maintenance.application_diagnostics.request",
        requestId: "diagnostic",
        ...extra,
      }),
    );
  try {
    expect((await post("wrong")).status).toBe(401);
    expect((await post("fixture-owner", { destination: "https://foreign.example" })).status).toBe(
      400,
    );
    expect(calls).toBe(0);
    const pending = post("fixture-owner");
    await entered.promise;
    expect((await post("fixture-owner")).status).toBe(409);
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "installation.maintenance.application_diagnostics.response",
      payload: {
        requestId: "diagnostic",
        error: null,
        report: { installationId, browserUsability: "unverified" },
      },
    });
    expect(calls).toBe(1);
  } finally {
    release.resolve();
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
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { scope: "preclaim-recovery", claimed: false },
  { scope: "preclaim-recovery", claimed: true },
  { scope: "coordinator-migration", claimed: false },
  { scope: "coordinator-migration", claimed: true },
  { scope: "coordinator-supervision", claimed: false },
  { scope: "coordinator-supervision", claimed: true },
] as const)(
  "independent $scope cancellation uses the displayed revision before claim ($claimed)",
  async ({ scope, claimed }) => {
    const binding = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    let revision = binding.revision;
    let status: "pending" | "approved" | "canceled" = "pending";
    const decisions: unknown[] = [];
    let origin = "";
    const app = createBootstrapOwnerReviewApp({
      binding,
      scope,
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
      const html = await (await fetch(origin)).text();
      expect(() => new Script(html.split("<script>")[1]!.split("</script>")[0]!)).not.toThrow();
      if (scope === "coordinator-supervision") {
        expect(html).toContain("retires that frozen process with SIGKILL");
        expect(html).toContain("Host and Dev agents are not restarted");
        expect(html).toContain("Approve this exact supervision handoff");
        expect(html).toContain("Launch outcome unverified");
        expect(html).toContain("Replacement source: ");
        expect(html).toContain("Compatible fallback source: ");
        expect(html).toContain(
          "Cancel this exact supervision handoff before execution is claimed?",
        );
      }
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

test.each([
  { scope: "preclaim-recovery", mode: "success" },
  { scope: "preclaim-recovery", mode: "lost-response" },
  { scope: "coordinator-migration", mode: "success" },
  { scope: "coordinator-migration", mode: "lost-response" },
] as const)(
  "independent runtime admission keeps the separate one-shot owner decision: $scope/$mode",
  async ({ scope, mode }) => {
    const binding = { id: randomUUID(), revision: randomUUID(), planSha256: "a".repeat(64) };
    const digest = "b".repeat(64);
    let status: "pending" | "approved" = "pending";
    let origin = "";
    const decisions: unknown[] = [];
    const admitted: string[] = [];
    const app = createIndependentBootstrapControlApp({
      scope,
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
              if (ownerPassword !== "fixture-owner")
                throw new BootstrapAuthenticationRequired("fixture refusal");
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
      expect(html).toContain(
        scope === "preclaim-recovery"
          ? "Retire only the reviewed stalled executor"
          : "Approve this exact coordinator migration",
      );
      expect(html.includes("The exact plan replaces the coordinator.")).toBe(
        scope === "coordinator-migration",
      );
      expect(html).toContain("admitted native");
      expect(
        (await post("/decision", { decision: "approve", ownerPassword: "wrong" })).status,
      ).toBe(401);
      expect(decisions).toEqual([]);
      expect(html).toContain("const nativeReview=true;");
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

test.each([true, false])(
  "consent-only transport never invokes activation: supported=%s",
  async (supported) => {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "maintenance-consent-http-")),
    );
    const installationId = randomUUID();
    const decision = { id: randomUUID(), revision: randomUUID(), manifestSha256: "a".repeat(64) };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let saved = 0;
    let effects = 0;
    let refuse = false;
    const app = createMaintenanceControlApp({
      installationId,
      enrollment: {
        decision,
        enroll: async () => {
          effects++;
        },
        ...(supported
          ? {
              saveConsent: async (value: typeof decision) => {
                expect(value).toMatchObject(decision);
                saved++;
                entered.resolve();
                await release.promise;
                if (refuse) throw new Error("private consent fixture failure");
              },
            }
          : {}),
      },
      status: () => ({
        version: 1,
        installationId,
        available: false,
        phase: "unprovisioned",
        requests: 0,
        provisioning: {
          admissionSha256: "b".repeat(64),
          requestId: randomUUID(),
          sourceCommit: "c".repeat(40),
          artifactSha256: "d".repeat(64),
        },
      }),
      service: () => undefined,
      readOwnerConfiguration: async () => ({
        public: { origin: "https://fixture.example.test", installationId },
        ownerPasswordHash: hashSync("fixture-owner", 4),
        stateDir: directory,
      }),
      provision: async () => {
        effects++;
      },
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const endpoint = `http://127.0.0.1:${address.port}/api/installation/maintenance/owner`;
    const body = { type: "installation.maintenance.enrollment.save_consent.request", ...decision };
    const post = (
      value: unknown,
      token = "fixture-owner",
      origin = "https://fixture.example.test",
    ) =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(value),
      });
    try {
      expect((await post(body, "")).status).toBe(401);
      expect((await post(body, "incorrect")).status).toBe(401);
      expect((await post(body, "fixture-owner", "https://foreign.example.test")).status).toBe(403);
      expect((await post({ ...body, revision: randomUUID() })).status).toBe(400);
      expect((await post({ ...body, manifestSha256: "0".repeat(64) })).status).toBe(400);
      expect((await post({ ...body, manifest: {} })).status).toBe(400);
      expect(saved).toBe(0);
      if (!supported) {
        expect((await post(body)).status).toBe(400);
        expect(effects).toBe(0);
        return;
      }
      const pending = post(body);
      await Promise.race([
        entered.promise,
        pending.then((response) => {
          throw new Error(`Consent rejected before storage (${response.status})`);
        }),
      ]);
      try {
        expect((await post(body)).status).toBe(409);
        expect(
          (await post({ ...body, type: "installation.maintenance.enroll.request" })).status,
        ).toBe(409);
        expect(effects).toBe(0);
      } finally {
        release.resolve();
      }
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        consentSaved: true,
        activationStarted: false,
        manifestSha256: decision.manifestSha256,
      });
      expect(saved).toBe(1);
      refuse = true;
      const failed = await post(body);
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("private consent fixture failure");
      expect(effects).toBe(0);
    } finally {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
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

test("recovery rendering survives failed journals and authenticates independently of app sessions", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "recovery-access-")));
  const installationId = randomUUID();
  const recoveryOrigin = "https://recovery.example.test:9443";
  let ownerUnavailable = true;
  let primaryOrigin = "https://app.example.test";
  let journalUnavailable = false;
  let listCalls = 0;
  const app = createMaintenanceControlApp({
    installationId,
    recoveryOrigin,
    status() {
      throw new Error("private broken status parser");
    },
    async readOwnerConfiguration() {
      if (ownerUnavailable) throw new Error("private broken owner configuration");
      return {
        public: { origin: primaryOrigin, installationId },
        stateDir: directory,
        ownerPasswordHash: hashSync("fixture-owner", 4),
      };
    },
    service: () => ({
      list() {
        listCalls++;
        if (journalUnavailable) throw new Error("private unsupported journal field");
        return [];
      },
      async prepare() {
        throw new Error("No preparation");
      },
      async decide() {
        throw new Error("No effects");
      },
    }),
    async provision() {
      throw new Error("No provisioning");
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener missing");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (route: string, host = new URL(recoveryOrigin).host) =>
    callRecoveryFixture(base, route, { headers: { Host: host } });
  const post = (token: string, origin = recoveryOrigin) =>
    callRecoveryFixture(
      base,
      "/api/installation/maintenance/owner",
      {
        method: "POST",
        headers: {
          Host: new URL(recoveryOrigin).host,
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Cookie: "__Host-vorteo-owner=primary-session",
        },
      },
      JSON.stringify({
        type: "installation.bootstrap.list_requests.request",
        requestId: "independent",
      }),
    );
  try {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("Bookmark this page");
    expect((await get("/recovery.js")).status).toBe(200);
    expect((await get("/", "outside.example")).status).toBe(403);
    expect((await post("fixture-owner")).status).toBe(503);
    expect(listCalls).toBe(0);
    ownerUnavailable = false;
    // A broken primary session file must not disable independent password access.
    await writeFile(
      path.join(directory, "owner-sessions.json"),
      "unsupported primary session data",
    );
    expect((await post("")).status).toBe(401);
    expect((await post("fixture-owner", primaryOrigin)).status).toBe(403);
    const success = await post("fixture-owner");
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({ payload: { requests: [], error: null } });
    journalUnavailable = true;
    const failed = await post("fixture-owner");
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ payload: { requests: null } });
    expect((await get("/")).status).toBe(200);
    primaryOrigin = recoveryOrigin;
    expect((await post("fixture-owner")).status).toBe(403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function callRecoveryFixture(
  base: string,
  route: string,
  options: RequestOptions,
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + route, options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve(
          new Response(text, {
            status: response.statusCode,
            headers: {
              "cache-control": String(response.headers["cache-control"]),
              "content-security-policy": String(response.headers["content-security-policy"]),
            },
          }),
        ),
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}

test.each(["success", "failure", "busy"])(
  "independent rollback preparation authenticates and excludes parallel validation: %s",
  async (mode) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "rollback-http-")));
    const origin = "https://recovery.example.test:9443";
    const installationId = randomUUID();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let preparations = 0;
    const app = createMaintenanceControlApp({
      installationId,
      recoveryOrigin: origin,
      status() {
        throw new Error("No fixture health authority");
      },
      async readOwnerConfiguration() {
        return {
          public: { installationId, origin: "https://app.example.test" },
          stateDir: directory,
          ownerPasswordHash: hashSync("fixture-owner", 4),
        };
      },
      service: () => ({
        list: () => [],
        async prepare() {
          throw new Error("No browser plan");
        },
        async decide() {
          throw new Error("No effects");
        },
      }),
      async provision() {
        throw new Error("No provisioning");
      },
      async prepareRollback() {
        preparations++;
        entered.resolve();
        if (mode === "busy") await release.promise;
        if (mode === "failure")
          throw new BootstrapRequestConflict(
            "Existing coordinator review must be reconciled first",
          );
      },
    });
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (body: unknown, token = "fixture-owner", requestOrigin = origin) =>
      callRecoveryFixture(
        base,
        "/api/installation/maintenance/owner",
        {
          method: "POST",
          headers: {
            Host: new URL(origin).host,
            Origin: requestOrigin,
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        },
        JSON.stringify(body),
      );
    const request = {
      type: "installation.maintenance.rollback.prepare.request",
      requestId: "fixture-rollback",
    };
    try {
      expect((await post(request, "wrong")).status).toBe(401);
      expect((await post(request, "fixture-owner", "https://app.example.test")).status).toBe(403);
      expect((await post({ ...request, plan: { directory: "/unreviewed" } })).status).toBe(400);
      expect(preparations).toBe(0);
      const pending = post(request);
      await entered.promise;
      if (mode === "busy") {
        expect((await post({ ...request, requestId: "competing" })).status).toBe(409);
        expect(preparations).toBe(1);
        release.resolve();
      }
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        type: "installation.maintenance.rollback.prepare.response",
        payload: {
          requestId: request.requestId,
          requests: mode === "failure" ? null : [],
          error: mode === "failure" ? "Existing coordinator review must be reconciled first" : null,
        },
      });
      expect(preparations).toBe(1);
    } finally {
      release.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("independent recovery starts with broken files and refuses unverified dispatch", async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "recovery-startup-")));
  const installationId = randomUUID();
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = "https://recovery.example.test";
  const ownerFile = path.join(directory, "owner.json");
  const setupFile = path.join(directory, "setup.json");
  const setup = {
    version: 1,
    installationRoot: directory,
    enrollmentStateDirectory: directory,
    identitySha256: "a".repeat(64),
    target: "recovery-launcher",
    sourceCommit: "b".repeat(40),
    nativeAdmission: {
      path: path.join(directory, "unavailable-admission.json"),
      sha256: "c".repeat(64),
    },
    control: {
      admissionSha256: "d".repeat(64),
      recoveryAccess: {
        installationId,
        origin,
        listenPort: address.port,
        ownerConfigurationFile: ownerFile,
      },
    },
  };
  const owner = {
    public: { origin: "https://app.example.test", installationId },
    stateDir: directory,
    ownerPasswordHash: hashSync("fixture-owner", 4),
  };
  const broken = "unsupported retained state";
  const retainedFiles = [
    "coordinator-bootstrap.json",
    "coordinator-bootstrap-pending.json",
    "maintenance-enrollment.json",
  ];
  for (const name of retainedFiles)
    await writeFile(path.join(directory, name), broken, { mode: 0o600 });
  await writeFile(setupFile, JSON.stringify(setup), { mode: 0o600 });
  await writeFile(ownerFile, JSON.stringify(owner), { mode: 0o600 });
  const server = await runIndependentMaintenanceRecovery(setupFile);
  const base = `http://127.0.0.1:${address.port}`;
  const get = () => callRecoveryFixture(base, "/", { headers: { Host: new URL(origin).host } });
  const post = (body: unknown, token = "fixture-owner") =>
    callRecoveryFixture(
      base,
      "/api/installation/maintenance/owner",
      {
        method: "POST",
        headers: {
          Host: new URL(origin).host,
          Origin: origin,
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      JSON.stringify(body),
    );
  const query = { type: "installation.bootstrap.list_requests.request", requestId: "isolated" };
  try {
    expect((await get()).status).toBe(200);
    expect((await post(query, "wrong")).status).toBe(401);
    const inspection = await post(query);
    expect(await inspection.json()).toMatchObject({ payload: { requests: null } });
    await writeFile(
      path.join(directory, "coordinator-bootstrap.json"),
      JSON.stringify({ version: 1, requests: [] }),
    );
    await writeFile(
      path.join(directory, "coordinator-bootstrap-pending.json"),
      JSON.stringify({ version: 1, requests: [], promotions: [] }),
    );
    const decision = await post({
      type: "installation.bootstrap.decide.request",
      requestId: "no-dispatch",
      ownerPassword: "fixture-owner",
      input: {
        id: randomUUID(),
        revision: randomUUID(),
        planSha256: "e".repeat(64),
        decision: "approve",
      },
    });
    const refused = await decision.json();
    expect(refused).toMatchObject({ payload: { requests: null } });
    expect(refused.payload.error).toContain("Bootstrap validation failed");
    expect(await readFile(path.join(directory, "maintenance-enrollment.json"), "utf8")).toBe(
      broken,
    );
    await writeFile(ownerFile, broken);
    expect((await get()).status).toBe(200);
    expect((await post(query)).status).toBe(503);
    await writeFile(ownerFile, JSON.stringify(owner));
    await writeFile(
      setupFile,
      JSON.stringify({
        ...setup,
        control: {
          ...setup.control,
          recoveryAccess: { ...setup.control.recoveryAccess, installationId: randomUUID() },
        },
      }),
    );
    expect((await get()).status).toBe(200);
    expect((await post(query)).status).toBe(503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
