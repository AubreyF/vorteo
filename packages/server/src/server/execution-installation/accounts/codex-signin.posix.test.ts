import express from "express";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { createRequireBearerMiddleware, hashDaemonPassword } from "../../auth.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsAdmission } from "../settings/admission.js";
import { createCodexAccount } from "../../../services/provider-login/create-account.js";
import { mountCodexSignInConsumer } from "./codex-signin-consumer.js";
import { codexProjectionDigest } from "./codex-signin-delivery.js";

const PASSWORD = "synthetic-password";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function temporary(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const access = (accessToken: string, accountId: string | null = "workspace-1") => ({
  accessToken,
  idToken: "synthetic-id-token",
  accountId,
  expiresAt: 2_000_000_000_000,
  lastRefresh: "2026-10-20T00:00:00.000Z",
});

async function fixture(serverId = "dev") {
  const paseoHome = await temporary("codex-signin-consumer-");
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  const binding = {
    installationId: randomUUID(),
    serverId,
    environment: serverId === "dev" ? ("container" as const) : ("host" as const),
    revision: 1,
  };
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  const settings = readInstallationSettings(initial);
  const authority = (excluded: boolean): InstallationSettingsAdmission => ({
    ...binding,
    installationInstructions: "",
    settings: {
      ...settings,
      providerDefinitions: [
        {
          id: "one",
          providerType: "codex",
          accountSetup: { provider: "codex", creationId },
          bindings: { [serverId]: providerId },
          policy: { enabled: true, label: "ChatGPT Pro" },
        },
      ],
      resourceExclusions: excluded
        ? {
            [serverId]: { providerIds: ["one"], terminalProfileIds: [], metadataProviderIds: [] },
          }
        : {},
    },
  });
  let current = authority(false);
  const store = new DaemonConfigStore(paseoHome, initial, undefined, {
    installationSettingsReader: { read: async () => current },
  });
  const app = express();
  app.use(createRequireBearerMiddleware({ password: await hashDaemonPassword(PASSWORD) }));
  app.use(express.json());
  mountCodexSignInConsumer(app, { paseoHome, store });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listener unavailable");
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PASSWORD}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const scope = {
    installationId: binding.installationId,
    serverId,
    definitionId: "one",
    providerId,
    policyRevision: 1,
  };
  const home = join(paseoHome, "codex-accounts", providerId);
  const authFile = join(home, "auth.json");
  return {
    paseoHome,
    store,
    creationId,
    providerId,
    home,
    authFile,
    scope,
    post,
    readAuth: () => JSON.parse(readFileSync(authFile, "utf8")),
    exclude: (excluded: boolean) => {
      current = authority(excluded);
    },
    project: (generation: number, rotation: number, value: unknown) =>
      post("/api/installation/codex/signin/projection", {
        ...scope,
        generation,
        rotation,
        access: value,
      }),
  };
}

/** A sign-in made directly in this environment, before the installation connection. */
async function signInLocally(f: Awaited<ReturnType<typeof fixture>>, accountId: string) {
  await createCodexAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "ChatGPT Pro",
  });
  mkdirSync(f.home, { recursive: true, mode: 0o700 });
  const local = {
    tokens: {
      id_token: "local-id",
      access_token: "local-access",
      refresh_token: "local-refresh",
      account_id: accountId,
    },
    last_refresh: "2026-10-01T00:00:00Z",
  };
  writeFileSync(f.authFile, JSON.stringify(local), { mode: 0o600 });
  return local;
}

it("writes access-only Codex sign-ins in order, with an empty refresh token", async () => {
  const f = await fixture();
  const first = await f.project(1, 1, access("synthetic-access-a"));
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ phase: "applied", active: true, generation: 1, rotation: 1 });
  expect(first.body.digest).toBe(codexProjectionDigest(access("synthetic-access-a")));
  expect(f.readAuth()).toEqual({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "synthetic-id-token",
      access_token: "synthetic-access-a",
      refresh_token: "",
      account_id: "workspace-1",
    },
    last_refresh: "2026-10-20T00:00:00.000Z",
  });
  expect(statSync(f.authFile).mode & 0o777).toBe(0o600);
  expect(f.store.get().providers[f.providerId]?.env?.CODEX_HOME).toBe(f.home);
  // Older and conflicting slots are refused; a newer rotation replaces the token.
  expect((await f.project(1, 0, access("synthetic-old"))).status).toBe(409);
  expect((await f.project(1, 1, access("synthetic-other"))).status).toBe(409);
  expect((await f.project(1, 2, access("synthetic-access-b"))).status).toBe(200);
  expect(f.readAuth().tokens.access_token).toBe("synthetic-access-b");
  // A refresh token never reaches Dev: the strict schema rejects the payload.
  const withRefresh = { ...access("synthetic-access-c"), refreshToken: "synthetic-refresh" };
  expect((await f.project(1, 3, withRefresh)).status).toBe(400);
  expect(readFileSync(f.authFile, "utf8")).not.toContain("synthetic-refresh");
  const journal = readFileSync(join(f.home, ".vorteo-signin", "projection.json"), "utf8");
  expect(journal).not.toContain("synthetic-access");
});

it("refuses access for an excluded binding, applies its withdrawal and ignores stale grants", async () => {
  const f = await fixture();
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(200);
  f.exclude(true);
  expect((await f.project(1, 2, access("synthetic-next"))).status).toBe(409);
  const withdrawn = await f.project(1, 2, null);
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body).toMatchObject({ phase: "applied", active: false });
  expect(existsSync(f.authFile)).toBe(false);
  // A late copy of the earlier sign-in cannot restore the credential.
  f.exclude(false);
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(409);
  expect(existsSync(f.authFile)).toBe(false);
});

it("replaces an earlier local sign-in of the same account and keeps a rollback copy", async () => {
  const f = await fixture();
  const local = await signInLocally(f, "workspace-1");
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(200);
  expect(f.readAuth().tokens).toMatchObject({
    access_token: "synthetic-access",
    refresh_token: "",
  });
  const copy = join(f.home, ".vorteo-signin", "local-sign-in.json");
  expect(JSON.parse(readFileSync(copy, "utf8"))).toEqual(local);
  expect(statSync(copy).mode & 0o777).toBe(0o600);
});

it("refuses to replace a local sign-in of a different or unverifiable account", async () => {
  const f = await fixture();
  const local = await signInLocally(f, "workspace-other");
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(409);
  expect((await f.project(1, 1, access("synthetic-access", null))).status).toBe(409);
  expect(f.readAuth()).toEqual(local);
  // A withdrawal never removes a sign-in made in this environment.
  expect((await f.project(1, 2, null)).status).toBe(200);
  expect(f.readAuth()).toEqual(local);
});

it("returns only the Host binding's exact CODEX_HOME, never a credential", async () => {
  const f = await fixture("host");
  const route = "/api/installation/codex/signin/binding";
  expect((await f.post(route, f.scope)).status).toBe(409);
  await createCodexAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "ChatGPT Pro",
  });
  const response = await f.post(route, f.scope);
  expect(response).toEqual({
    status: 200,
    body: { providerId: f.providerId, codexHome: f.home },
  });
  expect((await f.post(route, { ...f.scope, providerId: "codex-account-other" })).status).toBe(409);
  expect((await f.post(route, { ...f.scope, policyRevision: 2 })).status).toBe(409);
});
