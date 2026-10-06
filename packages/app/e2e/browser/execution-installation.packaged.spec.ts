import {
  buildHostAgentDetailRoute,
  buildNewWorkspaceRoute,
} from "../../../app/src/utils/host-routes";
import { sidebarProjectForWorkspace } from "../support/helpers/workspace-ui";
import { expectComposerVisible, fillComposerDraft } from "../support/helpers/composer";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import pino from "pino";
import {
  startIsolatedHostDaemon,
  type IsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { hashDaemonPassword } from "../../../server/src/server/auth";
import { createInstallationServer } from "../../../server/src/server/execution-installation/server";
import {
  connectInstallationDaemon,
  createInstallationRestartExecutor,
} from "../../../server/src/server/execution-installation/daemon";
import type { InstallationConfig } from "../../../server/src/server/execution-installation/config";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";

let root: string;
let origin: string;
let listener: Server;
let config: InstallationConfig;
let expiredRestartId: string;
const daemons: IsolatedHostDaemon[] = [];
const ownerPassword = "installation-browser-owner-password";
const guestToken = "installation-browser-guest-request-token";
const hostToken = "installation-browser-host-request-token";

async function connectReadyInstallationDaemon(kind: "host" | "container") {
  let client: Awaited<ReturnType<typeof connectInstallationDaemon>> | undefined;
  await expect
    .poll(
      async () => {
        try {
          client = await connectInstallationDaemon(config, kind);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (!client) throw new Error("Isolated installation daemon did not become ready");
  return client;
}

async function request(route: string, token: string, body: unknown) {
  return fetch(`${origin}/api/installation/${route}`, {
    method: "POST",
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  root = await mkdtemp(path.join(tmpdir(), "vorteo-installation-browser-"));
  for (const kind of ["container", "host"]) {
    const home = await mkdtemp(path.join(tmpdir(), `vorteo-${kind}-browser-`));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        daemon: { auth: { password: hashDaemonPassword(`${kind}-test-password`) } },
      }),
    );
    daemons.push(
      await startIsolatedHostDaemon(`installation-${kind}-${randomUUID()}`, {
        paseoHome: home,
        environment: {
          NODE_ENV: "development",
          ...Object.fromEntries(
            Object.keys(process.env)
              .filter((key) => key.startsWith("PASEO_"))
              .map((key) => [key, undefined]),
          ),
        },
      }),
    );
  }
  const guest = daemons[0]!;
  const host = daemons[1]!;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  config = {
    public: {
      version: 1,
      installationId: randomUUID(),
      origin: "http://127.0.0.1:6770",
      environments: [
        {
          kind: "container",
          serverId: guest.serverId,
          endpoint: `127.0.0.1:${guest.port}`,
          useTls: false,
        },
        {
          kind: "host",
          serverId: host.serverId,
          endpoint: `127.0.0.1:${host.port}`,
          useTls: false,
        },
      ],
    },
    listenPort: 6770,
    webDistDir: path.resolve(__dirname, "../../../server/dist/server/web-ui"),
    stateDir: root,
    ownerPasswordFile: path.join(root, "owner-password"),
    ownerPasswordHash: hashDaemonPassword(ownerPassword),
    hostAgentTokenHash: hash(hostToken),
    containerAgentTokenHash: hash(guestToken),
    host: {
      endpoint: `127.0.0.1:${host.port}`,
      password: "host-test-password",
      launchdService: "gui/501/local.vorteo.test.host",
    },
    container: { endpoint: `127.0.0.1:${guest.port}`, password: "container-test-password" },
  };
  await writeFile(config.ownerPasswordFile!, ownerPassword, { mode: 0o600 });
  listener = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing installation test port");
  config.listenPort = address.port;
  origin = `http://127.0.0.1:${address.port}`;
  config.public.origin = origin;
  expiredRestartId = randomUUID();
  await writeFile(
    path.join(root, "restart-jobs.json"),
    JSON.stringify([
      {
        id: expiredRestartId,
        revision: randomUUID(),
        target: "host",
        requestedBy: "host-agent",
        reason: "Historical expired maintenance",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:30:00.000Z",
        status: "pending",
        detail: "Approval required",
      },
    ]),
  );
  const app = createInstallationServer(
    config,
    createInstallationRestartExecutor(config),
    pino({ level: "silent" }),
  );
  listener.on("request", app);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const home = kind === "host" ? host.paseoHome : guest.paseoHome;
      const file = path.join(home, "config.json");
      const persisted = JSON.parse(await readFile(file, "utf8"));
      persisted.daemon.cors = { allowedOrigins: [origin] };
      await writeFile(file, JSON.stringify(persisted));
      await client.reloadDaemonConfig();
      expect((await client.getDaemonConfig()).config.cors?.allowedOrigins).toContain(origin);
      await client.patchDaemonConfig({ pluginsEnabled: true });
      const directory = path.join(root, `${kind}-plugin`);
      await mkdir(directory);
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: `${kind}-authority-test`, requirements: pluginRequirements }),
      );
      await writeFile(
        path.join(directory, "index.client.ts"),
        `export default function() { globalThis.__installationPluginKinds = [...(globalThis.__installationPluginKinds ?? []), "${kind}"]; return () => {}; }`,
      );
      await client.installDirectoryPlugin(directory);
      expect(
        (await client.getPluginCatalog()).some(
          (plugin) => plugin.id === `${kind}-authority-test` && Boolean(plugin.clientBundle),
        ),
      ).toBe(true);
    } finally {
      await client.close();
    }
  }
});

