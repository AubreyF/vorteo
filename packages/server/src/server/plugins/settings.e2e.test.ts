import {
  projectInstallationPlugins,
  readInstallationPlugins,
} from "../execution-installation/settings/plugins.js";
import { pathToFileURL } from "node:url";
import { runGitCommand } from "../../utils/run-git-command.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { defineRpc, settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

test("server reads saved settings after daemon restart before any client connects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "settings-restart-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "plugin");
  const startupReport = path.join(root, "startup.json");
  await mkdir(path.join(directory, "server"), { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "settings-startup",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "server", "report.ts"),
    `import { writeFile } from "node:fs/promises";
export async function reportStartup(settings) {
  const state = await settings.read();
  await writeFile(${JSON.stringify(startupReport)}, JSON.stringify(state));
}`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { reportStartup } from "./server/report";
export default function(server) {
  const settings = server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) }));
  const startup = reportStartup(settings);
  return async () => { await startup; };
}`,
  );
  const options = {
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "settings-startup": { source: "directory" as const, path: directory, enabled: true },
    },
  };
  const first = await createTestPaseoDaemon(options);
  onTestFinished(() => first.close());
  const rpc = settingsRpc("display");
  const readStartup = async () =>
    rpc.read.output.parse(JSON.parse(await readFile(startupReport, "utf8")));
  await expect
    .poll(readStartup)
    .toEqual({ status: "ready", revision: "missing", values: { enabled: true } });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.8.0" });
  onTestFinished(() => client.close());
  await client.connect();
  const saved = rpc.write.output.parse(
    await client.invokePluginRpc("settings-startup", rpc.write.name, {
      revision: "missing",
      values: { enabled: false },
    }),
  );
  expect(saved).toMatchObject({ status: "saved", values: { enabled: false } });
  const persisted = rpc.read.output.parse(
    await client.invokePluginRpc("settings-startup", rpc.read.name, {}),
  );
  await client.close();
  await first.close();
  await rm(startupReport);

  const restarted = await createTestPaseoDaemon(options);
  onTestFinished(() => restarted.close());
  // No client is created for this daemon: the report comes from server startup alone.
  await expect.poll(readStartup).toEqual(persisted);
}, 60_000);

test("two clients share settings, observe changes, and preserve values through plugin lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "settings-plugin-"));
  const daemon = await createTestPaseoDaemon();
  const first = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const second = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  const rpc = settingsRpc("display");
  const serverReadRpc = defineRpc({
    name: "settings-test.server-read",
    input: z.object({}),
    output: z.json(),
  });
  const serverChangesRpc = defineRpc({
    name: "settings-test.server-changes",
    input: z.object({}),
    output: z.object({ count: z.number().int() }),
  });
  const read = async (client: DaemonClient, pluginId = "settings-test") =>
    rpc.read.output.parse(await client.invokePluginRpc(pluginId, rpc.read.name, {}));
  const changed: string[] = [];
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "settings-test",
        requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
const serverRead = defineRpc({ name: "settings-test.server-read", input: z.object({}), output: z.json() });
const serverChanges = defineRpc({ name: "settings-test.server-changes", input: z.object({}), output: z.object({ count: z.number().int() }) });
export default function(server) {
  const settings = server.registerSettings(defineSettings({ id: "display", scope: "host", version: 1, schema: z.object({ enabled: z.boolean().default(true) }) }));
  let changes = 0;
  settings.subscribe(() => { changes += 1; });
  server.handle(serverRead, () => settings.read());
  server.handle(serverChanges, () => ({ count: changes }));
  return () => {};
}`,
    );
    await first.connect();
    await second.connect();
    await second.observeEvents(["status.plugin_settings_changed"]).ready;
    second.on("status", (message) => {
      if (message.payload.status === "plugin_settings_changed")
        changed.push(z.string().parse(message.payload.settingsId));
    });
    await first.patchDaemonConfig({ pluginsEnabled: true });
    await first.installDirectoryPlugin(directory);
    const initial = await read(first);
    expect(initial).toMatchObject({ status: "ready", values: { enabled: true } });
    expect(
      serverReadRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverReadRpc.name, {}),
      ),
    ).toMatchObject({ status: "ready", values: { enabled: true } });
    expect(
      serverChangesRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverChangesRpc.name, {}),
      ),
    ).toEqual({ count: 0 });
    expect(
      await second.invokePluginRpc("settings-test", rpc.write.name, {
        revision: initial.revision,
        values: { enabled: false },
      }),
    ).toMatchObject({ status: "saved" });
    await expect.poll(() => changed).toEqual(["display"]);
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    expect(
      serverReadRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverReadRpc.name, {}),
      ),
    ).toMatchObject({ status: "ready", values: { enabled: false } });
    expect(
      serverChangesRpc.output.parse(
        await first.invokePluginRpc("settings-test", serverChangesRpc.name, {}),
      ),
    ).toEqual({ count: 1 });
    expect(
      await first.invokePluginRpc("settings-test", rpc.write.name, {
        revision: initial.revision,
        values: { enabled: true },
      }),
    ).toMatchObject({ status: "conflict" });
    await first.reloadPlugin("settings-test");
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    await first.disablePlugin("settings-test");
    await first.enablePlugin("settings-test");
    expect(await read(first)).toMatchObject({ values: { enabled: false } });
    await first.installDirectoryPlugin(directory, "other-installation");
    expect(await read(first, "other-installation")).toMatchObject({ values: { enabled: true } });
    await first.removePlugin("settings-test");
    await first.installDirectoryPlugin(directory);
    expect(await read(first)).toMatchObject({ values: { enabled: true } });
  } catch (error) {
    console.error(await first.getPluginLogs("settings-test"));
    throw error;
  } finally {
    await first.close();
    await second.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("two daemons install the same pinned source through the client without starting disabled copies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "shared-plugin-source-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const marker = path.join(root, "started");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({
      id: "shared-source",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(repository, "index.server.ts"),
    `import { writeFileSync } from "node:fs";
export default function contribute() { writeFileSync(${JSON.stringify(marker)}, "started"); return () => undefined; }`,
  );
  await runGitCommand(["init", "-b", "main"], { cwd: repository });
  await runGitCommand(["config", "user.name", "Paseo Tests"], { cwd: repository });
  await runGitCommand(["config", "user.email", "paseo@example.test"], { cwd: repository });
  await runGitCommand(["add", "-A"], { cwd: repository });
  await runGitCommand(["commit", "-m", "initial"], { cwd: repository });
  const first = await createTestPaseoDaemon({ pluginsEnabled: true });
  onTestFinished(() => first.close());
  const second = await createTestPaseoDaemon({ pluginsEnabled: true });
  onTestFinished(() => second.close());
  const host = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws` });
  const dev = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws` });
  onTestFinished(() => host.close());
  onTestFinished(() => dev.close());
  await Promise.all([host.connect(), dev.connect()]);
  const resolved = await host.resolvePluginSource({ source: pathToFileURL(repository).href });
  expect(resolved.kind).toBe("git");
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await host.listPlugins()).toEqual([]);
  await writeFile(path.join(repository, "later.txt"), "not selected");
  await runGitCommand(["add", "-A"], { cwd: repository });
  await runGitCommand(["commit", "-m", "later"], { cwd: repository });
  const disabled = await host.installResolvedPluginSource({ resolved, enabled: false });
  expect(disabled.status).toBe("disabled");
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const enabled = await dev.installResolvedPluginSource({ resolved, enabled: true });
  expect(enabled.status).toBe("running");
  expect(await readFile(marker, "utf8")).toBe("started");
  if (resolved.kind === "git") {
    expect(disabled.commit).toBe(resolved.target.commit);
    expect(enabled.commit).toBe(resolved.target.commit);
  }
  for (const installed of [disabled, enabled]) {
    await expect(readFile(path.join(installed.path, "later.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
  const shared = [{ id: resolved.id, source: resolved, enabled: true }];
  expect(readInstallationPlugins(await dev.listPlugins())).toEqual(shared);
  await projectInstallationPlugins(dev, shared, [resolved.id]);
  expect(await dev.listPlugins()).toMatchObject([
    { path: enabled.path, enabled: false, status: "disabled" },
  ]);
  await rm(marker);
  await projectInstallationPlugins(dev, shared, [resolved.id]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await projectInstallationPlugins(dev, shared, []);
  expect(await readFile(marker, "utf8")).toBe("started");
  expect(await dev.listPlugins()).toMatchObject([
    { path: enabled.path, enabled: true, status: "running" },
  ]);
  await projectInstallationPlugins(host, shared, []);
  expect(await host.listPlugins()).toMatchObject([
    { path: disabled.path, enabled: true, status: "running" },
  ]);
  const updatedSource = await host.resolvePluginSource({ source: pathToFileURL(repository).href });
  const updated = [{ id: resolved.id, source: updatedSource, enabled: true }];
  await projectInstallationPlugins(dev, updated, []);
  expect(readInstallationPlugins(await dev.listPlugins())).toEqual(updated);
  const devUpdated = (await dev.listPlugins())[0];
  expect(await readFile(path.join(devUpdated.path, "later.txt"), "utf8")).toBe("not selected");
  expect(readInstallationPlugins(await host.listPlugins())).toEqual(shared);
}, 60_000);

test("directory binding RPC preserves disabled state and rejects stale replacement paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "directory-binding-rpc-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directories = [path.join(root, "original"), path.join(root, "replacement")];
  const marker = path.join(root, "started");
  for (const directory of directories) {
    await mkdir(directory);
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({
        id: "local",
        requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
      }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "started"); return () => {}; }`,
    );
  }
  const daemon = await createTestPaseoDaemon({ pluginsEnabled: true });
  onTestFinished(() => daemon.close());
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  onTestFinished(() => client.close());
  await client.connect();
  const installed = await client.bindDirectoryPlugin({
    id: "stable-id",
    path: directories[0],
    expectedPath: null,
    enabled: false,
  });
  expect(installed).toMatchObject({
    id: "stable-id",
    path: directories[0],
    enabled: false,
    status: "disabled",
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    client.bindDirectoryPlugin({
      id: "stable-id",
      path: directories[1],
      expectedPath: null,
      enabled: false,
    }),
  ).rejects.toThrow("binding changed");
  const replaced = await client.bindDirectoryPlugin({
    id: "stable-id",
    path: directories[1],
    expectedPath: directories[0],
    enabled: false,
  });
  expect(replaced).toMatchObject({
    id: "stable-id",
    path: directories[1],
    enabled: false,
    status: "disabled",
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(directories[0], "paseo-plugin.json"), "utf8")).toContain(
    '"id":"local"',
  );
});
