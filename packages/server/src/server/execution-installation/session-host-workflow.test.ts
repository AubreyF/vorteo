import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test, vi } from "vitest";
import {
  RestartDecisionSchema,
  RestartJobSchema,
  RestartRequestSchema,
} from "@getpaseo/protocol/execution-installation";
import type {
  SessionHostJob,
  SessionHostOperation,
  SessionHostPlan,
} from "@getpaseo/protocol/session-host-maintenance";
import { hashDaemonPassword } from "../auth.js";
import type { InstallationConfig } from "./config.js";
import { coordinatorLifecycleWork } from "./coordinator-bootstrap.js";
import { parseLifecycleJournal, type LifecycleJob } from "./lifecycle-journal.js";
import { InstallationRestarts, type RestartExecutor, type RestartJournal } from "./restarts.js";
import { createInstallationServer } from "./server.js";
import { SessionHostJobError } from "./session-host-job.js";

const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

function plan(operation: SessionHostOperation, pathValue = "/usr/bin:/bin"): SessionHostPlan {
  return {
    version: 1,
    operation,
    installationId: INSTALLATION_ID,
    label: `local.vorteo.${INSTALLATION_ID}.session-host`,
    serviceDomain: "gui/501",
    plistPath: `/fixture/LaunchAgents/local.vorteo.${INSTALLATION_ID}.session-host.plist`,
    plistSha256: "a".repeat(64),
    node: "/usr/local/bin/node",
    entrypoint: "/fixture/current/packages/server/dist/scripts/session-host-entrypoint.js",
    paseoHome: "/fixture/home",
    logPath: "/fixture/home/session-host/launchd.log",
    workingDirectory: "/fixture/current/packages/server",
    environment: { HOME: "/Users/owner", PATH: pathValue },
  };
}

function fixture(extras: Partial<RestartExecutor> = {}) {
  let records: LifecycleJob[] = [];
  const journal: RestartJournal = {
    read: () => structuredClone(records),
    write: (jobs) => {
      records = parseLifecycleJournal(jobs);
    },
  };
  let pathValue = "/usr/bin:/bin";
  const apply = vi.fn(
    async (job: SessionHostJob, report: (stage: "applying" | "verifying") => void) => {
      report("applying");
      report("verifying");
      return job.operation === "session-host-install"
        ? { detail: "installed", host: { pid: 4242 } }
        : { detail: "removed", forced: true };
    },
  );
  const executor: RestartExecutor = {
    restart: vi.fn(async () => "ready"),
    sessionHostPlan: vi.fn(async (operation: SessionHostOperation) => plan(operation, pathValue)),
    applySessionHost: apply,
    inspectSessionHost: vi.fn(async () => ({ supported: true, installed: false })),
    ...extras,
  };
  // The trusted Host policy approves Host restart requests automatically; never this job.
  const queue = new InstallationRestarts(journal, executor, Date.now, {
    hostRequestsAfter: "2026-01-01T00:00:00.000Z",
  });
  return {
    queue,
    journal,
    executor,
    apply,
    changePath: (next: string) => {
      pathValue = next;
    },
    request: (operation: SessionHostOperation = "session-host-install") =>
      queue.requestSessionHost(
        { id: randomUUID(), operation, reason: "Durable sessions acceptance" },
        "host-agent",
      ),
  };
}

const decision = (job: SessionHostJob, action: "approve" | "cancel" = "approve") => ({
  operation: job.operation,
  id: job.id,
  revision: job.revision,
  planSha256: job.planSha256,
  decision: action,
});

