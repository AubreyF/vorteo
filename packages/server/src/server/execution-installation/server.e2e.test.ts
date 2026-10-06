import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type Server, type IncomingMessage } from "node:http";
import pino from "pino";
import { hashDaemonPassword } from "../auth.js";
import { createInstallationServer } from "./server.js";
import type { InstallationConfig } from "./config.js";
import { delegateToContainer, type DelegationClient } from "./delegation.js";
import {
  RestartJobSchema,
  InstallationUnlockSchema,
} from "@getpaseo/protocol/execution-installation";

const cleanups: Array<() => Promise<void>> = [];

test("delegated creation resolves a paginated workspace to its working directory", async () => {
  // Isolate directory lookup from provider execution, which requires account credentials.
  const createAgent = vi.fn(async (options: Parameters<DelegationClient["createAgent"]>[0]) => {
    if (!options.cwd) throw new Error("createAgent requires provider and cwd");
    return { id: "worker-id" };
  });
  const fetchWorkspaces = vi
    .fn()
    .mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "next" } })
    .mockResolvedValueOnce({
      entries: [
        { id: "workspace-id", workspaceDirectory: "/worktrees/worker", projectRootPath: "/repo" },
      ],
      pageInfo: { hasMore: false, nextCursor: null },
    });
  const client = { fetchWorkspaces, createAgent } as unknown as DelegationClient;
  const request = {
    operation: "create" as const,
    idempotencyKey: randomUUID(),
    provider: "codex",
    workspaceId: "workspace-id",
    title: "Worker",
    initialPrompt: "Inspect the workspace",
  };
  expect(await delegateToContainer(client, request)).toEqual({ id: "worker-id" });
  expect(fetchWorkspaces.mock.calls).toEqual([
    [{ page: { limit: 200, cursor: undefined } }],
    [{ page: { limit: 200, cursor: "next" } }],
  ]);
  expect(createAgent).toHaveBeenCalledWith({
    provider: request.provider,
    cwd: "/worktrees/worker",
    workspaceId: request.workspaceId,
    title: request.title,
    initialPrompt: request.initialPrompt,
    idempotencyKey: request.idempotencyKey,
    model: undefined,
  });
});

test("delegated creation rejects an unknown workspace before starting a worker", async () => {
  const createAgent = vi.fn();
  const client = {
    fetchWorkspaces: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    createAgent,
  } as unknown as DelegationClient;
  await expect(
    delegateToContainer(client, {
      operation: "create",
      idempotencyKey: randomUUID(),
      provider: "codex",
      workspaceId: "missing",
      title: "Worker",
      initialPrompt: "Inspect the workspace",
    }),
  ).rejects.toThrow("Container workspace was not found");
  expect(createAgent).not.toHaveBeenCalled();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "vorteo-installation-test-"));
  writeFileSync(
    path.join(root, "index.html"),
    "<html><head></head><body>trusted application</body></html>",
  );
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: randomUUID(),
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "guest-id", endpoint: "guest.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    redirectOrigins: ["https://previous.example.test"],
    webDistDir: root,
    stateDir: root,
    ownerPasswordHash: hashDaemonPassword("owner-test-password"),
    hostAgentTokenHash: hash("host-agent-test-token"),
    containerAgentTokenHash: hash("guest-agent-test-token"),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-daemon-test-password",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: "127.0.0.1:6768", password: "guest-daemon-test-password" },
  };
  const calls: string[] = [];
  const app = createInstallationServer(
    config,
    {
      restart: async (target) => {
        calls.push(target);
        return "verified ready";
      },
    },
    pino({ level: "silent" }),
  );
  const server: Server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  config.listenPort = address.port;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    rmSync(root, { recursive: true, force: true });
  });
  async function request(
    route: string,
    token?: string,
    body?: unknown,
    origin = config.public.origin,
    cookie?: string,
  ) {
    return fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Host: "owner.example.test",
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
  }
  return { request, root, calls, url: `http://127.0.0.1:${address.port}` };
}

test("previous origins redirect navigation without accepting API credentials", async () => {
  const { url } = await fixture();
  function previousRequest(route: string, method = "GET", host = "previous.example.test") {
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        `${url}${route}`,
        {
          method,
          headers: {
            Host: host,
            Origin: "https://previous.example.test",
            Authorization: "Bearer owner-test-password",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response));
        },
      );
      request.on("error", reject);
      request.end();
    });
  }
  const response = await previousRequest("/workspaces/existing?thread=kept");
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe(
    "https://owner.example.test/workspaces/existing?thread=kept",
  );
  expect(response.headers["cache-control"]).toBe("no-store");
  expect((await previousRequest("/api/installation/owner/unlock", "POST")).statusCode).toBe(403);
  expect((await previousRequest("/api/installation/health")).statusCode).toBe(403);
  expect((await previousRequest("/", "GET", "unknown.example.test")).statusCode).toBe(403);
});

test("public HTML has environment identities but no credentials", async () => {
  const { request } = await fixture();
  const response = await request("/");
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("__VORTEO_EXECUTION_INSTALLATION__");
  for (const secret of [
    "owner-test-password",
    "host-daemon-test-password",
    "guest-daemon-test-password",
    "host-agent-test-token",
  ])
    expect(html).not.toContain(secret);
});

