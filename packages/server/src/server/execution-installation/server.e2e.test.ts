import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RestartExecutor } from "./restarts.js";
import { NativeHelperJobSchema } from "@getpaseo/protocol/native-helper-maintenance";
import type { ClaudeSetupRuntime } from "./accounts/claude-setup-runtime.js";
import { InstallationSkillPackages } from "./settings/skill-packages.js";
import type { InstallationPluginSourceResolver } from "./settings/runtime.js";
import { createInstallationSettingsReader } from "./settings/admission.js";
import { InstallationSourceUpdates } from "./source-updates.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type Server, type IncomingMessage } from "node:http";
import pino from "pino";
import { hashDaemonPassword } from "../auth.js";
import { createInstallationServer, type InstallationStartupFence } from "./server.js";
import { InstallationProfiles, type ProfileSharingState } from "./profiles/service.js";
import { createInstallationProfileReader } from "./profiles/admission.js";
import { InstallationSettingsService } from "./settings/service.js";
import { SettingsEnvironmentFake, SettingsJournalFake } from "./settings/fakes.js";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type {
  RestartImpact,
  ExecutionEnvironmentKind,
} from "@getpaseo/protocol/execution-installation";
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
    origin: "agent",
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
  sourceUpdates: boolean | "both" = false,
  automaticHost = false,
  claudeSetup?: ClaudeSetupRuntime,
  startupFence?: InstallationStartupFence,
  helperExecutor?: Pick<
    RestartExecutor,
    "validateHelperPlan" | "installHelper" | "verifyHelperRecovery"
  >,
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
  if (automaticHost)
    config.restartApprovalPolicy = { hostRequestsAfter: new Date(0).toISOString() };
  if (sourceUpdates) {
    const release = path.join(root, "release");
    mkdirSync(release);
    writeFileSync(
      path.join(release, ".installation-source.json"),
      JSON.stringify({ sourceCommit: "b".repeat(40) }),
    );
    writeFileSync(
      path.join(root, "release.json"),
      JSON.stringify({ sourceCommit: "b".repeat(40) }),
    );
    const link = path.join(root, "current");
    symlinkSync(release, link);
    config.sourceUpdates = {
      sourceRepository: root,
      releaseRoot: root,
      currentReleaseLink: link,
      webDirectory: root,
      toolingDirectory: root,
      integrationRef: "refs/heads/main",
    };
  }
  if (sourceUpdates === "both") {
    const docker = path.join(root, "docker-fixture");
    writeFileSync(
      docker,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({release:"/dev/releases/base",sourceCommit:"${"c".repeat(40)}"}));`,
    );
    chmodSync(docker, 0o700);
    const receiptFile = path.join(root, "dev-source.json");
    writeFileSync(receiptFile, JSON.stringify({ sourceCommit: "c".repeat(40) }));
    config.containerSourceUpdates = {
      docker,
      receiptFile,
      sourceRepository: root,
      toolingDirectory: path.resolve(import.meta.dirname, "../../../../../scripts"),
      integrationRef: "refs/heads/main",
      containerId: "d".repeat(64),
      user: "paseo",
      node: process.execPath,
      home: "/dev/home",
      releaseRoot: "/dev/releases",
      currentReleaseLink: "/dev/releases/current",
    };
  }
  const calls: string[] = [];
  const app = createInstallationServer(
    config,
    {
      ...(automaticHost
        ? {
            inspect: async (target: RestartImpact["target"]): Promise<RestartImpact> => ({
              target,
              agents: [],
              pendingStarts: 1,
              checkedAt: new Date().toISOString(),
              idleRestartSupported: true,
            }),
            holdCurrentTurns: async () => {
              calls.push("hold");
            },
            releaseCurrentTurns: async () => {
              calls.push("release");
            },
            restartWhenIdle: async () => null,
          }
        : {}),
      ...helperExecutor,
      factoryRuntimePlan: () => "c".repeat(64),
      adoptFactoryRuntime: async () => {
        calls.push("factory-adoption");
        return "verified Factory adoption";
      },
      supervisorPlan: () => "a".repeat(64),
      restartSupervisor: async () => {
        calls.push("supervisor");
        return "verified supervisor";
      },
      restart: async (target) => {
        calls.push(target);
        return "verified ready";
      },
    },
    pino({ level: "silent" }),
    profiles,
    settings,
    resolvePluginSource,
    claudeSetup,
    startupFence,
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
  return {
    request,
    root,
    calls,
    drain: app.drainRestarts,
    url: `http://127.0.0.1:${address.port}`,
  };
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

