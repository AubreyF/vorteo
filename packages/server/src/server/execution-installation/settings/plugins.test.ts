import { expect, test, vi } from "vitest";
import type {
  InstallationPlugin,
  ResolvedPluginSource,
} from "@getpaseo/protocol/plugin-installation";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import {
  readInstallationPlugins,
  mergeInstallationPlugins,
  projectInstallationPlugins,
  installationPluginsSettled,
  type PluginProjectionPort,
} from "./plugins.js";

const source: ResolvedPluginSource = {
  kind: "git",
  id: "manifest-id",
  identity: { kind: "git", remote: "https://example.test/plugin.git", pluginPath: "." },
  target: { kind: "git", commit: "a".repeat(40) },
};
const definition: InstallationPlugin = { id: "saved-alias", source, enabled: true };
function item(): PluginListItem {
  return {
    id: definition.id,
    path: "/private/existing",
    enabled: true,
    status: "running",
    installation: { identity: source.identity, currentRevision: source.target.commit },
    resolvedSource: source,
  };
}
function fixture(initial: PluginListItem[] = []) {
  let items = structuredClone(initial);
  const port: PluginProjectionPort = {
    listPlugins: async () => structuredClone(items),
    installResolvedPluginSource: vi.fn(async (input) => {
      const installed: PluginListItem = {
        id: input.id,
        enabled: input.enabled,
        status: input.enabled ? "running" : "disabled",
        path: `/local/${input.id}`,
        installation: { identity: input.resolved.identity },
        resolvedSource: input.resolved,
      };
      items.push(installed);
      return installed;
    }),
    enablePlugin: vi.fn(async (id) => {
      const installed = items.find((entry) => entry.id === id)!;
      installed.enabled = true;
      installed.status = "running";
      return installed;
    }),
    disablePlugin: vi.fn(async (id) => {
      const installed = items.find((entry) => entry.id === id)!;
      installed.enabled = false;
      installed.status = "disabled";
      return installed;
    }),
    previewPluginUpdates: vi.fn(async () => []),
    applyPluginUpdates: vi.fn(async () => []),
  };
  return {
    port,
    replace: (next: PluginListItem[]) => {
      items = structuredClone(next);
    },
  };
}

test("catalog observations exclude local paths and preserve installed IDs and exact sources", () => {
  expect(readInstallationPlugins([item()])).toEqual([definition]);
  const local: PluginListItem = {
    ...item(),
    resolvedSource: undefined,
    installation: { identity: { kind: "directory", path: "/private/source" } },
  };
  expect(readInstallationPlugins([local])).toEqual([
    { id: definition.id, source: { kind: "directory" }, enabled: true },
  ]);
  expect(() => readInstallationPlugins([{ ...item(), resolvedSource: undefined }])).toThrow(
    "verified source",
  );
});

test("migration retains unique definitions and exposes conflicting identities for review", () => {
  const other = { ...definition, id: "dev-only" };
  const conflicting = { ...definition, enabled: false };
  const merged = mergeInstallationPlugins({ host: [definition], dev: [conflicting, other] });
  expect(merged.needsReview).toBe(true);
  expect(merged.candidates.host).toEqual([other, definition]);
  expect(merged.candidates.dev).toEqual([other, conflicting]);
  expect(mergeInstallationPlugins({ host: [], dev: [] }).needsReview).toBe(false);
});

test("exclusions retain local copies and clearing an exclusion reuses the same binding", async () => {
  const { port } = fixture([item()]);
  await projectInstallationPlugins(port, [definition], [definition.id]);
  expect(await port.listPlugins()).toMatchObject([{ path: "/private/existing", enabled: false }]);
  expect(port.installResolvedPluginSource).not.toHaveBeenCalled();
  await projectInstallationPlugins(port, [definition], []);
  expect(await port.listPlugins()).toMatchObject([{ path: "/private/existing", enabled: true }]);
  expect(port.enablePlugin).toHaveBeenCalledOnce();
  await projectInstallationPlugins(port, [definition], []);
  expect(port.enablePlugin).toHaveBeenCalledOnce();
  await projectInstallationPlugins(port, [], []);
  expect(await port.listPlugins()).toMatchObject([{ path: "/private/existing", enabled: false }]);
});