test("guest credentials can request a restart but cannot unlock, approve, or address outside agents", async () => {
  const { request, calls } = await fixture();
  const token = "guest-agent-test-token";
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", token, {
        target: "host",
        reason: "Prepared update",
      })
    ).json(),
  );
  expect(calls).toEqual([]);
  expect((await request("/api/installation/owner/unlock", token, {})).status).toBe(401);
  expect(
    (
      await request(`/api/installation/owner/restarts/${job.id}/decision`, token, {
        revision: job.revision,
        decision: "approve",
      })
    ).status,
  ).toBe(401);
  expect(
    (await request("/api/installation/container-agents", token, { operation: "list" })).status,
  ).toBe(403);
  expect(
    (await request("/api/installation/owner/unlock", "guest-daemon-test-password", {})).status,
  ).toBe(401);
  expect(
    (
      await request(
        "/api/installation/owner/unlock",
        "owner-test-password",
        {},
        "https://guest.example.test",
      )
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});

test("owner unlocks both separate connections and approves one immutable restart with a durable outcome", async () => {
  const { request, root, calls } = await fixture();
  const owner = "owner-test-password";
  const unlocked = InstallationUnlockSchema.parse(
    await (await request("/api/installation/owner/unlock", owner, {})).json(),
  );
  expect(unlocked.connections.map((entry) => entry.password)).toEqual([
    "host-daemon-test-password",
    "guest-daemon-test-password",
  ]);
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "container-daemon",
        reason: "Prepared update",
      })
    ).json(),
  );
  const approval = await request(`/api/installation/owner/restarts/${job.id}/decision`, owner, {
    revision: job.revision,
    decision: "approve",
  });
  expect(approval.status).toBe(200);
  expect(calls).toEqual(["container-daemon"]);
  expect(JSON.parse(readFileSync(path.join(root, "restart-jobs.json"), "utf8"))[0].status).toBe(
    "succeeded",
  );
  expect(
    (
      await request(`/api/installation/owner/restarts/${job.id}/decision`, owner, {
        revision: job.revision,
        decision: "approve",
      })
    ).status,
  ).toBe(409);
  expect(calls).toHaveLength(1);
});

test("shared profile inspection and conflict resolution reject guest credentials and foreign origins", async () => {
  const { request } = await fixture();
  expect(
    (await request("/api/installation/owner/profiles/query", "guest-agent-test-token", {})).status,
  ).toBe(401);
  expect(
    (
      await request(
        "/api/installation/owner/profiles/query",
        "owner-test-password",
        {},
        "https://foreign.example.test",
      )
    ).status,
  ).toBe(403);
  expect(
    (await request("/api/installation/owner/profiles/resolve", "guest-daemon-test-password", {}))
      .status,
  ).toBe(401);
  const response = await request(
    "/api/installation/owner/profiles/query",
    "owner-test-password",
    {},
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
});

test("owner cookie restores access without a password and lock revokes it", async () => {
  const { request, calls } = await fixture();
  const route = "/api/installation/owner/";
  const origin = "https://owner.example.test";
  expect(await (await request(`${route}session`, undefined, {})).json()).toEqual({
    authenticated: false,
    expiresAt: null,
  });
  const login = await request(`${route}unlock`, "owner-test-password", {});
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie")!;
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  const cookie = setCookie.split(";")[0];
  expect((await request(`${route}connections`, undefined, {}, origin, cookie)).status).toBe(200);
  expect(
    (await request(`${route}restarts/query`, undefined, {}, "https://attacker.test", cookie))
      .status,
  ).toBe(403);
  expect((await request(`${route}connections`, "guest-agent-test-token", {})).status).toBe(401);
  expect(calls).toEqual([]);
  expect((await request(`${route}lock`, undefined, {}, origin, cookie)).status).toBe(200);
  expect((await request(`${route}connections`, undefined, {}, origin, cookie)).status).toBe(401);
  expect(await (await request(`${route}session`, undefined, {}, origin, cookie)).json()).toEqual({
    authenticated: false,
    expiresAt: null,
  });
});

test("restart details are opt-in so existing open tabs can still decode their strict receipts", async () => {
  const { request } = await fixture();
  const job = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "host-agent-test-token", {
        target: "host",
        reason: "Reviewed maintenance",
        requester: "Provider settings task",
      })
    ).json(),
  );
  const legacySchema = RestartJobSchema.omit({
    whenIdle: true,
    approvedAt: true,
    impact: true,
    requester: true,
  });
  const legacy = await (
    await request("/api/installation/owner/restarts/query", "owner-test-password", {})
  ).json();
  expect(legacySchema.array().parse(legacy)[0]?.id).toBe(job.id);
  const details = RestartJobSchema.array().parse(
    await (
      await request(
        "/api/installation/owner/restarts/query?idleRestarts=1",
        "owner-test-password",
        {},
      )
    ).json(),
  );
  expect(details[0]?.requester).toBe("Provider settings task");
});
