import express from "express";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { InstallationProvider } from "@getpaseo/protocol/installation-provider";
import { ProviderSecretsReadResponseSchema } from "@getpaseo/protocol/provider-secrets";
import type { InstallationConfig } from "../config.js";
import type { InstallationSettingsService } from "../settings/service.js";
import { createProviderSecretsRuntime } from "./provider-secrets-runtime.js";
import { mountProviderSecretsRoutes } from "./provider-secrets-routes.js";
import {
  providerSecretsDeliveryDigest,
  type ProviderSecretsDelivery,
} from "./provider-secrets-delivery.js";

const KEY = `sk-synthetic-${"d".repeat(32)}`;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function harness(
  devFeatures = { installationSettingsAuthority: true, providerSecretDelivery: true },
) {
  const stateDir = mkdtempSync(join(tmpdir(), "provider-secrets-runtime-"));
  directories.push(stateDir);
  const config = {
    stateDir,
    public: {
      installationId: randomUUID(),
      environments: [
        { serverId: "host", kind: "host" },
        { serverId: "dev", kind: "container" },
      ],
    },
    host: { endpoint: "127.0.0.1:1", password: "synthetic-host-password" },
    container: { endpoint: "127.0.0.1:2", password: "synthetic-dev-password" },
  } as unknown as InstallationConfig;
  const codexCreation = randomUUID();
  const definitions: InstallationProvider[] = [
    {
      id: "openai",
      providerType: "codex",
      bindings: { host: "openai", dev: "openai" },
      policy: { enabled: true },
    },
    {
      id: "codex-account",
      providerType: "codex",
      accountSetup: { provider: "codex", creationId: codexCreation },
      bindings: {
        host: `codex-account-${codexCreation}`,
        dev: `codex-account-${codexCreation}`,
      },
      policy: { enabled: true },
    },
  ];
  const settings = {
    snapshot: () => ({
      revision: 4,
      settings: { providerDefinitions: definitions, resourceExclusions: {} },
    }),
  } as unknown as InstallationSettingsService;
  const deliveries: ProviderSecretsDelivery[] = [];
  const authorizations: string[] = [];
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(`${String(url)} ${new Headers(init?.headers).get("Authorization")}`);
    const body = JSON.parse(String(init?.body)) as ProviderSecretsDelivery;
    deliveries.push(body);
    const { values: _values, overwrite: _overwrite, ...scope } = body;
    return Response.json({
      ...scope,
      digest: providerSecretsDeliveryDigest(body),
      phase: "applied",
      conflicts: [],
    });
  });
  const runtime = createProviderSecretsRuntime(config, settings, undefined, {
    fetch: fetchFake as unknown as typeof fetch,
    inspect: async (kind) => ({
      features:
        kind === "container"
          ? devFeatures
          : { installationSettingsAuthority: true, providerSecretDelivery: true },
      providers: { openai: { env: {} } },
    }),
    now: () => new Date("2026-10-22T00:00:00.000Z"),
  });
  const app = express();
  app.use(express.json());
  mountProviderSecretsRoutes(app, runtime);
  const server = app.listen(0, "127.0.0.1");
  const call = async (operation: string, body: unknown) => {
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("listener unavailable");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/installation/owner/provider-secrets/${operation}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, text: await response.text() };
  };
  return { stateDir, runtime, deliveries, authorizations, call, close: () => server.close() };
}

test("owner routes store a key once, deliver it to both daemons and never return it", async () => {
  const h = harness();
  try {
    const saved = await h.call("set", {
      definitionId: "openai",
      name: "OPENAI_API_KEY",
      value: KEY,
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(KEY);
    await h.runtime.reconcile();
    const read = await h.call("read", { definitionId: "openai" });
    expect(read.text).not.toContain(KEY);
    const [status] = ProviderSecretsReadResponseSchema.parse(JSON.parse(read.text)).definitions;
    expect(status).toMatchObject({
      definitionId: "openai",
      ready: true,
      secrets: [{ name: "OPENAI_API_KEY", last4: "dddd", source: "owner" }],
      environments: [
        { serverId: "host", kind: "host", status: "delivered" },
        { serverId: "dev", kind: "container", status: "delivered" },
      ],
    });
    expect(h.deliveries.map((item) => item.serverId).sort()).toEqual(["dev", "host"]);
    expect(h.authorizations.sort()).toEqual([
      "http://127.0.0.1:1/api/installation/provider-secrets Bearer synthetic-host-password",
      "http://127.0.0.1:2/api/installation/provider-secrets Bearer synthetic-dev-password",
    ]);
    const file = join(h.stateDir, "provider-secrets", "state.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(KEY);

    const cleared = await h.call("clear", { definitionId: "openai", name: "OPENAI_API_KEY" });
    expect(JSON.parse(cleared.text).definitions[0].secrets).toEqual([]);
    await h.runtime.reconcile();
    expect(h.deliveries.slice(-2).map((item) => item.values)).toEqual([{}, {}]);
    expect(readFileSync(file, "utf8")).not.toContain(KEY);
  } finally {
    h.close();
  }
});

test("rejects invalid input without echoing it and reports unknown definitions", async () => {
  const h = harness();
  try {
    const invalid = await h.call("set", {
      definitionId: "openai",
      name: "CODEX_HOME",
      value: KEY,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.text).not.toContain(KEY);
    const spaced = await h.call("set", {
      definitionId: "openai",
      name: "OPENAI_API_KEY",
      value: ` ${KEY}`,
    });
    expect(spaced.status).toBe(400);
    expect(spaced.text).not.toContain(KEY);
    expect((await h.call("read", { definitionId: "missing" })).status).toBe(404);
  } finally {
    h.close();
  }
});

test("older Dev daemons are detected by feature flag and Codex accounts ask for per-environment sign-in", async () => {
  const h = harness({ installationSettingsAuthority: true, providerSecretDelivery: false });
  try {
    await h.call("set", { definitionId: "openai", name: "OPENAI_API_KEY", value: KEY });
    await h.runtime.reconcile();
    const read = JSON.parse((await h.call("read", {})).text);
    const [openai, codex] = ProviderSecretsReadResponseSchema.parse(read).definitions;
    expect(openai!.ready).toBe(false);
    expect(openai!.environments[1]).toMatchObject({
      status: "failed",
      message: "Update Dev container to receive shared keys.",
    });
    expect(h.deliveries.map((item) => item.serverId)).toEqual(["host"]);
    expect(codex!.accountSignIn).toEqual({
      provider: "codex",
      synchronized: false,
      environments: [
        { serverId: "host", kind: "host", label: "Host" },
        { serverId: "dev", kind: "container", label: "Dev container" },
      ],
    });
    expect(openai!.accountSignIn).toBeUndefined();
  } finally {
    h.close();
  }
});
