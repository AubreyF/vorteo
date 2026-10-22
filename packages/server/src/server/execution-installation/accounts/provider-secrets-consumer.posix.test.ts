import express from "express";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { loadPersistedConfig } from "../../persisted-config.js";
import { createRequireBearerMiddleware, hashDaemonPassword } from "../../auth.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsAdmission } from "../settings/admission.js";
import { mountProviderSecretsConsumer } from "./provider-secrets-consumer.js";

const KEY = `sk-synthetic-${"c".repeat(32)}`;

test("authenticated consumer writes env secrets, withdraws them and refuses excluded targets", async () => {
  const home = await mkdtemp(join(tmpdir(), "provider-secrets-consumer-"));
  const binding = {
    installationId: randomUUID(),
    serverId: "dev",
    environment: "container" as const,
    revision: 1,
  };
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: { openai: { extends: "codex", env: { OPENAI_BASE_URL: "https://local" } } },
    sharedProviderPreferences: {
      version: 1,
      revision: 1,
      providers: {},
      legacyProfiles: {},
      installation: binding,
    },
  });
  let excluded: string[] = [];
  const authority = (): InstallationSettingsAdmission => ({
    ...binding,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(initial),
      providerDefinitions: [
        {
          id: "shared-openai",
          providerType: "codex",
          bindings: { dev: "openai" },
          policy: { enabled: true },
        },
      ],
      resourceExclusions: { dev: { providerIds: excluded } },
    },
  });
  const store = new DaemonConfigStore(home, initial, undefined, {
    installationSettingsReader: { read: async () => authority() },
  });
  const applied: string[] = [];
  const app = express();
  app.use(
    createRequireBearerMiddleware({ password: await hashDaemonPassword("synthetic-password") }),
  );
  app.use(express.json());
  mountProviderSecretsConsumer(app, {
    paseoHome: home,
    store,
    onApplied: (id) => applied.push(id),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  const url = `http://127.0.0.1:${address.port}/api/installation/provider-secrets`;
  const delivery = {
    installationId: binding.installationId,
    serverId: "dev",
    definitionId: "shared-openai",
    providerId: "openai",
    revision: 1,
    policyRevision: 1,
    values: { OPENAI_API_KEY: KEY },
    overwrite: ["OPENAI_API_KEY"],
  };
  const request = (body: unknown, authenticated = true) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authenticated ? { Authorization: "Bearer synthetic-password" } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await request(delivery, false)).status).toBe(401);
    expect((await request({ ...delivery, providerId: "other" })).status).toBe(409);
    expect((await request({ ...delivery, policyRevision: 2 })).status).toBe(409);

    const response = await request(delivery);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body)).toMatchObject({ phase: "applied", conflicts: [] });
    expect(store.get().providers.openai!.env).toEqual({
      OPENAI_BASE_URL: "https://local",
      OPENAI_API_KEY: KEY,
    });
    expect(loadPersistedConfig(home).agents?.providers?.openai?.env).toEqual({
      OPENAI_BASE_URL: "https://local",
      OPENAI_API_KEY: KEY,
    });
    expect(applied).toEqual(["openai"]);
    const journals = join(home, "provider-secrets");
    expect((await stat(journals)).mode & 0o777).toBe(0o700);
    const [journal] = await readdir(journals);
    expect((await stat(join(journals, journal!))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(journals, journal!), "utf8")).not.toContain(KEY);

    // Values cannot reach an excluded environment, but withdrawal still can.
    excluded = ["shared-openai"];
    expect((await request({ ...delivery, revision: 2 })).status).toBe(409);
    expect((await request({ ...delivery, revision: 2, values: {}, overwrite: [] })).status).toBe(
      200,
    );
    expect(store.get().providers.openai!.env).toEqual({ OPENAI_BASE_URL: "https://local" });
    expect(loadPersistedConfig(home).agents?.providers?.openai?.env).toEqual({
      OPENAI_BASE_URL: "https://local",
    });
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
});
