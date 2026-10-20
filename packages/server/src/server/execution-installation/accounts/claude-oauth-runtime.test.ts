import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import type { ProviderLoginSession } from "../../../services/provider-login/session.js";
import { createClaudeOAuthRuntime } from "./claude-oauth-runtime.js";
import {
  accessProjectionDigest,
  type ClaudeOAuthProjectionDelivery,
} from "./claude-oauth-delivery.js";
import type { ClaudeHostCli, ClaudeOAuthGrant } from "./claude-oauth-host.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const SUPPORTED = { installationSettingsAuthority: true, claudeFullSignIn: true };

function harness(
  accountSetup?: InstallationProvider["accountSetup"],
  devFeatures: { installationSettingsAuthority?: boolean; claudeFullSignIn?: boolean } = SUPPORTED,
) {
  const stateDir = mkdtempSync(join(tmpdir(), "claude-oauth-runtime-"));
  directories.push(stateDir);
  const creationId = randomUUID();
  const providerId = `claude-account-${creationId}`;
  const installationId = randomUUID();
  const config = {
    stateDir,
    public: {
      installationId,
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: "127.0.0.1:1", password: "synthetic-host-password" },
    container: { endpoint: "127.0.0.1:2", password: "synthetic-dev-password" },
  } as unknown as InstallationConfig;
  let revision = 1;
  let definitions: InstallationProvider[] = [
    {
      id: "one",
      providerType: "claude",
      ...(accountSetup ? { accountSetup } : {}),
      bindings: { host: providerId },
      policy: { enabled: true, label: "Max" },
    },
  ];
  const snapshot = () => ({
    revision,
    settings: { providerDefinitions: definitions, resourceExclusions: {} },
  });
  const settings = {
    snapshot,
    update: vi.fn(async (input: { settings: { providerDefinitions: InstallationProvider[] } }) => {
      definitions = input.settings.providerDefinitions;
      revision += 1;
      return snapshot();
    }),
    reconcile: vi.fn(async () => snapshot()),
  } as unknown as InstallationSettingsService;
  const configDir = `/host/claude-accounts/${providerId}`;
  const deliveries: ClaudeOAuthProjectionDelivery[] = [];
  const authorizations: string[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    authorizations.push(`${String(url)} ${headers.get("Authorization")}`);
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith("/api/installation/claude/oauth/binding"))
      return Response.json({ providerId: body.providerId, configDir });
    deliveries.push(body);
    const { access, ...slot } = body as ClaudeOAuthProjectionDelivery;
    return Response.json({
      ...slot,
      digest: accessProjectionDigest(access),
      phase: "applied",
      active: access !== null,
    });
  });
  let complete: ((success: boolean) => void) | null = null;
  const session: ProviderLoginSession = {
    scope: configDir,
    start: async (onComplete) => {
      complete = onComplete;
      return {
        verificationUrl: "https://claude.com/cai/oauth/authorize?state=synthetic",
        userCode: "",
        inputRequired: true,
      };
    },
    submitCode: async () => complete?.(true),
    readAccountLabel: async () => null,
    cancel: async () => {},
    dispose: async () => {},
  };
  const cli = {
    refresh: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    identity: vi.fn(async () => ({ email: "owner@example.com", orgId: "org-1" })),
    loginSession: vi.fn(async () => session),
  };
  const grant: ClaudeOAuthGrant = {
    accessToken: "synthetic-access-token",
    hasRefreshToken: true,
    expiresAt: Date.now() + 3_600_000,
    scopes: ["user:inference", "user:profile"],
  };
  const readGrant = vi.fn(async () => grant);
  const daemonFeatures = vi.fn(async (kind: "host" | "container") =>
    kind === "container" ? devFeatures : SUPPORTED,
  );
  const runtime = createClaudeOAuthRuntime(config, settings, undefined, {
    daemonFeatures,
    cli: cli as unknown as ClaudeHostCli,
    readGrant,
    fetch: fetchFake as unknown as typeof fetch,
  });
  return {
    runtime,
    settings,
    cli,
    readGrant,
    deliveries,
    authorizations,
    configDir,
    providerId,
    creationId,
    stateDir,
    definitions: () => definitions,
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

it("signs the Host account in, projects it to Dev and signs it out, storing no token", async () => {
  const h = harness();
  const started = await h.runtime.start("one");
  expect(h.definitions()[0]).toMatchObject({
    accountSetup: { provider: "claude", creationId: h.creationId, signIn: "full" },
    bindings: { host: h.providerId, dev: h.providerId },
  });
  expect(h.settings.reconcile).toHaveBeenCalled();
  await until(() => h.runtime.read("one").login.status === "waiting");
  expect(h.cli.loginSession).toHaveBeenCalledWith(h.configDir);
  const attemptId = "attemptId" in started ? started.attemptId : "";
  await h.runtime.submit("one", attemptId, "synthetic-code#synthetic-state");
  await until(() => h.deliveries.length === 1);
  expect(h.cli.identity).toHaveBeenCalledWith(h.configDir);
  expect(h.readGrant).toHaveBeenCalledWith(h.configDir);
  expect(h.deliveries[0]).toMatchObject({
    serverId: "dev",
    providerId: h.providerId,
    generation: 1,
    rotation: 1,
    access: { accessToken: "synthetic-access-token" },
  });
  expect(h.authorizations).toContain(
    "http://127.0.0.1:2/api/installation/claude/oauth/projection Bearer synthetic-dev-password",
  );
  expect(h.authorizations[0]).toBe(
    "http://127.0.0.1:1/api/installation/claude/oauth/binding Bearer synthetic-host-password",
  );
  await until(() => h.runtime.read("one").connection.environments[0]?.status === "ready");
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: true,
    identity: { email: "owner@example.com", orgId: "org-1" },
  });
  const state = readFileSync(join(h.stateDir, "claude-oauth", "state.json"), "utf8");
  expect(state).not.toContain("synthetic-access-token");

  await expect(h.runtime.signOut("one")).resolves.toBeNull();
  expect(h.cli.logout).toHaveBeenCalledWith(h.configDir);
  expect(h.deliveries.at(-1)).toMatchObject({ generation: 2, rotation: 0, access: null });
  expect(h.runtime.read("one").connection).toMatchObject({
    signedIn: false,
    environments: [{ serverId: "dev", status: "disconnected" }],
  });
});

it("reports a failed Host sign-out but still withdraws Dev", async () => {
  const h = harness();
  await h.runtime.start("one");
  h.cli.logout.mockRejectedValueOnce(new Error("CLI unavailable"));
  await expect(h.runtime.signOut("one")).resolves.toContain("did not finish on the Host");
  expect(h.deliveries.at(-1)).toMatchObject({ access: null });
});

it("refuses to turn a setup-token account into a full sign-in account", async () => {
  const h = harness({ provider: "claude", creationId: randomUUID() });
  await expect(h.runtime.start("one")).rejects.toThrow();
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
});

it("refuses to mark a definition full sign-in until every daemon advertises support", async () => {
  // An older Dev daemon would reject the whole settings authority because of the new field.
  const h = harness(undefined, { installationSettingsAuthority: true });
  await expect(h.runtime.start("one")).rejects.toThrow();
  expect(h.settings.update).not.toHaveBeenCalled();
  expect(h.definitions()[0]?.accountSetup).toBeUndefined();
  expect(h.cli.loginSession).not.toHaveBeenCalled();
});