test.afterAll(async () => {
  if (listener) await new Promise<void>((resolve) => listener.close(() => resolve()));
  for (const daemon of daemons.toReversed()) await daemon.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("owner connects two environments, prepares host drafts, and approves a verified container restart", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    if (!localStorage.getItem("paseo-drafts"))
      localStorage.setItem(
        "paseo-drafts",
        JSON.stringify({
          version: 5,
          state: {
            drafts: {
              "new-workspace": {
                input: { text: "Keep my existing draft", attachments: [] },
                lifecycle: "active",
                updatedAt: Date.now(),
                version: 1,
              },
            },
            createModalDraft: null,
          },
        }),
      );
  });
  await page.goto(origin);
  await expect(page.getByTestId("installation-panel")).toBeVisible();
  await expect(page).toHaveURL(/settings\/general/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByTestId("installation-password-help").click();
  await expect(page.getByText("The host installer generates", { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("installation-owner-access.png"),
    fullPage: true,
  });
  await page.getByTestId("installation-password").fill("incorrect");
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByRole("alert")).toContainText("Incorrect owner password");
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]").length,
      ),
    )
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, "__installationPluginKinds")))
    .toEqual(["host"]);
  await page.goto(`${origin}/settings/general`);
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await expect
    .poll(async () =>
      (
        await page.request.post(`${origin}/api/installation/owner/session`, {
          headers: { Origin: origin },
        })
      ).json(),
    )
    .toMatchObject({ authenticated: true });
  await page.getByTestId("settings-vorton-mode").getByLabel("Vorteo mode", { exact: true }).click();
  await expect(page.getByTestId("installation-controls-open")).toHaveCount(0);
  await expect(page.getByTestId("installation-panel")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByTestId("installation-panel")
    .screenshot({ path: testInfo.outputPath("installation-settings.png") });
  await expect(page.getByText("Owner unlocked", { exact: true })).toBeVisible();
  if (testInfo.project.name === "phone") {
    const lockBox = await page.getByTestId("installation-lock").boundingBox();
    expect(lockBox?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  }
  await expect(page.getByText("No pending restart requests", { exact: true })).toBeVisible();
  await expect(page.getByText("Historical expired maintenance", { exact: true })).not.toBeVisible();
  await page.getByTestId("restart-history-toggle").click();
  await expect(page.getByText("Historical expired maintenance", { exact: true })).toBeVisible();
  await expect(page.getByTestId("installation-status-host")).toContainText(
    "Restart request expired",
  );
  await page.getByTestId("restart-history-toggle").click();
  await page.getByTestId("installation-lock").click();
  await expect(page.getByText("Unlock to view approval status", { exact: false })).toBeVisible();
  await expect(page.getByTestId("installation-status-host")).toHaveCount(0);
  await page.getByTestId("installation-password-help").click();
  await expect(page.getByTestId("installation-password-file")).toHaveText(
    path.join(root, "owner-password"),
  );
  await expect(
    page.getByText("Owner access is remembered in this browser", { exact: false }),
  ).toBeVisible();
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await page.getByTestId("vorton-help-update").click();
  await expect(page).toHaveURL(new RegExp(`serverId=${daemons[1]!.serverId}`));
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toHaveValue(/trusted native host environment/);
  await composer.fill("Review this update before making changes.");
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("paseo-drafts") ?? "{}").state.drafts["new-workspace"].input
          .text,
    ),
  ).toBe("Keep my existing draft");
  await page.goBack();
  await page.getByTestId("prepare-upstream-task").click();
  await expect(page).toHaveURL(new RegExp(`serverId=${daemons[1]!.serverId}`));
  await expect(composer).toHaveValue(/weekly upstream synchronization/);
  const native = await connectInstallationDaemon(config, "host");
  try {
    expect((await native.fetchAgents()).entries).toEqual([]);
  } finally {
    await native.close();
  }

  expect((await request("container-agents", guestToken, { operation: "list" })).status).toBe(403);
  const delegated = await request("container-agents", hostToken, { operation: "workspaces" });
  expect(delegated.status).toBe(200);
  expect(await delegated.json()).toMatchObject({
    environment: "container",
    serverId: daemons[0]!.serverId,
  });
  const job = RestartJobSchema.parse(
    await (
      await request("restart-requests", guestToken, {
        target: "container-daemon",
        reason: "Verify isolated test daemon restart",
      })
    ).json(),
  );
  expect(
    (
      await request(`owner/restarts/${job.id}/decision`, guestToken, {
        revision: job.revision,
        decision: "approve",
      })
    ).status,
  ).toBe(401);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto(`${origin}/settings/general`);
  await page.getByTestId("installation-lock").click();
  await page.goto(`${origin}/settings/general?installation=1&restart=${job.id}`);
  await expect(page.getByTestId("installation-password")).toBeVisible();
  await expect(page.getByTestId(`restart-confirm-${job.id}`)).toHaveCount(0);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId(`restart-confirm-${job.id}`)).toBeInViewport();
  const unchanged = await fetch(`${origin}/api/installation/restart-requests/${job.id}`, {
    headers: { Authorization: `Bearer ${guestToken}` },
  }).then((response) => response.json());
  expect(unchanged.status).toBe("pending");
  await expect(page.getByTestId(`restart-request-${job.id}`)).toContainText("Approval needed");
  const card = page.getByTestId(`restart-request-${job.id}`);
  await expect(card).toContainText("Approval needed");
  page.on("dialog", () => {
    throw new Error("Installation controls must not open browser dialogs");
  });
  await expect(page.getByTestId(`restart-confirmation-${job.id}`)).toContainText(
    "may be interrupted",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.screenshot({ path: testInfo.outputPath("installation-inline-review.png") });
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId(`restart-confirmation-${job.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`restart-request-${job.id}`)).toContainText("Approval needed");
  await page.getByTestId(`restart-approve-${job.id}`).click();
  await page.getByTestId(`restart-confirm-${job.id}`).click();
  await expect(
    page.getByText("Restart approved. Its progress is shown here.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`restart-request-${job.id}`)).toContainText("Restarted", {
    timeout: 150_000,
  });
  await expect(card).toContainText("environment identity verified");
  await expect(page.getByTestId(`restart-confirm-${job.id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "All restart requests", exact: true }).click();
  await page.getByTestId("restart-history-toggle").click();
  await expect(card).toContainText("environment identity verified");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("installation-controls.png"), fullPage: true });
});

