import { BuiltinPluginLoader } from "../../server/plugins/builtin/index.js";
import { loadPersistedConfig } from "../../server/persisted-config.js";
import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../../server/test-utils/daemon-test-context.js";

async function previewReadyProvider(client: DaemonTestContext["client"], providerId: string) {
  await expect
    .poll(
      async () => {
        try {
          await client.previewProviderRemoval(providerId);
          return true;
        } catch (error) {
          if (error instanceof Error && error.message.includes("refresh")) return false;
          throw error;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  return client.previewProviderRemoval(providerId);
}

test("connection removal confirms current ownership and deletes only the final managed credential directory", async () => {
  const ctx = await createDaemonTestContext({ agentClients: {} });
  try {
    const account = await ctx.client.createCodexAccount(randomUUID(), "Deletion test");
    const config = (await ctx.client.getDaemonConfig()).config;
    const provider = ProviderOverrideSchema.parse(config.providers[account.providerId]);
    const home = provider.env?.CODEX_HOME;
    if (!home) throw new Error("Expected an isolated account home");
    await mkdir(home, { recursive: true });
    const auth = path.join(home, "auth.json");
    await writeFile(auth, "test credential", { mode: 0o600 });
    const initial = await previewReadyProvider(ctx.client, account.providerId);
    expect(initial.plan.credentials).toBe("managed");
    await ctx.client.patchDaemonConfig({
      providers: {
        alias: {
          extends: "codex",
          label: "Shared account",
          enabled: false,
          env: { CODEX_HOME: home },
        },
      },
    });
    const shared = await previewReadyProvider(ctx.client, account.providerId);
    await expect(
      ctx.client.removeProvider(account.providerId, initial.plan.revision),
    ).rejects.toThrow("changed");
    expect(await readFile(auth, "utf8")).toBe("test credential");
    expect(shared.plan.credentials).toBe("shared");
    expect(shared.plan.sharedWith).toEqual(["Shared account"]);
    await ctx.client.removeProvider(account.providerId, shared.plan.revision);
    expect(
      (await ctx.client.getDaemonConfig()).config.providers[account.providerId],
    ).toBeUndefined();
    expect(await readFile(auth, "utf8")).toBe("test credential");
    const last = await previewReadyProvider(ctx.client, "alias");
    expect(last.plan.credentials).toBe("managed");
    await ctx.client.removeProvider("alias", last.plan.revision);
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await ctx.client.getDaemonConfig()).config.providers.alias).toBeUndefined();
  } finally {
    await ctx.cleanup();
  }
});

test("deletes bundled plugin providers persistently and restores them on explicit re-add", async () => {
  const builtinPlugins = new BuiltinPluginLoader(undefined, [
    "antigravity-provider",
    "muse-provider",
  ]);
  const ctx = await createDaemonTestContext({
    agentClients: {},
    builtinPlugins,
    providerOverrides: { antigravity: { enabled: false }, muse: { enabled: false } },
  });
  try {
    for (const providerId of ["antigravity", "muse"]) {
      const preview = await previewReadyProvider(ctx.client, providerId);
      expect(preview.plan.credentials).toBe("external");
      await ctx.client.removeProvider(providerId, preview.plan.revision);
      expect(
        (await ctx.client.getProvidersSnapshot()).entries.map((entry) => entry.provider),
      ).not.toContain(providerId);
      await expect(ctx.client.previewProviderRemoval(providerId)).rejects.toThrow(
        "already removed",
      );
    }
    const persisted = loadPersistedConfig(ctx.daemon.paseoHome);
    expect(persisted.agents?.providers?.antigravity).toMatchObject({
      removed: true,
      enabled: false,
    });
    expect(persisted.agents?.providers?.muse).toMatchObject({ removed: true, enabled: false });
    const restarted = await createDaemonTestContext({
      agentClients: {},
      builtinPlugins,
      providerOverrides: persisted.agents?.providers,
    });
    try {
      const ids = (await restarted.client.getProvidersSnapshot()).entries.map(
        (entry) => entry.provider,
      );
      expect(ids).not.toContain("antigravity");
      expect(ids).not.toContain("muse");
      await restarted.client.patchDaemonConfig({
        providers: { muse: { removed: false, enabled: false } },
      });
      expect(
        (await restarted.client.getProvidersSnapshot()).entries.map((entry) => entry.provider),
      ).toContain("muse");
      await restarted.client.patchDaemonConfig({
        providers: { muse: { extends: "codex", label: "Custom Muse", enabled: false } },
      });
      const shadow = await restarted.client.previewProviderRemoval("muse");
      await restarted.client.removeProvider("muse", shadow.plan.revision);
      expect(
        (await restarted.client.getProvidersSnapshot()).entries.map((entry) => entry.provider),
      ).not.toContain("muse");
      await expect(restarted.client.previewProviderRemoval("codex")).rejects.toThrow("Built-in");
    } finally {
      await restarted.cleanup();
    }
  } finally {
    await ctx.cleanup();
  }
}, 60_000);
