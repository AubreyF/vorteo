import { InstallationSkillPackages } from "./settings/skill-packages.js";
import type { InstallationPluginSourceResolver } from "./settings/runtime.js";
import { createInstallationSettingsReader } from "./settings/admission.js";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type Server, type IncomingMessage } from "node:http";
import pino from "pino";
import { hashDaemonPassword } from "../auth.js";
import { createInstallationServer } from "./server.js";
import { InstallationProfiles, type ProfileSharingState } from "./profiles/service.js";
import { createInstallationProfileReader } from "./profiles/admission.js";
import { InstallationSettingsService } from "./settings/service.js";
import { SettingsEnvironmentFake, SettingsJournalFake } from "./settings/fakes.js";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { ExecutionEnvironmentKind } from "@getpaseo/protocol/execution-installation";
import type { InstallationConfig } from "./config.js";
import { delegateToContainer, type DelegationClient } from "./delegation.js";
import {
  RestartJobSchema,
  InstallationUnlockSchema,
  InstallationProfilesSnapshotSchema,
} from "@getpaseo/protocol/execution-installation";

const cleanups: Array<() => Promise<void>> = [];

test("only the owner can prepare a pinned plugin source and preparation does not save settings", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const journal = new SettingsJournalFake();
  const settings = new InstallationSettingsService(journal, [host, guest]);
  await settings.reconcile();
  const saved = settings.snapshot();
  const resolved = {
    kind: "git" as const,
    id: "review",
    identity: { kind: "git" as const, remote: "https://example.test/plugin.git", pluginPath: "." },
    target: { kind: "git" as const, commit: "a".repeat(40) },
  };
  const resolveSource = vi.fn(async () => resolved);
  const { request } = await fixture(undefined, settings, resolveSource);
  const route = "/api/installation/owner/settings/plugins/resolve";
  const input = { source: "owner/plugin", ref: "stable" };
  expect((await request(route, "guest-agent-test-token", input)).status).toBe(401);
  expect((await request(route, "host-agent-test-token", input)).status).toBe(401);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  expect(
    (await request(route, undefined, input, "https://foreign.example.test", cookie)).status,
  ).toBe(403);
  expect(resolveSource).not.toHaveBeenCalled();
  const prepared = await request(route, undefined, input, undefined, cookie);
  expect(prepared.status).toBe(200);
  expect(await prepared.json()).toEqual(resolved);
  expect(resolveSource).toHaveBeenCalledWith(input);
  expect(settings.snapshot()).toEqual(saved);
  expect(host.plugins).toEqual([]);
  expect(guest.plugins).toEqual([]);
});