test("restart links keep expired and missing requests separate from a pending approval", async ({
  page,
}) => {
  const pending = RestartJobSchema.parse(
    await (
      await request("restart-requests", hostToken, {
        target: "host",
        reason: "Unrelated pending maintenance",
      })
    ).json(),
  );
  await page.goto(`${origin}/settings/general?installation=1&restart=${expiredRestartId}`);
  await page
    .getByTestId("settings-vorton-mode")
    .getByRole("button", { name: "Vorteo mode", exact: true })
    .click();
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId(`restart-request-${expiredRestartId}`)).toContainText("expired");
  await expect(page.getByTestId(`restart-request-${pending.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`restart-confirm-${expiredRestartId}`)).toHaveCount(0);
  await page.goto(`${origin}/settings/general?installation=1&restart=${randomUUID()}`);
  await expect(
    page.getByText("This restart request is no longer available.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`restart-request-${pending.id}`)).toHaveCount(0);
  await page.goto(`${origin}/settings/general?installation=1&restart=${pending.id}`);
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toBeInViewport();
  await page.reload();
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toBeInViewport();
  await page
    .getByTestId("settings-vorton-mode")
    .getByRole("button", { name: "Standard mode", exact: true })
    .click();
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toHaveCount(0);
  await expect(
    page.getByText("Enable Vorteo mode below to review installation restart requests.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByTestId("settings-vorton-mode").getByLabel("Vorteo mode", { exact: true }).click();
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toBeInViewport();
  const unchanged = await fetch(`${origin}/api/installation/restart-requests/${pending.id}`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  }).then((response) => response.json());
  expect(unchanged.status).toBe("pending");
});

async function verifyCrossEnvironmentWorkspaceMove(input: {
  page: Page;
  testInfo: TestInfo;
  sourceClient: Awaited<ReturnType<typeof connectInstallationDaemon>>;
  destinationClient: Awaited<ReturnType<typeof connectInstallationDaemon>>;
  destinationServerId: string;
  workspaceId: string;
  directory: string;
}) {
  const { page, sourceClient, destinationClient, workspaceId, directory, testInfo } = input;
  const targetPath = path.join(root, "Any project");
  await mkdir(targetPath, { recursive: true });
  execFileSync("git", ["init", targetPath]);
  execFileSync("git", [
    "-C",
    targetPath,
    "remote",
    "add",
    "origin",
    "https://github.com/example/any-project.git",
  ]);
  await sourceClient.createWorkspace({ source: { kind: "directory", path: targetPath } });
  const target = (await sourceClient.listProjects()).projects.find(
    (project) => project.projectRootPath === targetPath,
  )!;
  await destinationClient.createAgent({
    config: { provider: "mock", cwd: directory, title: "Another retained chat" },
    workspaceId,
  });
  const chatIds = async () =>
    (await destinationClient.fetchAgents()).entries
      .filter(({ agent }) => agent.workspaceId === workspaceId)
      .map(({ agent }) => agent.id)
      .sort();
  const before = await chatIds();
  expect(before).toHaveLength(2);
  if (testInfo.project.name === "phone")
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  const key = `${input.destinationServerId}:${workspaceId}`;
  const row = page.getByTestId(`sidebar-workspace-row-${key}`);
  await expect(row).toBeVisible();
  if (testInfo.project.name === "desktop") await row.hover();
  await page.getByTestId(`sidebar-workspace-kebab-${key}`).click();
  await page.getByTestId(`sidebar-workspace-menu-move-project-${key}`).click();
  await page.getByTestId("project-move-project").click();
  await page.getByText(target.projectDisplayName, { exact: true }).last().click();
  await page.screenshot({ path: testInfo.outputPath("workspace-move-review.png"), fullPage: true });
  await page.getByTestId("project-move-confirm").click();
  await expect(page.getByTestId("project-move-modal")).toHaveCount(0);
  const targetRowId = `sidebar-project-row-${target.projectKey}`;
  await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(targetRowId);
  const moved = (await destinationClient.fetchWorkspaces()).entries.find(
    (item) => item.id === workspaceId,
  )!;
  expect(moved.workspaceDirectory).toBe(directory);
  expect(moved.projectMembership).toEqual({
    key: target.projectKey,
    name: target.projectDisplayName,
  });
  expect(await chatIds()).toEqual(before);
  await page.reload();
  await expectComposerVisible(page, { timeout: 60_000 });
  if (testInfo.project.name === "phone")
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(row).toBeVisible();
  await expect.poll(() => sidebarProjectForWorkspace(row)).toBe(targetRowId);
  expect(
    (await destinationClient.fetchWorkspaces()).entries.find((item) => item.id === workspaceId)
      ?.projectMembership,
  ).toEqual(moved.projectMembership);
}

async function verifyCrossEnvironmentDraft(input: {
  page: Page;
  testInfo: TestInfo;
  destinationClient: Awaited<ReturnType<typeof connectInstallationDaemon>>;
  sourceServerId: string;
  destinationServerId: string;
  sourcePath: string;
  destinationPath: string;
  sourceProject: { projectId: string; projectKey?: string; projectDisplayName: string };
}) {
  const {
    page,
    testInfo,
    destinationClient,
    sourceServerId,
    destinationServerId,
    sourcePath,
    destinationPath,
    sourceProject,
  } = input;
  const beforeIds = new Set(
    (await destinationClient.fetchWorkspaces()).entries.map((entry) => entry.id),
  );
  await page.goto(
    `${origin}${buildNewWorkspaceRoute({
      serverId: sourceServerId,
      projectId: sourceProject.projectId,
      sourceDirectory: sourcePath,
      displayName: sourceProject.projectDisplayName,
    })}`,
  );
  await expectComposerVisible(page, { timeout: 60_000 });
  await page.getByTestId("agent-preset-selector").click();
  if (testInfo.project.name === "phone")
    await page.getByTestId("preset-section-environment").click();
  await page.getByTestId(`preset-environment-${destinationServerId}`).click();
  await page.getByTestId("preset-account-mock").click();
  await page.getByTestId("preset-use-profile").click();
  await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
  await expect(page.getByTestId("preset-destination-project")).toHaveCount(0);
  await expect(page.getByTestId("preset-destination-directory")).toHaveValue(destinationPath);
  await page.getByTestId("preset-handoff-confirm").click();
  await expect(page.getByTestId("preset-handoff-modal")).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/h/${destinationServerId}/workspace/`));
  await expectComposerVisible(page, { timeout: 60_000 });
  const created = (await destinationClient.fetchWorkspaces()).entries.filter(
    (entry) => !beforeIds.has(entry.id),
  );
  expect(created).toHaveLength(1);
  expect(created[0]!.workspaceDirectory).toBe(destinationPath);
  expect(sourceProject.projectKey).toBeTruthy();
  expect(created[0]!.projectMembership?.key).toBe(sourceProject.projectKey);
  expect(
    (await destinationClient.fetchAgents()).entries.filter(
      ({ agent }) => agent.workspaceId === created[0]!.id,
    ),
  ).toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("new-draft-retains-project.png"),
    fullPage: true,
  });
  await fillComposerDraft(page, "Start a new thread in the same project on this environment.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await destinationClient.fetchAgents()).entries.filter(
          ({ agent }) => agent.workspaceId === created[0]!.id,
        ).length,
    )
    .toBe(1);
  const started = (await destinationClient.fetchAgents()).entries.find(
    ({ agent }) => agent.workspaceId === created[0]!.id,
  )!.agent;
  expect(started.cwd).toBe(destinationPath);
  expect(started.provider).toBe("mock");
  expect(started.model).toBe("ten-second-stream");
}