test("only the owner's exact decision approves; restart decisions and Host trust never do", async () => {
  const f = fixture();
  const job = await f.request();
  expect(job).toMatchObject({ status: "pending", stage: "prepared", requestedBy: "host-agent" });
  await f.queue.drain();
  expect(f.apply).not.toHaveBeenCalled();
  for (const change of [
    { revision: randomUUID() },
    { planSha256: "f".repeat(64) },
    { operation: "session-host-remove" },
  ])
    expect(() => f.queue.decideSessionHost({ ...decision(job), ...change })).toThrow(
      "Session host request changed",
    );
  expect(() => f.queue.decide(job.id, job.revision, "approve")).toThrow();
  await f.queue.drain();
  expect(f.queue.listSessionHosts()[0]?.status).toBe("pending");
  f.queue.decideSessionHost(decision(job));
  await f.queue.drain();
  await f.queue.drain();
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.queue.listSessionHosts()[0]).toMatchObject({
    status: "succeeded",
    stage: "succeeded",
    detail: "installed",
    host: { pid: 4242 },
  });
  expect(f.executor.restart).not.toHaveBeenCalled();
});

test("restart schemas reject the session host target, decision and job", async () => {
  const f = fixture();
  const job = await f.request();
  expect(() => RestartRequestSchema.parse({ target: job.target, reason: job.reason })).toThrow();
  expect(() => RestartDecisionSchema.parse(decision(job))).toThrow();
  expect(() => RestartJobSchema.parse(job)).toThrow();
  expect(parseLifecycleJournal([job])).toEqual([job]);
});

test("one request may be open at a time, and a retried request returns the same job", async () => {
  const f = fixture();
  const input = { id: randomUUID(), operation: "session-host-install", reason: "Install" } as const;
  const job = await f.queue.requestSessionHost(input, "owner");
  await expect(f.queue.requestSessionHost(input, "owner")).resolves.toEqual(job);
  await expect(
    f.queue.requestSessionHost({ ...input, reason: "Something else" }, "owner"),
  ).rejects.toThrow("different work");
  await expect(f.request("session-host-remove")).rejects.toThrow(
    "Another session host request is still open",
  );
  f.queue.decideSessionHost(decision(job, "cancel"));
  expect(f.queue.listSessionHosts()[0]?.status).toBe("rejected");
  await f.queue.drain();
  expect(f.apply).not.toHaveBeenCalled();
  const removal = await f.request("session-host-remove");
  expect(removal.plan.operation).toBe("session-host-remove");
});

test("dispatch recomputes the plan and changes nothing when it differs", async () => {
  const f = fixture();
  const job = await f.request();
  f.queue.decideSessionHost(decision(job));
  f.changePath("/tmp/elsewhere:/usr/bin");
  await f.queue.drain();
  expect(f.apply).not.toHaveBeenCalled();
  expect(f.queue.listSessionHosts()[0]).toMatchObject({
    status: "failed",
    stage: "failed",
    detail:
      "The session host plan changed after approval. Nothing was changed; prepare and review a new request.",
  });
});

test.each(["approved", "running"] as const)(
  "a coordinator restart never replays a %s operation",
  async (status) => {
    const f = fixture();
    const job = await f.request();
    f.journal.write([
      { ...job, status, stage: status === "running" ? "applying" : "prepared" },
    ] as LifecycleJob[]);
    // A coordinator replacement waits for it, like other native lifecycle work.
    expect(coordinatorLifecycleWork(f.journal.read())).toHaveLength(1);
    const resumed = new InstallationRestarts(f.journal, f.executor);
    await resumed.drain();
    expect(f.apply).not.toHaveBeenCalled();
    expect(resumed.listSessionHosts()[0]).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("The coordinator restarted before this operation finished."),
    });
    expect(coordinatorLifecycleWork(f.journal.read())).toHaveLength(0);
  },
);