test("personal skill preparation requires owner access and leaves the shared catalog unchanged", async () => {
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [
    new SettingsEnvironmentFake("host-id"),
    new SettingsEnvironmentFake("guest-id"),
  ]);
  await settings.reconcile();
  const original = settings.snapshot();
  const source = {
    repository: "owner/repo",
    revision: "a".repeat(40),
    directory: "skills/example",
  };
  const definition = {
    name: "example",
    source,
    sha256: "b".repeat(64),
    identity: "github:owner/repo/skills/example",
  };
  const prepared = {
    definition,
    package: {
      name: definition.name,
      source,
      sha256: definition.sha256,
      files: [{ path: "SKILL.md", content: "cmV2aWV3", executable: false }],
    },
  };
  const prepare = vi
    .spyOn(InstallationSkillPackages.prototype, "prepare")
    .mockResolvedValue(prepared);
  const read = vi
    .spyOn(InstallationSkillPackages.prototype, "read")
    .mockReturnValue(prepared.package);
  try {
    const { request } = await fixture(undefined, settings);
    const route = "/api/installation/owner/settings/skills/prepare";
    for (const token of [undefined, "guest-agent-test-token", "host-agent-test-token"])
      expect((await request(route, token, { source })).status).toBe(401);
    const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
    const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing owner cookie");
    expect(
      (await request(route, undefined, { source }, "https://foreign.example.test", cookie)).status,
    ).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(
      (
        await request(
          route,
          undefined,
          { source: { ...source, revision: "main" } },
          undefined,
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
    const response = await request(route, undefined, { source }, undefined, cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(prepared);
    expect(prepare).toHaveBeenCalledWith(source);
    const packageRoute = "/api/installation/owner/settings/skills/package";
    expect((await request(packageRoute, "guest-agent-test-token", { definition })).status).toBe(
      401,
    );
    expect(
      (
        await request(
          packageRoute,
          undefined,
          { definition },
          "https://foreign.example.test",
          cookie,
        )
      ).status,
    ).toBe(403);
    expect(read).not.toHaveBeenCalled();
    const content = await request(packageRoute, undefined, { definition }, undefined, cookie);
    expect(content.status).toBe(200);
    expect(await content.json()).toEqual({ package: prepared.package });
    expect(read).toHaveBeenCalledWith(definition);
    expect(settings.snapshot()).toEqual(original);
  } finally {
    read.mockRestore();
    prepare.mockRestore();
  }
});

test("shared settings require owner access and persist revisioned writes before offline delivery", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  const guest = new SettingsEnvironmentFake("guest-id");
  const journal = new SettingsJournalFake();
  const settings = new InstallationSettingsService(journal, [host, guest]);
  await settings.reconcile();
  const { request, url } = await fixture(undefined, settings);
  const readRoute = "/api/installation/owner/settings/read";
  const skillPreviewRoute = "/api/installation/owner/settings/skills/preview";
  const selection = { mode: "custom", skills: ["alpha"] };
  expect((await request(skillPreviewRoute, "guest-agent-test-token", { selection })).status).toBe(
    401,
  );
  expect((await request(readRoute, "guest-agent-test-token", {})).status).toBe(401);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  host.skillOps = [{ kind: "delete", name: "beta" }];
  const preview = await request(skillPreviewRoute, undefined, { selection }, undefined, cookie);
  expect(preview.status).toBe(200);
  expect((await preview.json()).sources["host-id"].confirmationRequired).toEqual({
    removals: ["beta"],
  });
  expect(host.patches).toEqual([]);
  host.skillOps = [];
  expect(
    (await request(readRoute, undefined, {}, "https://foreign.example.test", cookie)).status,
  ).toBe(403);
  const snapshot = InstallationSettingsSnapshotSchema.parse(
    await (await request(readRoute, undefined, {}, undefined, cookie)).json(),
  );
  expect(
    (await request("/api/installation/settings/admission", "owner-test-password")).status,
  ).toBe(401);
  const hostAdmission = await (
    await request("/api/installation/settings/admission", "host-agent-test-token")
  ).json();
  expect(hostAdmission).toMatchObject({
    serverId: "host-id",
    environment: "host",
    revision: snapshot.revision,
    settings: snapshot.settings,
  });
  expect(hostAdmission.installationInstructions).toContain("installation-maintenance/SKILL.md");
  const guestAdmission = await (
    await request("/api/installation/settings/admission", "guest-agent-test-token")
  ).json();
  expect(guestAdmission).toMatchObject({
    serverId: "guest-id",
    environment: "container",
    installationInstructions: "",
    settings: snapshot.settings,
  });
  const clientDirectory = mkdtempSync(path.join(tmpdir(), "settings-admission-client-"));
  cleanups.push(async () => rmSync(clientDirectory, { recursive: true, force: true }));
  const clientFile = path.join(clientDirectory, "client.json");
  writeFileSync(
    clientFile,
    JSON.stringify({ origin: url, token: "host-agent-test-token", kind: "host-agent" }),
  );
  expect(
    await createInstallationSettingsReader(clientFile).read({ ...hostAdmission, revision: 1 }),
  ).toEqual(hostAdmission);
  guest.offline = true;
  const update = {
    expectedRevision: snapshot.revision,
    settings: { appendSystemPrompt: "Shared owner instructions" },
  };
  const patch = () =>
    fetch(`${url}/api/installation/owner/settings`, {
      method: "PATCH",
      headers: {
        Host: "owner.example.test",
        Origin: "https://owner.example.test",
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
    });
  const response = await patch();
  expect(response.status).toBe(200);
  const saved = InstallationSettingsSnapshotSchema.parse(await response.json());
  expect(journal.state).toEqual(saved);
  expect(saved.settings?.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
  expect(saved.sources["guest-id"].pendingRevision).toBe(saved.revision);
  expect((await patch()).status).toBe(409);
  await settings.reconcile();
  expect(host.config.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
  expect(settings.snapshot().sources["guest-id"].error).toBe("read_failed");
  guest.offline = false;
  await settings.reconcile();
  expect(guest.config.appendSystemPrompt).toBe(update.settings.appendSystemPrompt);
});

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

async function fixture(
  profiles?: InstallationProfiles,
  settings?: InstallationSettingsService,
  resolvePluginSource?: InstallationPluginSourceResolver,
) {
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
    profiles,
    settings,
    resolvePluginSource,
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

async function canonicalProfiles() {
  let state: ProfileSharingState | null = null;
  const kinds: ExecutionEnvironmentKind[] = ["host", "container"];
  const environments = kinds.map((kind) => {
    let config = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      sharedProviderPreferences: {
        version: 1,
        revision: 1,
        legacyProfiles: {},
        providers: {
          codex: {
            defaults: {},
            preferredModels: [],
            preferredThinkingOptions: [],
            workflows: [{ id: "review", name: "Review", provider: "codex", model: "astra" }],
            defaultWorkflowId: "review",
          },
        },
      },
    });
    return {
      kind,
      serverId: kind === "host" ? "host-id" : "guest-id",
      async read() {
        return structuredClone(config);
      },
      async patch(patch: import("@getpaseo/protocol/messages").MutableDaemonConfigPatch) {
        if (
          !patch.sharedProviderPreferences ||
          patch.expectedProviderPreferencesRevision !== config.sharedProviderPreferences?.revision
        )
          throw new Error("revision mismatch");
        config = {
          ...config,
          sharedProviderPreferences: {
            ...patch.sharedProviderPreferences,
            revision: patch.sharedProviderPreferences.revision + 1,
          },
        };
        return structuredClone(config);
      },
    };
  });
  const profiles = new InstallationProfiles(
    {
      read: () => structuredClone(state),
      write: (next) => {
        state = structuredClone(next);
      },
      backup: () => {},
    },
    environments,
    "00000000-0000-4000-8000-000000000001",
  );
  await profiles.synchronize();
  return profiles;
}

test("owner canonical profile GET/PATCH use independent revisions and reject stale or guest writes", async () => {
  const profiles = await canonicalProfiles();
  const { request, url } = await fixture(profiles);
  const route = "/api/installation/owner/profiles";
  expect((await request(route, "guest-agent-test-token")).status).toBe(401);
  expect(
    (await request(route, "owner-test-password", undefined, "https://foreign.example.test")).status,
  ).toBe(403);
  const unlock = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlock.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("missing owner cookie");
  const noOrigin = await fetch(`${url}${route}`, {
    headers: { Host: "owner.example.test", Cookie: cookie },
  });
  expect(noOrigin.status).toBe(403);
  const get = await request(`${route}/read`, undefined, {}, undefined, cookie);
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("no-store");
  const snapshot = InstallationProfilesSnapshotSchema.parse(await get.json());
  const providers = structuredClone(snapshot.providers);
  providers.codex.workflows[0].excludedEnvironments = ["host"];
  async function patch(expectedRevision: number) {
    return fetch(`${url}${route}`, {
      method: "PATCH",
      headers: {
        Host: "owner.example.test",
        Origin: "https://owner.example.test",
        Cookie: cookie ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedRevision, providers }),
    });
  }
  const saved = await patch(snapshot.revision);
  expect(saved.status).toBe(200);
  expect(InstallationProfilesSnapshotSchema.parse(await saved.json()).revision).toBe(
    snapshot.revision + 1,
  );
  expect((await patch(snapshot.revision)).status).toBe(409);
  const final = InstallationProfilesSnapshotSchema.parse(
    await (await request(route, undefined, undefined, undefined, cookie)).json(),
  );
  expect(final.providers).toEqual(providers);
});

test("fixed admission transport pins installation and environment and rejects stale responses", async () => {
  const profiles = await canonicalProfiles();
  const { request, root, url } = await fixture(profiles);
  const configFile = path.join(root, "admission-client.json");
  writeFileSync(
    configFile,
    JSON.stringify({ origin: url, token: "host-agent-test-token", kind: "host-agent" }),
    { mode: 0o600 },
  );
  const reader = createInstallationProfileReader(configFile);
  const admission = await (
    await request("/api/installation/profiles/admission", "host-agent-test-token")
  ).json();
  const binding = {
    installationId: admission.installationId,
    serverId: "host-id",
    environment: "host" as const,
    revision: 1,
  };
  expect((await reader.read(binding)).providers).toEqual(profiles.snapshot()?.providers);
  await expect(reader.read({ ...binding, serverId: "guest-id" })).rejects.toThrow(
    "different installation or environment",
  );
  await expect(reader.read({ ...binding, environment: "container" })).rejects.toThrow(
    "does not match the daemon launcher",
  );
  await expect(reader.read({ ...binding, revision: 100 })).rejects.toThrow("stale revision");
  expect(
    (await request("/api/installation/profiles/admission", "owner-test-password")).status,
  ).toBe(401);
});

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