test("a lost install reply converges without reinstalling the existing exact artifact", async () => {
  const { port, replace } = fixture();
  vi.mocked(port.installResolvedPluginSource).mockImplementationOnce(async () => {
    replace([item()]);
    throw new Error("lost reply");
  });
  await expect(projectInstallationPlugins(port, [definition], [])).rejects.toThrow("lost reply");
  await projectInstallationPlugins(port, [definition], []);
  expect(port.installResolvedPluginSource).toHaveBeenCalledOnce();
  expect(installationPluginsSettled(await port.listPlugins(), [definition], [])).toBe(true);
});

test("unavailable directory bindings and conflicting sources never overwrite an existing installation", async () => {
  const { port } = fixture([item()]);
  await expect(
    projectInstallationPlugins(port, [{ ...definition, source: { kind: "directory" } }], []),
  ).rejects.toThrow("conflicts");
  await expect(
    projectInstallationPlugins(
      port,
      [{ id: "missing", enabled: true, source: { kind: "directory" } }],
      [],
    ),
  ).rejects.toThrow("binding");
  expect(port.installResolvedPluginSource).not.toHaveBeenCalled();
  expect((await port.listPlugins())[0].path).toBe("/private/existing");
});

test("updates require a matching pinned preview before any artifact mutation", async () => {
  const { port } = fixture([item()]);
  const next = {
    ...definition,
    source: { ...source, target: { kind: "git" as const, commit: "b".repeat(40) } },
  };
  await expect(projectInstallationPlugins(port, [next], [])).rejects.toThrow("fresh source review");
  expect(port.previewPluginUpdates).toHaveBeenCalledWith({
    pluginId: definition.id,
    target: { kind: "git", ref: "b".repeat(40) },
  });
  expect(port.applyPluginUpdates).not.toHaveBeenCalled();
  expect((await port.listPlugins())[0].resolvedSource).toEqual(source);
});

test("registry updates use the reviewed registry pin and reject a changed registry artifact", async () => {
  const registry = { url: "https://plugins.example.test", id: "owner/plugin" };
  const current = item();
  const registeredSource = { ...source, identity: { ...source.identity, registry } };
  current.installation = {
    identity: registeredSource.identity,
    currentRevision: source.target.commit,
  };
  current.resolvedSource = registeredSource;
  const { port } = fixture([current]);
  const next = {
    ...definition,
    source: { ...registeredSource, target: { kind: "git" as const, commit: "b".repeat(40) } },
  };
  await expect(projectInstallationPlugins(port, [next], [])).rejects.toThrow("fresh source review");
  expect(port.previewPluginUpdates).toHaveBeenCalledWith({ pluginId: definition.id });
  expect(port.applyPluginUpdates).not.toHaveBeenCalled();
  expect((await port.listPlugins())[0].resolvedSource).toEqual(registeredSource);
  const proposal = {
    id: definition.id,
    expected: {
      identity: registeredSource.identity,
      installationRoot: current.path,
      revision: source.target.commit,
    },
    target: next.source.target,
  };
  vi.mocked(port.previewPluginUpdates).mockResolvedValue([
    { id: definition.id, outcome: "update", proposal, links: [] },
  ]);
  vi.mocked(port.applyPluginUpdates).mockImplementation(async (proposals) => {
    expect(proposals).toEqual([proposal]);
    current.resolvedSource = next.source;
    current.installation = {
      identity: next.source.identity,
      currentRevision: next.source.target.commit,
    };
    return [{ id: definition.id, outcome: "updated", plugin: current }];
  });
  port.listPlugins = async () => structuredClone([current]);
  await projectInstallationPlugins(port, [next], []);
  expect((await port.listPlugins())[0].resolvedSource).toEqual(next.source);
});