for (const destinationMode of ["existing", "new"] as const) {
  const sourceKind = destinationMode === "new" ? "container" : "host";
  const destinationKind = destinationMode === "new" ? "host" : "container";
  const sourceIndex = destinationMode === "new" ? 0 : 1;
  const destinationIndex = destinationMode === "new" ? 1 : 0;
  test(`environment profile selection keeps its project with ${destinationMode === "existing" ? "an existing" : "a new"} destination directory`, async ({
    page,
  }, testInfo) => {
    const sourceServerId = daemons[sourceIndex]!.serverId;
    const destinationServerId = daemons[destinationIndex]!.serverId;
    const sourcePath = path.join(root, `${sourceKind}-${destinationMode}-workspace`);
    const destinationPath = path.join(root, `${destinationKind}-${destinationMode}-workspace`);
    const sourceClient = await connectInstallationDaemon(config, sourceKind);
    const destinationClient = await connectInstallationDaemon(config, destinationKind);
    try {
      for (const [client, kind] of [
        [sourceClient, sourceKind],
        [destinationClient, destinationKind],
      ] as const) {
        const current = (await client.getDaemonConfig()).config;
        await client.patchDaemonConfig({
          expectedProviderPreferencesRevision: current.sharedProviderPreferences?.revision ?? null,
          sharedProviderPreferences: {
            version: 1,
            revision: current.sharedProviderPreferences?.revision ?? 0,
            legacyProfiles: {},
            providers: {
              mock: {
                defaults: {},
                preferredModels: [],
                preferredThinkingOptions: [],
                defaultWorkflowId: null,
                workflows: [
                  {
                    id: "handoff",
                    provider: "mock",
                    name: "Browser handoff",
                    model: "ten-second-stream",
                    modeId: "load-test",
                  },
                ],
              },
            },
          },
        });
        const directory = path.join(root, `${kind}-${destinationMode}-workspace`);
        await mkdir(directory, { recursive: true });
        execFileSync("git", ["init", directory]);
        execFileSync("git", [
          "-C",
          directory,
          "remote",
          "add",
          "origin",
          `https://github.com/example/${destinationMode === "new" ? kind : "shared"}-${destinationMode}.git`,
        ]);
      }
      const { workspace: sourceWorkspace } = await sourceClient.createWorkspace({
        source: { kind: "directory", path: sourcePath },
        title: "Source workspace",
      });
      const destinationWorkspace =
        destinationMode === "existing"
          ? (
              await destinationClient.createWorkspace({
                source: { kind: "directory", path: destinationPath },
                title: "Destination workspace",
              })
            ).workspace
          : null;
      if (!sourceWorkspace) throw new Error("Missing source workspace");
      const source = await sourceClient.createAgent({
        config: {
          provider: "mock",
          model: "e2e-fast-stream",
          modeId: "load-test",
          cwd: sourcePath,
          title: "Environment handoff",
        },
        workspaceId: sourceWorkspace.id,
        initialPrompt: "Remember the cross environment handoff acceptance task.",
      });
      await expect
        .poll(async () => (await sourceClient.fetchAgent(source.id))?.agent.status)
        .toBe("idle");
      await page.goto(origin);
      await page.getByTestId("installation-password").fill(ownerPassword);
      await page.getByTestId("installation-unlock").click();
      await expect(page.getByTestId("installation-password")).not.toBeVisible();
      await page.goto(
        `${origin}${buildHostAgentDetailRoute(sourceServerId, source.id, sourceWorkspace.id)}`,
      );
      await expectComposerVisible(page, { timeout: 60_000 });
      await expect(page.getByTestId("agent-preset-selector")).toBeVisible();
      await page.getByTestId("agent-preset-selector").click();
      if (testInfo.project.name === "phone")
        await page.getByTestId("preset-section-environment").click();
      await expect(page.getByTestId("execution-environment-host-icon").first()).toBeVisible();
      await expect(page.getByTestId("execution-environment-container-icon").first()).toBeVisible();
      await page.getByTestId(`preset-environment-${destinationServerId}`).click();
      await page.getByTestId("preset-account-mock").click();
      await expect(
        page
          .getByTestId(`execution-environment-${destinationKind}-icon`)
          .first()
          .locator("svg")
          .first(),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("profile-environment-cards.png"),
        fullPage: true,
      });
      await page.getByTestId("preset-use-profile").click();
      await expect(page.getByTestId("preset-handoff-modal")).toBeVisible();
      const currentProject = (await sourceClient.listProjects()).projects.find(
        (project) => project.projectRootPath === sourcePath,
      )!;
      const projectName = await page
        .getByTestId(`sidebar-project-row-${currentProject.projectKey}`)
        .evaluate((element) => element.closest('[role="group"]')?.getAttribute("aria-label"));
      expect(projectName).toBeTruthy();
      await expect(page.getByTestId("preset-destination-project")).toHaveCount(0);
      await expect(page.getByTestId("preset-destination-add-project")).toHaveCount(0);
      await page
        .getByTestId("preset-handoff-context")
        .fill("Continue this task in the same project. Preserve the original chat.");
      const directory = page.getByTestId("preset-destination-directory");
      if (destinationMode === "existing") {
        await expect(directory).toHaveValue(destinationPath);
      } else {
        await directory.fill(path.join(root, "does-not-exist"));
        await page.getByTestId("preset-handoff-confirm").click();
        await expect(
          page.getByRole("alert").filter({ hasText: "Directory not found:" }),
        ).toBeVisible();
        await directory.fill(destinationPath);
      }
      await expect(page.getByTestId("preset-handoff-confirm")).toBeEnabled();
      await page.screenshot({
        path: testInfo.outputPath("environment-handoff-review.png"),
        fullPage: true,
      });
      await page.getByTestId("preset-handoff-confirm").click();
      await expect(page.getByTestId("preset-handoff-modal")).not.toBeVisible();
      await expect
        .poll(
          async () =>
            (await destinationClient.fetchAgents()).entries.filter(
              ({ agent }) => agent.labels?.["paseo:continued-from"] === source.id,
            ).length,
        )
        .toBe(1);
      const successor = (await destinationClient.fetchAgents()).entries.find(
        ({ agent }) => agent.labels?.["paseo:continued-from"] === source.id,
      )!.agent;
      expect(successor.cwd).toBe(destinationPath);
      if (destinationWorkspace) expect(successor.workspaceId).not.toBe(destinationWorkspace.id);
      const sourceProject = (await sourceClient.listProjects()).projects.find(
        (project) => project.projectRootPath === sourcePath,
      )!;
      const destinationProject = (await destinationClient.listProjects()).projects.find(
        (project) => project.projectRootPath === destinationPath,
      )!;
      if (destinationMode === "new")
        expect(destinationProject.projectKey).not.toBe(sourceProject.projectKey);
      const workspaces = (await destinationClient.fetchWorkspaces()).entries.filter(
        (workspace) => workspace.projectId === destinationProject.projectId,
      );
      expect(workspaces).toHaveLength(destinationWorkspace ? 2 : 1);
      expect(
        workspaces.find((workspace) => workspace.id === successor.workspaceId)?.projectMembership,
      ).toEqual({ key: sourceProject.projectKey, name: projectName });
      expect(successor.labels?.["paseo:continued-from-server"]).toBe(sourceServerId);
      expect((await sourceClient.fetchAgent(source.id))?.agent.cwd).toBe(sourcePath);
      await expect(page).toHaveURL(new RegExp(`/h/${destinationServerId}/workspace/`));
      if (destinationMode === "existing")
        await verifyCrossEnvironmentDraft({
          page,
          testInfo,
          destinationClient,
          sourceServerId,
          destinationServerId,
          sourcePath,
          destinationPath,
          sourceProject,
        });
      if (destinationMode === "new")
        await verifyCrossEnvironmentWorkspaceMove({
          page,
          testInfo,
          sourceClient,
          destinationClient,
          destinationServerId,
          workspaceId: successor.workspaceId!,
          directory: destinationPath,
        });
    } finally {
      await sourceClient.close();
      await destinationClient.close();
    }
  });
}
