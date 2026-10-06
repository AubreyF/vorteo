import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import type { InstallationPlugin } from "@getpaseo/protocol/plugin-installation";
import type { InstallationSettingsAdmission } from "./admission.js";
import { assertInstallationPluginAction } from "./plugin-admission.js";
import { readInstallationSettings } from "./projection.js";

function fixture() {
  const plugin: InstallationPlugin = {
    id: "shared",
    enabled: true,
    source: {
      kind: "git",
      id: "manifest",
      identity: { kind: "git", remote: "https://example.test/plugin.git", pluginPath: "." },
      target: { kind: "git", commit: "a".repeat(40) },
    },
  };
  const admission: InstallationSettingsAdmission = {
    installationId: "4c07b582-7d41-4be4-9725-36f975708983",
    serverId: "host",
    environment: "host",
    revision: 1,
    installationInstructions: "",
    settings: {
      ...readInstallationSettings(
        MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
      ),
      pluginsEnabled: true,
      plugins: [plugin],
    },
  };
  return { plugin, admission };
}

test("shared plugin changes must match exact canonical sources, enablement and exclusions", () => {
  const { admission, plugin } = fixture();
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "configure",
      source: plugin.source,
      enabled: true,
    }),
  ).not.toThrow();
  expect(() => assertInstallationPluginAction(admission, plugin.id, { kind: "disable" })).toThrow(
    "coordinator",
  );
  expect(() => assertInstallationPluginAction(admission, plugin.id, { kind: "remove" })).toThrow(
    "coordinator",
  );
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "configure",
      source: { kind: "directory" },
      enabled: true,
    }),
  ).toThrow("coordinator");
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    pluginIds: [plugin.id],
  };
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "disable" }),
  ).not.toThrow();
  expect(() => assertInstallationPluginAction(admission, plugin.id, { kind: "enable" })).toThrow(
    "coordinator",
  );
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "activate",
      source: plugin.source,
    }),
  ).toThrow("coordinator");
  expect(() => assertInstallationPluginAction(admission, plugin.id, { kind: "remove" })).toThrow(
    "coordinator",
  );
  admission.settings.plugins = [];
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "remove" }),
  ).not.toThrow();
});

test("rollback permits only an allowed prior revision of the same source", () => {
  const { admission, plugin } = fixture();
  if (plugin.source.kind !== "git") throw new Error("Git fixture expected");
  const previous = { ...plugin.source, target: { kind: "git" as const, commit: "b".repeat(40) } };
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "activate", source: previous }),
  ).toThrow("coordinator");
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "restore", source: previous }),
  ).not.toThrow();
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "restore",
      source: {
        ...previous,
        identity: { ...previous.identity, remote: "https://other.test/plugin.git" },
      },
    }),
  ).toThrow("coordinator");
  admission.settings.pluginsEnabled = false;
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "restore", source: previous }),
  ).toThrow("coordinator");
});

test("an uninitialized catalog cannot authorize plugin changes", () => {
  const { admission, plugin } = fixture();
  delete admission.settings.plugins;
  expect(() => assertInstallationPluginAction(admission, plugin.id, { kind: "enable" })).toThrow(
    "migration",
  );
});

test("directory bindings preserve exclusions and cannot replace managed sources", () => {
  const { admission, plugin } = fixture();
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "bind-directory", enabled: true }),
  ).toThrow("coordinator");
  plugin.source = { kind: "directory" };
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "bind-directory", enabled: true }),
  ).not.toThrow();
  admission.settings.resourceExclusions.host = {
    terminalProfileIds: [],
    metadataProviderIds: [],
    pluginIds: [plugin.id],
  };
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, { kind: "bind-directory", enabled: true }),
  ).toThrow("coordinator");
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "bind-directory",
      enabled: false,
    }),
  ).not.toThrow();
  admission.settings.plugins = [];
  expect(() =>
    assertInstallationPluginAction(admission, plugin.id, {
      kind: "bind-directory",
      enabled: false,
    }),
  ).toThrow("coordinator");
});
