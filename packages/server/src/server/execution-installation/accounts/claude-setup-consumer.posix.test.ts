import express from "express";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { createRequireBearerMiddleware, hashDaemonPassword } from "../../auth.js";
import { readInstallationSettings } from "../settings/projection.js";
import type { InstallationSettingsAdmission } from "../settings/admission.js";
import { mountClaudeSetupConsumer } from "./claude-setup-consumer.js";

test("authenticated consumer writes only the policy-bound account and rejects excluded/stale deliveries", async () => {
  const home = await mkdtemp(join(tmpdir(), "claude-consumer-http-"));
  const creationId = randomUUID();
  const providerId = `claude-account-${creationId}`;
  const binding = {
    installationId: randomUUID(),
    serverId: "host",
    environment: "host" as const,
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
  const authority: InstallationSettingsAdmission = {
    ...binding,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(initial),
      providerDefinitions: [
        {
          id: "one",
          providerType: "claude",
          accountSetup: { provider: "claude", creationId },
          bindings: { host: providerId },
          policy: { enabled: true, label: "Claude" },
        },
      ],
    },
  };
  const store = new DaemonConfigStore(home, initial, undefined, {
    installationSettingsReader: { read: async () => authority },
  });
  const app = express();
  app.use(
    createRequireBearerMiddleware({ password: await hashDaemonPassword("synthetic-password") }),
  );
  app.use(express.json());
  mountClaudeSetupConsumer(app, { paseoHome: home, store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("listener unavailable");
  const url = `http://127.0.0.1:${address.port}/api/installation/claude/setup-token`;
  const credential = {
    version: 1,
    accessToken: `sk-ant-oat01-${"synthetic".repeat(8)}`,
    createdAt: 1,
  };
  const delivery = {
    installationId: binding.installationId,
    serverId: "host",
    definitionId: "one",
    providerId,
    revision: 1,
    policyRevision: 1,
    credential,
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
    expect((await request({ ...delivery, serverId: "other" })).status).toBe(409);
    const accountHome = join(home, "claude-accounts", providerId);
    await mkdir(join(home, "claude-accounts"), { recursive: true });
    const unrelated = join(home, "unrelated");
    await mkdir(unrelated, { mode: 0o755 });
    await chmod(unrelated, 0o755);
    await symlink(unrelated, accountHome);
    expect((await request(delivery)).status).toBe(409);
    expect((await lstat(unrelated)).mode & 0o777).toBe(0o755);
    await expect(readFile(join(unrelated, ".vorteo-auth", "delivery.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await unlink(accountHome);
    await mkdir(accountHome, { recursive: true });
    await chmod(accountHome, 0o500);
    expect((await request(delivery)).status).toBe(409);
    expect((await lstat(accountHome)).mode & 0o777).toBe(0o500);
    await chmod(accountHome, 0o755);
    await writeFile(join(accountHome, "history-preserved"), "history");
    const applied = await request(delivery);
    expect(applied.status).toBe(200);
    expect(JSON.stringify(await applied.json())).not.toContain(credential.accessToken);
    expect((await lstat(accountHome)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(accountHome, "history-preserved"), "utf8")).toBe("history");
    const artifact = join(accountHome, ".vorteo-auth", "claude-setup-token.json");
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual(credential);
    await writeFile(join(accountHome, "history-preserved"), "history");
    authority.revision = 2;
    authority.settings.resourceExclusions.host = {
      terminalProfileIds: [],
      metadataProviderIds: [],
      providerIds: ["one"],
    };
    expect((await request({ ...delivery, revision: 2, policyRevision: 2 })).status).toBe(409);
    expect(
      (await request({ ...delivery, revision: 2, policyRevision: 2, credential: null })).status,
    ).toBe(200);
    await expect(readFile(artifact)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(accountHome, "history-preserved"), "utf8")).toBe("history");
    expect((await request(delivery)).status).toBe(409);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    await rm(home, { recursive: true, force: true });
  }
});