test("failures show owner-written reasons and hide anything else", async () => {
  const refuse = fixture({
    applySessionHost: async () => {
      throw new SessionHostJobError("Turn the durable sessions setting off first.");
    },
  });
  const refused = await refuse.request("session-host-remove");
  refuse.queue.decideSessionHost(decision(refused));
  await refuse.queue.drain();
  expect(refuse.queue.listSessionHosts()[0]?.detail).toBe(
    "Turn the durable sessions setting off first.",
  );
  const crash = fixture({
    applySessionHost: async () => {
      throw new Error("EACCES /private/state/token");
    },
  });
  const crashed = await crash.request();
  crash.queue.decideSessionHost(decision(crashed));
  await crash.queue.drain();
  expect(crash.queue.listSessionHosts()[0]?.detail).toBe(
    "The session host operation failed. Inspect its status before retrying.",
  );
});

test("a forced stop is recorded on the removal", async () => {
  const f = fixture();
  const job = await f.request("session-host-remove");
  f.queue.decideSessionHost(decision(job));
  await f.queue.drain();
  expect(f.queue.listSessionHosts()[0]).toMatchObject({ status: "succeeded", forcedStop: true });
});

test("without a session host executor, requests are refused", async () => {
  const f = fixture({ sessionHostPlan: undefined, applySessionHost: undefined });
  expect(f.queue.sessionHostAvailable()).toBe(false);
  await expect(f.request()).rejects.toThrow("Session host maintenance is unavailable");
});

