import express from "express";
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { createRequireBearerMiddleware, hashDaemonPassword } from "../../auth.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsAdmission } from "../settings/admission.js";
import { createClaudeAccount } from "../../../services/provider-login/create-account.js";
import { CLAUDE_SIGN_IN_ENV } from "../../agent/providers/claude/sign-in-mode.js";
import { mountClaudeOAuthConsumer } from "./claude-oauth-consumer.js";
import { mountClaudeSetupConsumer } from "./claude-setup-consumer.js";
import { accessProjectionDigest, ClaudeOAuthDeliveryError } from "./claude-oauth-delivery.js";
import { writeClaudeAccessProjection } from "./claude-oauth-credentials-file.js";

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
const access = (accessToken: string) => ({
  accessToken,
  expiresAt: 2_000_000_000_000,
  scopes: ["user:inference", "user:profile"],
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
});

async function fixture(
  options: { signIn?: "full" | "setup-token"; platform?: NodeJS.Platform } = {},
) {
  const paseoHome = await temporary("claude-oauth-consumer-");
  const creationId = randomUUID();
  const providerId = `claude-account-${creationId}`;
  const binding = {
    installationId: randomUUID(),
    serverId: "dev",
    environment: "container" as const,
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
          providerType: "claude",
          accountSetup: {
            provider: "claude",
            creationId,
            ...(options.signIn === "setup-token" ? {} : { signIn: "full" as const }),
          },
          bindings: { dev: providerId },
          policy: { enabled: true, label: "Max" },
        },
      ],
      resourceExclusions: excluded
        ? { dev: { providerIds: ["one"], terminalProfileIds: [], metadataProviderIds: [] } }
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
  mountClaudeSetupConsumer(app, { paseoHome, store });
  mountClaudeOAuthConsumer(app, { paseoHome, store, platform: options.platform ?? "linux" });
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
    serverId: "dev",
    definitionId: "one",
    providerId,
    policyRevision: 1,
  };
  const home = join(paseoHome, "claude-accounts", providerId);
  return {
    paseoHome,
    store,
    creationId,
    providerId,
    home,
    scope,
    post,
    exclude: (excluded: boolean) => {
      current = authority(excluded);
    },
    project: (generation: number, rotation: number, value: unknown) =>
      post("/api/installation/claude/oauth/projection", {
        ...scope,
        generation,
        rotation,
        access: value,
      }),
  };
}

it("writes access-only projections in order and keeps the CLI's other storage", async () => {
  const f = await fixture();
  mkdirSync(f.home, { recursive: true, mode: 0o700 });
  writeFileSync(join(f.home, ".credentials.json"), JSON.stringify({ mcpOAuth: { a: "kept" } }), {
    mode: 0o600,
  });
  const first = await f.project(1, 1, access("synthetic-access-a"));
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ phase: "applied", active: true, generation: 1, rotation: 1 });
  expect(first.body.digest).toBe(accessProjectionDigest(access("synthetic-access-a")));
  const saved = JSON.parse(readFileSync(join(f.home, ".credentials.json"), "utf8"));
  expect(saved.mcpOAuth).toEqual({ a: "kept" });
  expect(saved.claudeAiOauth).toEqual(access("synthetic-access-a"));
  expect("refreshToken" in saved.claudeAiOauth).toBe(false);
  expect(statSync(join(f.home, ".credentials.json")).mode & 0o777).toBe(0o600);
  const env = f.store.get().providers[f.providerId]?.env;
  expect(env?.[CLAUDE_SIGN_IN_ENV]).toBe("full");
  expect(env?.CLAUDE_CONFIG_DIR).toBe(f.home);
  // Older and conflicting slots are refused; a newer rotation replaces the token.
  expect((await f.project(1, 0, access("synthetic-old"))).status).toBe(409);
  expect((await f.project(1, 1, access("synthetic-other"))).status).toBe(409);
  expect((await f.project(1, 2, access("synthetic-access-b"))).status).toBe(200);
  expect(
    JSON.parse(readFileSync(join(f.home, ".credentials.json"), "utf8")).claudeAiOauth.accessToken,
  ).toBe("synthetic-access-b");
  // A refresh token never reaches Dev: the strict schema rejects the payload.
  const withRefresh = { ...access("synthetic-access-c"), refreshToken: "synthetic-refresh" };
  expect((await f.project(1, 3, withRefresh)).status).toBe(400);
  expect(readFileSync(join(f.home, ".credentials.json"), "utf8")).not.toContain("refresh");
});