test("both request credentials join and observe the same target receipt without approving it", async () => {
  const { request, calls } = await fixture();
  const first = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "host-agent-test-token", {
        target: "host",
        reason: "Prepared first update",
      })
    ).json(),
  );
  const joined = RestartJobSchema.parse(
    await (
      await request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "host",
        reason: "Prepared complementary update",
      })
    ).json(),
  );
  expect(joined).toEqual(first);
  for (const token of ["host-agent-test-token", "guest-agent-test-token"]) {
    const response = await request(`/api/installation/restart-requests/${first.id}`, token);
    expect(response.status).toBe(200);
    expect(RestartJobSchema.parse(await response.json()).status).toBe("pending");
    expect(
      (
        await request(`/api/installation/owner/restarts/${first.id}/decision`, token, {
          revision: first.revision,
          decision: "approve",
        })
      ).status,
    ).toBe(401);
  }
  expect(
    (await request(`/api/installation/restart-requests/${first.id}`, "invalid-token")).status,
  ).toBe(401);
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

test("legacy owner clients can read removed providers but cannot resurrect them", async () => {
  const host = new SettingsEnvironmentFake("host-id");
  host.config.providers = { mock: { enabled: true } };
  const settings = new InstallationSettingsService(new SettingsJournalFake(), [host]);
  const initial = await settings.reconcile();
  const definitions = initial.settings!.providerDefinitions!;
  for (const provider of definitions) {
    provider.removed = true;
    provider.policy.enabled = false;
  }
  const saved = await settings.update({
    expectedRevision: initial.revision,
    settings: { providerDefinitions: definitions },
  });
  const { url } = await fixture(undefined, settings);
  const headers = {
    Host: "owner.example.test",
    Origin: "https://owner.example.test",
    Authorization: "Bearer owner-test-password",
    "Content-Type": "application/json",
  };
  const legacy = await (
    await fetch(`${url}/api/installation/owner/settings/read`, {
      method: "POST",
      headers,
      body: "{}",
    })
  ).json();
  expect(legacy.settings.providerDefinitions[0]).not.toHaveProperty("removed");
  expect(legacy.settings.providerDefinitions[0].policy.enabled).toBe(false);
  const rejected = await fetch(`${url}/api/installation/owner/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedRevision: saved.revision,
      settings: { providerDefinitions: legacy.settings.providerDefinitions },
    }),
  });
  expect(rejected.status).toBe(409);
  expect(settings.snapshot().settings!.providerDefinitions![0].removed).toBe(true);
  const aware = await (
    await fetch(`${url}/api/installation/owner/settings/read`, {
      method: "POST",
      headers: { ...headers, "X-Vorteo-Provider-Removal": "1" },
      body: "{}",
    })
  ).json();
  expect(aware.settings.providerDefinitions[0].removed).toBe(true);
  const restored = await fetch(`${url}/api/installation/owner/settings`, {
    method: "PATCH",
    headers: { ...headers, "X-Vorteo-Provider-Removal": "1" },
    body: JSON.stringify({
      expectedRevision: saved.revision,
      settings: {
        providerDefinitions: definitions.map((provider) =>
          Object.assign({}, provider, { removed: false }),
        ),
      },
    }),
  });
  expect(restored.status).toBe(200);
  expect(settings.snapshot().settings!.providerDefinitions![0].removed).toBe(false);
});

test("uploaded source stays inert until the owner approves its exact digest; legacy approval cannot install", async () => {
  const install = vi
    .spyOn(InstallationSourceUpdates.prototype, "install")
    .mockResolvedValue("installed and verified");
  try {
    const { request, url } = await fixture(undefined, undefined, undefined, true);
    const bundle = Buffer.from("inert test bundle");
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    const body = { request: { target: "host", reason: "Review source update" }, update };
    const upload = (token: string, metadata = body) =>
      fetch(`${url}/api/installation/source-update-requests`, {
        method: "POST",
        headers: {
          Host: "owner.example.test",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
        },
        body: bundle,
      });
    expect((await upload("wrong-token")).status).toBe(401);
    expect(
      (await request("/api/installation/update-source", "guest-agent-test-token")).status,
    ).toBe(200);
    const uploaded = await upload("guest-agent-test-token");
    expect(uploaded.status).toBe(201);
    const job = RestartJobSchema.parse(await uploaded.json());
    expect(job.update).toEqual(update);
    expect(install).not.toHaveBeenCalled();
    expect((await upload("guest-agent-test-token")).status).toBe(409);
    const legacy = await request(
      "/api/installation/owner/restarts/query",
      "owner-test-password",
      {},
    );
    expect(await legacy.json()).toEqual([expect.not.objectContaining({ update })]);
    const decision = `/api/installation/owner/restarts/${job.id}/decision`;
    expect(
      (
        await request(decision, "guest-agent-test-token", {
          revision: job.revision,
          decision: "approve",
          updateSha256: update.sha256,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(decision, "owner-test-password", {
          revision: job.revision,
          decision: "approve",
        })
      ).status,
    ).toBe(409);
    expect(install).not.toHaveBeenCalled();
    const approved = await request(
      `${decision}?idleRestarts=1&sourceUpdates=1`,
      "owner-test-password",
      { revision: job.revision, decision: "approve", updateSha256: update.sha256 },
    );
    expect(approved.status).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
  } finally {
    install.mockRestore();
  }
});

test("old coordinators refuse source upload explicitly and a changed bundle never creates a job", async () => {
  const unavailable = await fixture();
  expect(
    (await unavailable.request("/api/installation/update-source", "guest-agent-test-token")).status,
  ).toBe(503);
  const { request, url } = await fixture(undefined, undefined, undefined, true);
  const metadata = {
    request: { target: "host", reason: "test" },
    update: {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: "c".repeat(64),
      bytes: 4,
    },
  };
  const response = await fetch(`${url}/api/installation/source-update-requests`, {
    method: "POST",
    headers: {
      Host: "owner.example.test",
      Authorization: "Bearer guest-agent-test-token",
      "Content-Type": "application/octet-stream",
      "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
    },
    body: Buffer.from("nope"),
  });
  expect(response.status).not.toBe(201);
  expect(
    await (
      await request("/api/installation/owner/restarts/query", "owner-test-password", {})
    ).json(),
  ).toEqual([]);
});

test("batch uploads retain scoped receipts and require a batch-aware exact owner approval", async () => {
  const install = vi
    .spyOn(InstallationSourceUpdates.prototype, "install")
    .mockResolvedValue("installed");
  const prepare = vi
    .spyOn(InstallationSourceUpdates.prototype, "prepare")
    .mockImplementation(async (contributions) => ({
      batch: {
        webCommit: "b".repeat(40),
        status: "ready",
        contributions: contributions.map((item) => ({ ...item, status: "included" })),
      },
      update: { ...contributions[0]!.update, sha256: String(contributions.length).repeat(64) },
    }));
  try {
    const { request, url } = await fixture(undefined, undefined, undefined, true);
    const bundle = Buffer.from("inert source contribution");
    const update = {
      sourceCommit: "a".repeat(40),
      baseCommit: "b".repeat(40),
      sha256: createHash("sha256").update(bundle).digest("hex"),
      bytes: bundle.length,
    };
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const upload = (id: string, token = "guest-agent-test-token") =>
      fetch(`${url}/api/installation/source-update-requests?sourceBatches=1`, {
        method: "POST",
        headers: {
          Host: "owner.example.test",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "x-vorteo-update": Buffer.from(
            JSON.stringify({
              request: { target: "host", reason: id },
              update,
              contributionId: id,
            }),
          ).toString("base64"),
        },
        body: bundle,
      });
    const replies = await Promise.all([upload(firstId), upload(secondId)]);
    expect(replies.map((reply) => reply.status)).toEqual([201, 201]);
    const [first, second] = await Promise.all(replies.map((reply) => reply.json()));
    expect(first.batch.id).toBe(second.batch.id);
    const receiptPath = `/api/installation/source-contributions/${firstId}`;
    expect((await request(receiptPath, "bad-token")).status).toBe(401);
    const read = async () => (await request(receiptPath, "guest-agent-test-token")).json();
    // A periodic drain retries preparation invalidated by the second upload.
    await vi.waitFor(async () => {
      const response = await request(
        "/api/installation/owner/restarts/query?sourceUpdates=1&sourceBatches=1",
        "owner-test-password",
        {},
      );
      const jobs = await response.json();
      expect(jobs[0].sourceBatch.contributions).toHaveLength(2);
    });
    // Trigger the same durable preparation path used by the coordinator's interval.
    const old = await read();
    if (old.batch.sourceBatch.status !== "ready") {
      // Idempotent retries retain the receipt and schedule another preparation.
      expect((await upload(firstId)).status).toBe(201);
    }
    await vi.waitFor(async () => expect((await read()).batch.sourceBatch.status).toBe("ready"));
    const receipt = await read();
    expect(receipt.contribution.update).toEqual(update);
    const decisionPath = `/api/installation/owner/restarts/${receipt.batch.id}/decision`;
    const exact = {
      revision: receipt.batch.revision,
      decision: "approve",
      updateSha256: receipt.batch.update.sha256,
    };
    expect(
      (await request(`${decisionPath}?sourceUpdates=1`, "owner-test-password", exact)).status,
    ).toBe(409);
    expect(
      (
        await request(`${decisionPath}?sourceBatches=1`, "owner-test-password", {
          ...exact,
          revision: first.batch.revision,
        })
      ).status,
    ).toBe(409);
    expect(install).not.toHaveBeenCalled();
    const legacy = await (
      await request("/api/installation/owner/restarts/query", "owner-test-password", {})
    ).json();
    expect(legacy[0].sourceBatch).toBeUndefined();
    expect(legacy[0].update).toBeUndefined();
    expect(
      (
        await request(
          `${decisionPath}?sourceBatches=1&sourceUpdates=1`,
          "owner-test-password",
          exact,
        )
      ).status,
    ).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect((await read()).batch.status).toBe("succeeded");
    expect((await upload(firstId)).status).toBe(201);
    expect(install).toHaveBeenCalledOnce();
    const next = await (await upload(crypto.randomUUID())).json();
    expect(next.batch.id).not.toBe(receipt.batch.id);
    expect(next.batch.status).toBe("pending");
  } finally {
    install.mockRestore();
    prepare.mockRestore();
  }
});

test("scoped Dev updates require target-aware owner review and never reuse Host approval", async () => {
  const { request, url, calls } = await fixture(undefined, undefined, undefined, "both");
  const capabilities = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect(await capabilities.json()).toMatchObject({
    ownerApprovalRequired: true,
    targets: [
      { target: "host", sourceUpdate: { available: true } },
      { target: "container-daemon", sourceUpdate: { available: true } },
    ],
  });
  const source = await request(
    "/api/installation/update-source?target=container-daemon",
    "guest-agent-test-token",
  );
  expect(await source.json()).toMatchObject({
    target: "container-daemon",
    baseCommit: "c".repeat(40),
    baseCandidates: ["c".repeat(40)],
  });
  const bundle = Buffer.from("inert Dev test bundle");
  const update = {
    sourceCommit: "a".repeat(40),
    baseCommit: "c".repeat(40),
    sha256: createHash("sha256").update(bundle).digest("hex"),
    bytes: bundle.length,
  };
  const metadata = {
    request: { target: "container-daemon", reason: "Prepare Dev update" },
    update,
  };
  const upload = (target: string) =>
    fetch(`${url}/api/installation/source-update-requests?target=${target}`, {
      method: "POST",
      headers: {
        Host: "owner.example.test",
        Authorization: "Bearer guest-agent-test-token",
        "Content-Type": "application/octet-stream",
        "x-vorteo-update": Buffer.from(JSON.stringify(metadata)).toString("base64"),
      },
      body: bundle,
    });
  expect((await upload("host")).status).toBe(400);
  const result = await upload("container-daemon");
  expect(result.status).toBe(201);
  const job = RestartJobSchema.parse(await result.json());
  const decision = { revision: job.revision, decision: "approve", updateSha256: update.sha256 };
  const route = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (await request(`${route}?containerSourceUpdates=1`, "guest-agent-test-token", decision)).status,
  ).toBe(401);
  expect(
    (await request(`${route}?sourceUpdates=1&sourceBatches=1`, "owner-test-password", decision))
      .status,
  ).toBe(409);
  const oldTab = await request(
    "/api/installation/owner/restarts/query?sourceUpdates=1&sourceBatches=1",
    "owner-test-password",
    {},
  );
  expect(await oldTab.json()).toEqual([expect.not.objectContaining({ update })]);
  expect(calls).toEqual([]);
});

test("capability discovery reports the Dev bootstrap blocker without exposing configuration", async () => {
  const { request } = await fixture();
  expect((await request("/api/installation/capabilities", "wrong")).status).toBe(401);
  const response = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect(await response.json()).toMatchObject({
    targets: [
      { target: "host", sourceUpdate: { available: false } },
      { target: "container-daemon", sourceUpdate: { available: false } },
    ],
  });
  expect(
    (
      await request(
        "/api/installation/update-source?target=container-daemon",
        "guest-agent-test-token",
      )
    ).status,
  ).toBe(503);
});

test("Factory adoption rejects guest requests and legacy approvals while preserving cancellation", async () => {
  const { request, calls } = await fixture();
  const plan = "c".repeat(64);
  const guest = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect((await guest.json()).factoryRuntimeAdoption).toEqual({
    available: false,
    ownerApprovalRequired: true,
  });
  const input = {
    target: "container-daemon",
    reason: "Reviewed Factory startup",
    factoryRuntimePlanSha256: plan,
  };
  expect(
    (await request("/api/installation/restart-requests", "guest-agent-test-token", input)).status,
  ).toBe(409);
  const created = await request(
    "/api/installation/restart-requests",
    "host-agent-test-token",
    input,
  );
  expect(created.status).toBe(201);
  const job = RestartJobSchema.parse(await created.json());
  expect(job.factoryRuntimePlanSha256).toBe(plan);
  const old = await request("/api/installation/owner/restarts/query", "owner-test-password", {});
  const visible = JSON.stringify(await old.json());
  expect(visible).toContain("Reload Vorteo");
  expect(visible).not.toContain("factoryRuntimePlanSha256");
  const route = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (await request(route, "owner-test-password", { revision: job.revision, decision: "approve" }))
      .status,
  ).toBe(409);
  expect(
    (await request(route, "owner-test-password", { revision: job.revision, decision: "reject" }))
      .status,
  ).toBe(200);
  expect(calls).toEqual([]);
});

test("Factory adoption dispatches only the exact reviewed operation through the owner route", async () => {
  const { request, calls } = await fixture();
  const plan = "c".repeat(64);
  const host = await request("/api/installation/capabilities", "host-agent-test-token");
  expect((await host.json()).factoryRuntimeAdoption).toEqual({
    available: true,
    sha256: plan,
    ownerApprovalRequired: true,
  });
  const created = await request("/api/installation/restart-requests", "host-agent-test-token", {
    target: "container-daemon",
    reason: "Reviewed Factory startup",
    factoryRuntimePlanSha256: plan,
  });
  const job = RestartJobSchema.parse(await created.json());
  const review = await request(
    "/api/installation/owner/restarts/query?factoryRuntimeAdoption=1",
    "owner-test-password",
    {},
  );
  expect(review.status).toBe(200);
  expect((await review.json()).find((entry: { id: string }) => entry.id === job.id)).toMatchObject({
    factoryRuntimePlanSha256: plan,
    revision: job.revision,
  });
  const response = await request(
    `/api/installation/owner/restarts/${job.id}/decision?factoryRuntimeAdoption=1`,
    "owner-test-password",
    {
      revision: job.revision,
      decision: "approve",
      factoryRuntimePlanSha256: plan,
    },
  );
  expect(response.status).toBe(200);
  await expect.poll(() => calls).toEqual(["factory-adoption"]);
  const status = await request(
    `/api/installation/restart-requests/${job.id}`,
    "host-agent-test-token",
  );
  expect((await status.json()).status).toBe("succeeded");
});

test("supervisor maintenance stays visible to old clients but requires exact owner review", async () => {
  const { request, calls } = await fixture();
  const input = {
    target: "container-daemon",
    reason: "Repair profile launcher",
    supervisorPlanSha256: "a".repeat(64),
  };
  const route = "/api/installation/restart-requests";
  expect((await request(route, "guest-agent-test-token", input)).status).toBe(409);
  const created = await request(route, "host-agent-test-token", input);
  expect(created.status).toBe(201);
  const job = RestartJobSchema.parse(await created.json());
  expect(job.supervisorPlanSha256).toBe(input.supervisorPlanSha256);
  expect(calls).toEqual([]);
  const unlocked = await request("/api/installation/owner/unlock", "owner-test-password", {});
  const cookie = unlocked.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Missing owner cookie");
  const old = await request(
    "/api/installation/owner/restarts/query",
    undefined,
    {},
    undefined,
    cookie,
  );
  expect(old.status).toBe(200);
  const visible = await old.json();
  expect(JSON.stringify(visible)).toContain("Reload Vorteo");
  expect(JSON.stringify(visible)).not.toContain("supervisorPlanSha256");
  const decision = `/api/installation/owner/restarts/${job.id}/decision`;
  expect(
    (
      await request(
        decision,
        undefined,
        { revision: job.revision, decision: "approve" },
        undefined,
        cookie,
      )
    ).status,
  ).toBe(409);
  const cancelled = await request(
    decision,
    undefined,
    { revision: job.revision, decision: "reject" },
    undefined,
    cookie,
  );
  expect(cancelled.status).toBe(200);
  expect(calls).toEqual([]);
});

test("supervisor capability is Host scoped and exact approval dispatches the maintenance executor", async () => {
  const { request, calls } = await fixture();
  const guest = await request("/api/installation/capabilities", "guest-agent-test-token");
  expect((await guest.json()).supervisorMaintenance).toEqual({ available: false });
  const host = await request("/api/installation/capabilities", "host-agent-test-token");
  const sha = "a".repeat(64);
  expect((await host.json()).supervisorMaintenance).toEqual({ available: true, sha256: sha });
  const created = await request("/api/installation/restart-requests", "host-agent-test-token", {
    target: "container-daemon",
    reason: "Reviewed fixture",
    supervisorPlanSha256: sha,
  });
  const job = RestartJobSchema.parse(await created.json());
  const response = await request(
    `/api/installation/owner/restarts/${job.id}/decision?supervisorMaintenance=1`,
    "owner-test-password",
    { revision: job.revision, decision: "approve", supervisorPlanSha256: sha },
  );
  expect(response.status).toBe(200);
  await expect.poll(() => calls).toEqual(["supervisor"]);
  const status = await request(
    `/api/installation/restart-requests/${job.id}`,
    "host-agent-test-token",
  );
  expect((await status.json()).status).toBe("succeeded");
});

test("automatic Host approval uses authenticated origin and hides metadata from legacy clients", async () => {
  const { request, calls, drain } = await fixture(undefined, undefined, undefined, false, true);
  const route = "/api/installation/restart-requests";
  const capabilities = "/api/installation/capabilities";
  expect(await (await request(capabilities, "host-agent-test-token")).json()).toMatchObject({
    ownerApprovalRequired: false,
    hostAutomaticRestarts: true,
  });
  expect(await (await request(capabilities, "guest-agent-test-token")).json()).toMatchObject({
    ownerApprovalRequired: true,
    hostAutomaticRestarts: true,
  });
  const guest = RestartJobSchema.parse(
    await (
      await request(route, "guest-agent-test-token", {
        target: "host",
        reason: "Dev update",
        requester: "host-agent",
      })
    ).json(),
  );
  await drain();
  expect(
    RestartJobSchema.parse(
      await (await request(`${route}/${guest.id}`, "guest-agent-test-token")).json(),
    ).status,
  ).toBe("pending");
  expect(calls).toEqual([]);
  expect(
    (
      await request(route, "guest-agent-test-token", {
        target: "host",
        reason: "Forged origin",
        requestedBy: "host-agent",
      })
    ).status,
  ).toBe(400);
  const host = RestartJobSchema.parse(
    await (
      await request(route, "host-agent-test-token", {
        target: "container-daemon",
        reason: "Trusted Host request",
      })
    ).json(),
  );
  await drain();
  const modern = RestartJobSchema.parse(
    await (
      await request(`${route}/${host.id}?hostAutomaticRestarts=1`, "host-agent-test-token")
    ).json(),
  );
  expect(modern.status).toBe("approved");
  expect(modern.requestedBy).toBe("host-agent");
  expect(modern.automaticApproval?.requestRevision).toBe(modern.revision);
  const legacy = await (await request(`${route}/${host.id}`, "host-agent-test-token")).json();
  expect(legacy).not.toHaveProperty("automaticApproval");
  expect(calls).toEqual(["hold"]);
  const canceled = await request(
    `/api/installation/owner/restarts/${host.id}/decision`,
    "owner-test-password",
    {
      revision: modern.revision,
      decision: "cancel",
    },
  );
  expect(canceled.status).toBe(200);
  await drain();
  expect(calls).toEqual(["hold", "release"]);
});

test("Claude setup login accepts only owner access and sanitizes code failures", async () => {
  const runtime: ClaudeSetupRuntime = {
    read: vi.fn(() => ({
      login: { status: "idle" },
      connection: { connected: false, environments: [] },
    })),
    start: vi.fn(async () => ({
      status: "starting",
      attemptId: "11111111-1111-4111-8111-111111111111",
    })),
    submit: vi.fn(async () => {
      throw Error("synthetic-private-code");
    }),
    cancel: vi.fn(async () => ({ status: "idle" })),
    signOut: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const { request } = await fixture(undefined, undefined, undefined, false, false, runtime);
  const root = "/api/installation/owner/claude/setup-token";
  for (const credential of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
    expect((await request(`${root}/start`, credential, { definitionId: "one" })).status).toBe(401);
  }
  expect(
    (
      await request(
        `${root}/start`,
        "owner-test-password",
        { definitionId: "one" },
        "https://foreign.example.test",
      )
    ).status,
  ).toBe(403);
  expect(runtime.start).not.toHaveBeenCalled();
  expect(
    (await request(`${root}/start`, "owner-test-password", { definitionId: "one" })).status,
  ).toBe(200);
  const rejected = await request(`${root}/submit`, "owner-test-password", {
    definitionId: "one",
    attemptId: "11111111-1111-4111-8111-111111111111",
    code: "synthetic-private-code",
  });
  expect(rejected.status).toBe(409);
  expect(JSON.stringify(await rejected.json())).not.toContain("synthetic-private-code");
});

test("bootstrap HTTP readiness stays fenced without journal writes or admitted operations", async () => {
  let released = false;
  let broken = false;
  const generation = randomUUID();
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, {
    generation,
    released: () => {
      if (broken) throw new Error("private failure");
      return released;
    },
  });
  const health = await f.request("/api/installation/health");
  expect(health.status).toBe(200);
  expect((await health.json()).bootstrap).toEqual({ generation, pid: process.pid, fenced: true });
  for (const route of [
    "/api/installation/restart-requests",
    "/api/installation/owner/unlock",
    "/api/installation/owner/settings/read",
  ])
    expect((await f.request(route, "owner-test-password", {})).status).toBe(503);
  await f.drain();
  expect(f.calls).toEqual([]);
  expect(existsSync(path.join(f.root, "restart-jobs.json"))).toBe(false);
  broken = true;
  const refused = await f.request("/api/installation/health");
  expect(refused.status).toBe(503);
  expect(await refused.json()).toEqual({
    error: "Coordinator startup requires installation recovery.",
  });
  broken = false;
  released = true;
  const ready = await f.request("/api/installation/health");
  expect(ready.status).toBe(200);
  expect(await ready.json()).not.toHaveProperty("bootstrap");
  expect(JSON.parse(readFileSync(path.join(f.root, "restart-jobs.json"), "utf8"))).toEqual([]);
  expect(
    (
      await f.request("/api/installation/restart-requests", "guest-agent-test-token", {
        target: "host",
        reason: "After verified release",
      })
    ).status,
  ).toBe(201);
  expect(f.calls).toEqual([]);
});

test("helper controls require owner authentication and preparation refuses guest credentials", async () => {
  const { request } = await fixture();
  for (const route of ["query", "decision", "verify-installed"]) {
    const target = "/api/installation/owner/helpers/" + route;
    for (const token of [undefined, "host-agent-test-token", "guest-agent-test-token"]) {
      expect((await request(target, token, {})).status).toBe(401);
    }
    expect(
      (await request(target, "owner-test-password", {}, "https://foreign.example.test")).status,
    ).toBe(403);
  }
  expect(
    await (await request("/api/installation/capabilities", "host-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: false, ownerApprovalRequired: true } });
  const prepare = "/api/installation/helper-requests";
  expect((await request(prepare, "guest-agent-test-token", {})).status).toBe(401);
  expect((await request(prepare, "owner-test-password", {})).status).toBe(401);
  expect((await request(prepare, "host-agent-test-token", {})).status).toBe(503);
  const listed = await request("/api/installation/owner/helpers/query", "owner-test-password", {});
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ jobs: [] });
  expect(
    (
      await request("/api/installation/owner/helpers/decision", "owner-test-password", {
        revision: randomUUID(),
        decision: "approve",
      })
    ).status,
  ).toBe(400);
});

function helperHttpPreparation() {
  const digest = "a".repeat(64);
  const file = { path: "/private/fixture/tool", sha256: digest };
  return {
    id: randomUUID(),
    reason: "Install isolated helper fixture",
    plan: {
      version: 1,
      operation: "native-helper-install",
      installationId: randomUUID(),
      candidate: {
        sourceCommit: "b".repeat(40),
        directory: "/private/fixture/candidate.app",
        artifactSha256: digest,
        signingMode: "local",
        helperRequirement: "fixture-helper",
        clientRequirement: "fixture-client",
      },
      previous: null,
      retainedRollback: null,
      tooling: {
        sourceCommit: "b".repeat(40),
        directory: "/private/fixture/tooling",
        artifactSha256: digest,
        node: file,
        installer: file,
        dispatcher: file,
        invocationClient: file,
      },
      destination: {
        application: "/private/fixture/Helper.app",
        runtime: "/private/fixture/runtime",
      },
      expectedState: {
        configurationSha256: null,
        policySha256: null,
        installationReceiptSha256: null,
      },
    },
  };
}

test("helper HTTP approval binds the exact source and cancellation never invokes installation", async () => {
  const install = vi.fn(async () => "verified fixture helper");
  const { request, drain, calls, root } = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    undefined,
    undefined,
    {
      validateHelperPlan: async () => {},
      installHelper: install,
      verifyHelperRecovery: async () => "verified recovery",
    },
  );
  expect(
    await (await request("/api/installation/capabilities", "host-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: true, ownerApprovalRequired: true } });
  expect(
    await (await request("/api/installation/capabilities", "guest-agent-test-token")).json(),
  ).toMatchObject({ nativeHelper: { available: false, ownerApprovalRequired: true } });
  const prepared = await request(
    "/api/installation/helper-requests",
    "host-agent-test-token",
    helperHttpPreparation(),
  );
  expect(prepared.status).toBe(201);
  const job = NativeHelperJobSchema.parse(await prepared.json());
  expect(job.status).toBe("pending");
  const publicSummary = await request("/api/installation/restart-summary");
  expect(publicSummary.status).toBe(200);
  expect(await publicSummary.json()).toEqual({
    requested: 0,
    queued: 0,
    running: 0,
    nativeHelper: { requested: 1, queued: 0, running: 0, recovery: 0 },
  });

  await drain();
  expect(install).not.toHaveBeenCalled();
  const decision = {
    operation: "native-helper-install",
    id: job.id,
    revision: job.revision,
    planSha256: job.planSha256,
    decision: "approve",
  };
  const route = "/api/installation/owner/helpers/decision";
  expect(
    (await request(route, "owner-test-password", { ...decision, revision: randomUUID() })).status,
  ).toBe(409);
  expect(install).not.toHaveBeenCalled();
  expect((await request(route, "owner-test-password", decision)).status).toBe(200);
  await expect.poll(() => install.mock.calls.length).toBe(1);
  await expect
    .poll(() => JSON.parse(readFileSync(path.join(root, "restart-jobs.json"), "utf8"))[0].status)
    .toBe("succeeded");
  expect(calls).toEqual([]);
  const canceled = await request(
    "/api/installation/helper-requests",
    "host-agent-test-token",
    helperHttpPreparation(),
  );
  const second = NativeHelperJobSchema.parse(await canceled.json());
  expect(
    (
      await request(route, "owner-test-password", {
        ...decision,
        id: second.id,
        revision: second.revision,
        planSha256: second.planSha256,
        decision: "cancel",
      })
    ).status,
  ).toBe(200);
  await drain();
  expect(install).toHaveBeenCalledTimes(1);
});

test("scoped helper CLI prepares inert requests and returns their exact review receipt", async () => {
  let installations = 0;
  const f = await fixture(undefined, undefined, undefined, false, false, undefined, undefined, {
    validateHelperPlan: async () => {},
    installHelper: async () => {
      installations++;
      return "installed";
    },
    verifyHelperRecovery: async () => "verified",
  });
  const client = path.join(f.root, "host-client.json");
  const guest = path.join(f.root, "guest-client.json");
  for (const [file, kind, token] of [
    [client, "host-agent", "host-agent-test-token"],
    [guest, "container-agent", "guest-agent-test-token"],
  ])
    writeFileSync(file, JSON.stringify({ origin: f.url, kind, token }), { mode: 0o600 });
  const requestFile = path.join(f.root, "helper-request.json");
  const preparation = helperHttpPreparation();
  writeFileSync(requestFile, JSON.stringify(preparation), { mode: 0o600 });
  const command = promisify(execFile);
  const script = path.resolve("../../scripts/installation-agent.mjs");
  const run = (config: string, ...args: string[]) =>
    command(process.execPath, [script, "--config", config, ...args]);
  await expect(run(guest, "request-helper", "--request-file", requestFile)).rejects.toThrow(
    "trusted Host",
  );
  const result = JSON.parse(
    (await run(client, "request-helper", "--request-file", requestFile)).stdout,
  );
  expect(result).toMatchObject({ id: preparation.id, status: "pending", stage: "prepared" });
  expect(new URL(result.approvalUrl).searchParams.get("restart")).toBe(preparation.id);
  const status = JSON.parse((await run(client, "helper-status", preparation.id)).stdout);
  expect(status).toEqual(result);
  expect(
    (
      await f.request(
        `/api/installation/helper-requests/${preparation.id}`,
        "guest-agent-test-token",
      )
    ).status,
  ).toBe(401);
  expect(
    (await f.request(`/api/installation/helper-requests/${randomUUID()}`, "host-agent-test-token"))
      .status,
  ).toBe(404);
  await f.drain();
  expect(installations).toBe(0);
});
