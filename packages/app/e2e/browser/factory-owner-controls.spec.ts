import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import { getServerId } from "../support/helpers/server-id";

// Real plugin loaders, transport and SDK controls. The isolated handler exercises
// UI outcomes; native authority and retained lifecycle have their own integration tests.
test("Factory owner controls show applied and refused outcomes on desktop and compact", async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(path.join(tmpdir(), "factory-controls-ui-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const pluginId = "factory-controls-ui";
  const source = path.resolve(__dirname, "../../../..", "plugins/factory");
  await mkdir(path.join(directory, "client"));
  await mkdir(path.join(directory, "shared"));
  for (const file of [
    "client/owner-controls.tsx",
    "client/owner-control-dispatch.ts",
    "client/installation.ts",
    "shared/operations.ts",
  ])
    await cp(path.join(source, file), path.join(directory, file));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: pluginId, requirements: pluginRequirements }),
  );
  const identity = {
    serverId: getServerId(),
    projectId: "fixture-project",
    installationId: "fixture-installation",
  };
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
import React from "react";
import { ScrollView } from "react-native";
import { FactoryOwnerControls } from "./client/owner-controls";
export default function contribute(plugin) {
  plugin.addSurface("main", () => <ScrollView><FactoryOwnerControls hostId=${JSON.stringify(identity.serverId)} projectId="fixture-project" /></ScrollView>);
  plugin.addSidebarItem({id: "main", title: "Factory controls test", icon: "Factory", surface: "main"});
  return () => {};
}`,
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { factoryControls, factoryControl } from "./shared/operations";
const identity = ${JSON.stringify(identity)};
let revision = 1, state = "paused";
export default function contribute(server) {
  server.handle(factoryControls, () => ({schemaVersion: 1, ...identity, revision: String(revision), state,
    desiredState: state, reason: null, operations: {pause: true, resume: true, stop: true}, operationId: null}));
  server.handle(factoryControl, input => {
    const result = {schemaVersion: 1, ...identity, operationId: input.operationId};
    if (input.action === "resume") return {...result, outcome: "refused", reason: "Account authorization requires reconciliation."};
    state = input.action === "pause" ? "paused" : "stopped";
    return {...result, outcome: "applied", revision: String(++revision)};
  });
  return () => {};
}`,
  );
  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await page.setViewportSize({ width: 1100, height: 800 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Factory controls test", exact: true }).click();
    await expect(page.getByText("Factory paused", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(
      page.getByText("Account authorization requires reconciliation.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Factory stopped", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Factory control applied. Current state is shown below.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("factory-controls-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileAgentSidebar(page);
    await page.getByRole("button", { name: "Factory controls test", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByText("Factory paused", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(
      page.getByText("Account authorization requires reconciliation.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("factory-controls-compact.png") });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await client.removePlugin(pluginId);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