it("refuses access for an excluded binding but applies its withdrawal", async () => {
  const f = await fixture();
  expect((await f.project(1, 1, access("synthetic-access"))).status).toBe(200);
  f.exclude(true);
  expect((await f.project(1, 2, access("synthetic-next"))).status).toBe(409);
  const withdrawn = await f.project(1, 2, null);
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.body).toMatchObject({ phase: "applied", active: false });
  const saved = JSON.parse(readFileSync(join(f.home, ".credentials.json"), "utf8"));
  expect(saved.claudeAiOauth).toBeUndefined();
});

it("refuses projections on macOS and for setup-token definitions", async () => {
  const mac = await fixture({ platform: "darwin" });
  expect((await mac.project(1, 1, access("synthetic-access"))).status).toBe(409);
  const token = await fixture({ signIn: "setup-token" });
  expect((await token.project(1, 1, access("synthetic-access"))).status).toBe(409);
  expect(token.store.get().providers[token.providerId]).toBeUndefined();
});

it("returns only the full sign-in binding's exact path, never a credential", async () => {
  const f = await fixture();
  const route = "/api/installation/claude/oauth/binding";
  expect((await f.post(route, f.scope)).status).toBe(409);
  await createClaudeAccount({
    paseoHome: f.paseoHome,
    store: f.store,
    creationId: f.creationId,
    name: "Max",
    signIn: "full",
  });
  const response = await f.post(route, f.scope);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ providerId: f.providerId, configDir: f.home });
  expect((await f.post(route, { ...f.scope, policyRevision: 2 })).status).toBe(409);
  const token = await fixture({ signIn: "setup-token" });
  expect((await token.post(route, token.scope)).status).toBe(409);
});

it("never delivers a setup token to a full sign-in definition", async () => {
  const f = await fixture();
  const response = await f.post("/api/installation/claude/setup-token", {
    ...f.scope,
    revision: 1,
    credential: { version: 1, accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`, createdAt: 1 },
  });
  expect(response.status).toBe(409);
});

it("waits for a fresh CLI storage lock and takes over a stale one", async () => {
  const home = await temporary("claude-oauth-lock-");
  const lock = join(home, ".storage-write.lock");
  mkdirSync(lock);
  const sleep = vi.fn(async () => {
    // The CLI finishes its save and releases the lock.
    await rm(lock, { recursive: true, force: true });
  });
  await writeClaudeAccessProjection(home, access("synthetic-a"), { sleep });
  expect(sleep).toHaveBeenCalledTimes(1);
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const never = vi.fn(async () => {});
  await writeClaudeAccessProjection(home, access("synthetic-b"), { sleep: never });
  expect(never).not.toHaveBeenCalled();
  expect(
    JSON.parse(readFileSync(join(home, ".credentials.json"), "utf8")).claudeAiOauth.accessToken,
  ).toBe("synthetic-b");
  // A fresh lock that is never released fails without touching the file.
  mkdirSync(lock);
  await expect(
    writeClaudeAccessProjection(home, access("synthetic-c"), { sleep: never, attempts: 2 }),
  ).rejects.toBeInstanceOf(ClaudeOAuthDeliveryError);
  expect(readFileSync(join(home, ".credentials.json"), "utf8")).toContain("synthetic-b");
});

it("refuses a credentials file that is a symbolic link", async () => {
  const home = await temporary("claude-oauth-link-");
  const target = join(home, "elsewhere.json");
  writeFileSync(target, "{}");
  symlinkSync(target, join(home, ".credentials.json"));
  await expect(writeClaudeAccessProjection(home, access("synthetic-a"))).rejects.toBeInstanceOf(
    ClaudeOAuthDeliveryError,
  );
  expect(readFileSync(target, "utf8")).toBe("{}");
});