test("only the session host job names its launchd label or manages production labels", () => {
  // Host restarts, source updates and supervisor maintenance name their own services, so none
  // of them can stop or replace the session host. Update this pin only with that guarantee.
  const repository = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)));
  const files = [
    "packages/server/src/server/execution-installation/daemon.ts",
    "packages/server/src/server/execution-installation/source-updates.ts",
    "packages/server/src/server/execution-installation/restarts.ts",
    "packages/server/src/server/execution-installation/coordinator-bootstrap-native.ts",
    "packages/server/src/server/execution-installation/maintenance/host-supervisor-execution.ts",
    "packages/server/src/server/session-host/launchd.ts",
  ];
  for (const file of files) {
    const source = readFileSync(path.join(repository, file), "utf8");
    expect(source, file).not.toMatch(/\.session-host[`"']/);
    expect(source, file).not.toContain("allowProductionLabel: true");
  }
  const job = readFileSync(
    path.join(repository, "packages/server/src/server/execution-installation/session-host-job.ts"),
    "utf8",
  );
  expect(job).toContain("allowProductionLabel: true");
});

test("HTTP routes keep requests on the Host token and decisions on owner buttons", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "session-host-http-")));
  await writeFile(path.join(dir, "index.html"), "<html><head></head></html>");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const apply = vi.fn(async () => ({ detail: "installed", host: { pid: 4242 } }));
  const inspect = vi.fn(async (detail: boolean) => ({
    supported: true,
    installed: true,
    ...(detail
      ? {
          detail: {
            label: `local.vorteo.${INSTALLATION_ID}.session-host`,
            plist: "matching" as const,
            loaded: true,
            pid: 4242,
            lastExitStatus: null,
            runs: 1,
            host: { pid: 4242, sessions: 0 },
            settingEnabled: false,
            observedAt: new Date().toISOString(),
          },
        }
      : {}),
  }));
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: INSTALLATION_ID,
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: dir,
    stateDir: dir,
    ownerPasswordHash: hashDaemonPassword("owner"),
    hostAgentTokenHash: digest("host"),
    containerAgentTokenHash: digest("guest"),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-pass",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: "127.0.0.1:6768", password: "dev-pass" },
  };
  const app = createInstallationServer(
    config,
    {
      restart: async () => {
        throw Error("No daemon restart");
      },
      sessionHostPlan: async (operation) => plan(operation),
      applySessionHost: apply,
      inspectSessionHost: inspect,
    },
    pino({ level: "silent" }),
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("Missing test address");
  config.listenPort = address.port;
  const request = (
    route: string,
    token?: string,
    body?: unknown,
    origin = "https://owner.example.test",
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/installation/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        origin,
        Host: "owner.example.test",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const input = { id: randomUUID(), operation: "session-host-install", reason: "Acceptance" };
    expect((await request("session-host-requests", "guest", input)).status).toBe(401);
    expect((await request("owner/session-host/query", "host", {})).status).toBe(401);
    const capability = await (await request("capabilities", "host")).json();
    expect(capability.sessionHostJob).toEqual({ available: true, ownerApprovalRequired: true });
    const guestCapability = await (await request("capabilities", "guest")).json();
    expect(guestCapability.sessionHostJob.available).toBe(false);
    // Dev sees whether the job exists, never its detail; the host is asked only for detail.
    expect(await (await request("session-host", "guest")).json()).toEqual({
      supported: true,
      installed: true,
    });
    expect(inspect).toHaveBeenLastCalledWith(false);
    expect((await (await request("session-host", "host")).json()).detail.pid).toBe(4242);
    const submitted = await request("session-host-requests", "host", input);
    expect(submitted.status).toBe(201);
    const job = (await submitted.json()) as SessionHostJob;
    expect(job).toMatchObject({ status: "pending", requestedBy: "host-agent" });
    expect((await (await request("restart-summary")).json()).sessionHost).toEqual({
      requested: 1,
      queued: 0,
      running: 0,
    });
    expect((await request(`session-host-requests/${job.id}`, "guest")).status).toBe(401);
    const query = await (await request("owner/session-host/query", "owner", {})).json();
    expect(query.jobs).toEqual([job]);
    expect(query.status.detail.plist).toBe("matching");
    expect((await request("owner/session-host/decision", "host", decision(job))).status).toBe(401);
    expect(
      (
        await request(
          "owner/session-host/decision",
          "owner",
          decision(job),
          "https://foreign.example.test",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request("owner/session-host/decision", "owner", {
          ...decision(job),
          planSha256: "f".repeat(64),
        })
      ).status,
    ).toBe(409);
    expect(apply).not.toHaveBeenCalled();
    const approved = await request("owner/session-host/decision", "owner", decision(job));
    expect(approved.status).toBe(200);
    await app.drainRestarts();
    expect(apply).toHaveBeenCalledTimes(1);
    expect((await (await request(`session-host-requests/${job.id}`, "host")).json()).status).toBe(
      "succeeded",
    );
    // An owner request is recorded as the owner's.
    const owned = await request("owner/session-host/request", "owner", {
      id: randomUUID(),
      operation: "session-host-remove",
      reason: "Requested by the owner from Installation controls.",
    });
    expect(owned.status).toBe(201);
    expect((await owned.json()).requestedBy).toBe("owner");
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("owner status is null, not an error, when the job cannot be inspected", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "session-host-status-")));
  await writeFile(path.join(dir, "index.html"), "<html><head></head></html>");
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const config: InstallationConfig = {
    public: {
      version: 1,
      installationId: INSTALLATION_ID,
      origin: "https://owner.example.test",
      environments: [
        { kind: "host", serverId: "host", endpoint: "host.example.test", useTls: true },
        { kind: "container", serverId: "dev", endpoint: "dev.example.test", useTls: true },
      ],
    },
    listenPort: 6770,
    webDistDir: dir,
    stateDir: dir,
    ownerPasswordHash: hashDaemonPassword("owner"),
    hostAgentTokenHash: digest("host"),
    containerAgentTokenHash: digest("guest"),
    host: {
      endpoint: "127.0.0.1:6771",
      password: "host-pass",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: "127.0.0.1:6768", password: "dev-pass" },
  };
  const app = createInstallationServer(
    config,
    {
      restart: async () => "ready",
      sessionHostPlan: async (operation) => plan(operation),
      applySessionHost: async () => ({ detail: "installed" }),
      inspectSessionHost: async () => {
        throw new Error("launchctl unavailable");
      },
    },
    pino({ level: "silent" }),
  );
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("Missing test address");
  config.listenPort = address.port;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/installation/owner/session-host/query`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer owner",
          origin: "https://owner.example.test",
          Host: "owner.example.test",
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [], status: null });
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
