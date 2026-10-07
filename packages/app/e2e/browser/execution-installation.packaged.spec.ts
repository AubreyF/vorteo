import { ProviderOverrideSchema } from "@getpaseo/protocol/provider-config";
import { InstallationSkillPackages } from "../../../server/src/server/execution-installation/settings/skill-packages";
import type { SkillFiles } from "../../../server/src/server/orchestration-skills/internal/inventory";
import { packageHash } from "../../../server/src/server/orchestration-skills/internal/inventory";
import { InstallationSettingsSnapshotSchema } from "@getpaseo/protocol/installation-settings";
import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceOpenRoute,
} from "../../../app/src/utils/host-routes";
import { sidebarProjectForWorkspace } from "../support/helpers/workspace-ui";
import { expectComposerVisible, fillComposerDraft } from "../support/helpers/composer";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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
import {
  createInstallationProfiles,
  startProfileSynchronization,
} from "../../../server/src/server/execution-installation/profiles/runtime";
import {
  createInstallationSettings,
  startSettingsReconciliation,
} from "../../../server/src/server/execution-installation/settings/runtime";
import type { InstallationConfig } from "../../../server/src/server/execution-installation/config";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { RestartJobSchema } from "@getpaseo/protocol/execution-installation";

let root: string;
let origin: string;
let listener: Server;
let restartTimer: ReturnType<typeof setInterval>;
let config: InstallationConfig;
let historicalRestartId: string;
const stopReconciliation: (() => void)[] = [];
const sharedWorkflowId = "installation-browser-profile";
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
  listener = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing installation test port");
  origin = `http://127.0.0.1:${address.port}`;
  for (const kind of ["container", "host"] as const) {
    const home = await mkdtemp(path.join(tmpdir(), `vorteo-${kind}-browser-`));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        daemon: { auth: { password: hashDaemonPassword(`${kind}-test-password`) } },
        agents: {
          providers: {
            mock: {
              label: "Shared fixture provider",
              installationAccountId: "b128cddd-930d-4765-bcae-bd0325d35c1d",
              env: { FIXTURE_LOCATION: kind },
            },
          },
        },
      }),
    );
    const personal = path.join(home, ".agents/skills", `${kind}-personal`);
    await mkdir(personal, { recursive: true });
    await writeFile(
      path.join(personal, "SKILL.md"),
      `---\nname: ${kind}-personal\ndescription: Shared fixture skill\n---\nfixture-content:${kind}\n`,
    );
    const clientConfig = path.join(root, `${kind}-client.json`);
    await writeFile(
      clientConfig,
      JSON.stringify({
        origin,
        token: kind === "host" ? hostToken : guestToken,
        kind: `${kind}-agent`,
      }),
      { mode: 0o600 },
    );
    daemons.push(
      await startIsolatedHostDaemon(`installation-${kind}-${randomUUID()}`, {
        paseoHome: home,
        environment: {
          NODE_ENV: "development",
          HOME: home,
          CODEX_HOME: path.join(home, ".codex"),
          CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
          VORTEO_INSTALLATION_CLIENT_CONFIG: clientConfig,
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
  config.listenPort = address.port;
  config.public.origin = origin;
  historicalRestartId = randomUUID();
  await writeFile(
    path.join(root, "restart-jobs.json"),
    JSON.stringify([
      {
        id: historicalRestartId,
        revision: randomUUID(),
        target: "host",
        requestedBy: "host-agent",
        reason: "Maintenance requested six days ago",
        createdAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:30:00.000Z",
        status: "pending",
        detail: "Approval required",
      },
    ]),
  );
  const profiles = createInstallationProfiles(config);
  const settings = createInstallationSettings(config);
  const app = createInstallationServer(
    config,
    createInstallationRestartExecutor(config),
    pino({ level: "silent" }),
    profiles,
    settings,
  );
  listener.on("request", app);
  restartTimer = setInterval(() => {
    void app.drainRestarts();
  }, 100);
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
  await profiles.synchronize();
  const initial = profiles.snapshot();
  if (!initial) throw new Error("Shared profiles did not initialize");
  await profiles.patch({
    expectedRevision: initial.revision,
    providers: {
      ...initial.providers,
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
      codex: {
        defaults: {},
        preferredModels: [],
        preferredThinkingOptions: [],
        defaultWorkflowId: sharedWorkflowId,
        workflows: [
          { id: sharedWorkflowId, provider: "codex", name: "Installation browser profile" },
        ],
      },
    },
  });
  await profiles.synchronize();
  await settings.reconcile();
  const migrated = settings.snapshot();
  if (!migrated?.conflicts)
    throw new Error("Expected review of distinct fixture directory plugins");
  expect(migrated.conflicts.fields).toEqual(["plugins"]);
  const shared = migrated.conflicts.candidates[host.serverId];
  await settings.update({
    expectedRevision: migrated.revision,
    settings: {
      ...shared,
      resourceExclusions: {
        [host.serverId]: {
          terminalProfileIds: [],
          metadataProviderIds: [],
          pluginIds: ["container-authority-test"],
        },
        [guest.serverId]: {
          terminalProfileIds: [],
          metadataProviderIds: [],
          pluginIds: ["host-authority-test"],
        },
      },
    },
  });
  stopReconciliation.push(
    startProfileSynchronization(profiles, pino({ level: "silent" })),
    startSettingsReconciliation(settings, pino({ level: "silent" })),
  );
});

test.afterEach(async ({ browserName }, info) => {
  if (info.status === info.expectedStatus) return;
  for (const daemon of daemons) {
    await info.attach(`${browserName}-daemon-${daemon.serverId}`, {
      path: path.join(daemon.paseoHome, "daemon.log"),
      contentType: "text/plain",
    });
  }
});

test.afterAll(async () => {
  clearInterval(restartTimer);
  for (const stop of stopReconciliation) stop();
  for (const daemon of daemons.toReversed()) await daemon.close();
  if (listener) {
    const closed = new Promise<void>((resolve) => listener.close(() => resolve()));
    listener.closeAllConnections();
    await closed;
  }
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
  await expect(page.getByTestId("installation-panel").getByRole("alert")).toContainText(
    "Incorrect owner password",
  );
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
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
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
  const oldCard = page
    .locator('[data-testid^="restart-request-"]')
    .filter({ hasText: "Maintenance requested six days ago" });
  await expect(oldCard).toContainText("Approval needed");
  await expect(oldCard).toContainText("Requests do not expire");
  await oldCard.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("No pending restart requests", { exact: true })).toBeVisible();
  await page.getByTestId("restart-history-toggle").click();
  await expect(oldCard).toContainText("Rejected");
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
  const activity = await connectInstallationDaemon(config, "container");
  const directory = path.join(root, "restart-blocker");
  await mkdir(directory);
  const { workspace } = await activity.createWorkspace({
    source: { kind: "directory", path: directory },
  });
  if (!workspace) throw new Error("Missing restart test workspace");
  const blocker = await activity.createAgent({
    config: {
      provider: "mock",
      cwd: directory,
      title: "Finish before restart",
      model: "thirty-minute-stream",
    },
    workspaceId: workspace.id,
    initialPrompt: "Exercise the idle restart queue",
  });
  await expect
    .poll(async () => (await activity.fetchAgent({ agentId: blocker.id }))?.agent.status)
    .toBe("running");
  const beforePid = (await activity.getDaemonStatus()).pid;
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
  await expect(card).toContainText("Finish before restart");
  await page.getByTestId(`restart-queue-${job.id}`).click();
  await expect(card).toContainText("Queued until idle");
  await expect(card).toContainText("Waiting 0h");
  expect((await activity.getDaemonStatus()).pid).toBe(beforePid);
  const banner = page.getByTestId("installation-restart-banner").filter({ visible: true });
  await expect(banner).toContainText("Queued until idle");
  await expect(banner).toContainText("Finish before restart");
  await banner.screenshot({ path: testInfo.outputPath("restart-queued-sidebar.png") });
  await page.reload();
  await expect(page.getByTestId(`restart-request-${job.id}`)).toContainText("Queued until idle");
  await activity.cancelAgent(blocker.id);
  await activity.close();
  await expect(card).toContainText("Restarted", { timeout: 150_000 });
  await expect(card).toContainText("environment identity verified");
  await page.getByRole("button", { name: "All restart requests", exact: true }).click();
  await page.getByTestId("restart-history-toggle").click();
  await expect(card).toContainText("environment identity verified");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("installation-controls.png"), fullPage: true });
});

test("restart links keep rejected and missing requests separate from a pending approval", async ({
  page,
}) => {
  const historical = RestartJobSchema.array()
    .parse(await (await request("owner/restarts/query", ownerPassword, {})).json())
    .find((job) => job.id === historicalRestartId);
  if (!historical) throw new Error("Missing historical restart fixture");
  if (historical.status === "pending") {
    await request(`owner/restarts/${historical.id}/decision`, ownerPassword, {
      revision: historical.revision,
      decision: "reject",
    });
  }
  const pending = RestartJobSchema.parse(
    await (
      await request("restart-requests", hostToken, {
        target: "host",
        reason: "Unrelated pending maintenance",
      })
    ).json(),
  );
  await page.goto(`${origin}/settings/general?installation=1&restart=${historicalRestartId}`);
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId(`restart-request-${historicalRestartId}`)).toContainText(
    "Rejected",
  );
  await expect(page.getByTestId(`restart-request-${pending.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`restart-confirm-${historicalRestartId}`)).toHaveCount(0);
  await page.goto(`${origin}/settings/general?installation=1&restart=${randomUUID()}`);
  await expect(
    page.getByText("This restart request is no longer available.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId(`restart-request-${pending.id}`)).toHaveCount(0);
  await page.goto(`${origin}/settings/general?installation=1&restart=${pending.id}`);
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toBeInViewport();
  await page.reload();
  await expect(page.getByTestId(`restart-confirm-${pending.id}`)).toBeInViewport();
  await expect(page.getByTestId("settings-vorton-mode")).toHaveCount(0);
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
      for (const kind of [sourceKind, destinationKind]) {
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
        await directory.fill(destinationPath);
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

test("profile edits remain shared while environment exclusions change availability", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/profiles`);
  await expect(page.getByTestId("settings-host-picker")).toHaveCount(0);
  const edit = page.getByTestId(`agent-profile-edit-${sharedWorkflowId}`);
  await expect(edit).toHaveCount(1);
  const readProfiles = async () => {
    const response = await page.request.post(`${origin}/api/installation/owner/profiles/read`, {
      headers: { Origin: origin },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const before = await readProfiles();
  await edit.click();
  await page.getByTestId("agent-profile-name-input").fill("Shared everywhere with one exception");
  await page.getByTestId("environment-availability-container").click();
  await page.getByTestId("agent-profile-save-button").click();
  await expect(page.getByTestId("agent-profile-edit-modal")).not.toBeVisible();
  const saved = await readProfiles();
  expect(saved.providers.codex.workflows).toContainEqual(
    expect.objectContaining({
      id: sharedWorkflowId,
      name: "Shared everywhere with one exception",
      excludedEnvironments: ["container"],
    }),
  );
  const stale = await page.request.patch(`${origin}/api/installation/owner/profiles`, {
    headers: { Origin: origin },
    data: { expectedRevision: before.revision, providers: before.providers },
  });
  expect(stale.status()).toBe(409);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () =>
            (await client.getDaemonConfig()).config.sharedProviderPreferences?.providers.codex
              ?.workflows,
        )
        .toEqual(saved.providers.codex.workflows);
    } finally {
      await client.close();
    }
  }
  await page.reload();
  await edit.click();
  await expect(page.getByTestId("agent-profile-name-input")).toHaveValue(
    "Shared everywhere with one exception",
  );
  await page.getByTestId("environment-availability-container").click();
  await page.getByTestId("agent-profile-save-button").click();
  await expect(page.getByTestId("agent-profile-edit-modal")).not.toBeVisible();
  const restored = await readProfiles();
  expect(
    restored.providers.codex.workflows.find(
      (workflow: { id: string }) => workflow.id === sharedWorkflowId,
    ).excludedEnvironments,
  ).toEqual([]);
});

test("shared instructions save once while daemons reject divergent edits and retain local paths", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/agents`);
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  await page
    .getByTestId("host-page-append-system-prompt-input")
    .fill("Shared instructions from the installation editor");
  await page.getByTestId("host-page-append-system-prompt-save").click();
  await expect(page.getByTestId("host-page-append-system-prompt-sheet")).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
        .toContain("Shared instructions from the installation editor");
      const before = (await client.getDaemonConfig()).config;
      await expect(
        client.patchDaemonConfig({ appendSystemPrompt: "Divergent local policy" }),
      ).rejects.toThrow("installation coordinator");
      expect((await client.getDaemonConfig()).config.appendSystemPrompt).toBe(
        before.appendSystemPrompt,
      );
      const terminals = before.terminalProfiles;
      if (!terminals?.length) throw new Error("Missing projected terminal profiles");
      const localPath = path.join(root, `${kind}-local-terminal`);
      await client.patchDaemonConfig({
        terminalProfiles: terminals.map((profile, index) =>
          index === 0 ? Object.assign({}, profile, { cwd: localPath }) : profile,
        ),
      });
      expect((await client.getDaemonConfig()).config.terminalProfiles?.[0].cwd).toBe(localPath);
    } finally {
      await client.close();
    }
  }
  await page.reload();
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  await expect(page.getByTestId("host-page-append-system-prompt-input")).toHaveValue(
    "Shared instructions from the installation editor",
  );
});

test("shared skill selection reviews both environments and preserves the draft when owner access expires", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/agents`);
  await page.getByRole("button", { name: "Choose skills", exact: true }).click();
  await page.getByTestId("skill-selection-all").click();
  const skill = page.getByTestId("skill-selection-list-card").getByRole("checkbox").first();
  const name = await skill.getAttribute("aria-label");
  if (!name) throw new Error("Missing bundled skill");
  await skill.click();
  const cancelled = page.waitForEvent("dialog").then(async (dialog) => {
    const message = dialog.message();
    await dialog.dismiss();
    expect(message).toContain(`Host: ${name}`);
    expect(message).toContain(`Dev container: ${name}`);
    return message;
  });
  await Promise.all([page.getByTestId("skill-selection-save").click(), cancelled]);
  await expect(page.getByTestId("skill-selection-sheet")).toBeVisible();
  for (const daemon of daemons) {
    const file = path.join(daemon.paseoHome, ".agents", "skills", name, "SKILL.md");
    expect((await readFile(file, "utf8")).length).toBeGreaterThan(0);
  }
  const accepted = page.waitForEvent("dialog").then((dialog) => dialog.accept());
  await Promise.all([page.getByTestId("skill-selection-save").click(), accepted]);
  await expect(page.getByTestId("skill-selection-sheet")).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => {
          const status = await client.getAgentSkillsStatus();
          return (
            status.selection.mode === "custom" &&
            !status.selection.skills.includes(name) &&
            !status.installed.includes(name)
          );
        })
        .toBe(true);
    } finally {
      await client.close();
    }
  }
  await page.getByRole("button", { name: "Choose skills", exact: true }).click();
  await expect(skill).not.toBeChecked();
  await skill.click();
  const expiredRefresh = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/installation/owner/settings/read") && response.status() === 401,
  );
  const lock = await page.request.post(`${origin}/api/installation/owner/lock`, {
    headers: { Origin: origin },
  });
  expect(lock.ok()).toBe(true);
  await page.getByTestId("skill-selection-save").click();
  await expect(
    page
      .getByText("Unlock Installation controls in General settings to continue.", { exact: true })
      .last(),
  ).toBeVisible();
  await expect(page.getByTestId("skill-selection-sheet")).toBeVisible();
  await expiredRefresh;
  await expect(page.getByTestId("skill-selection-sheet")).toBeVisible();
  await expect(skill).toBeChecked();
});

test("shared metadata save failure stays visible and retry updates both environments", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
    headers: { Origin: origin },
    data: {},
  });
  expect(read.ok()).toBe(true);
  const snapshot = await read.json();
  const providers = [{ provider: "mock", model: "ten-second-stream" }];
  const seed = await page.request.patch(`${origin}/api/installation/owner/settings`, {
    headers: { Origin: origin },
    data: { expectedRevision: snapshot.revision, settings: { metadataGeneration: { providers } } },
  });
  expect(seed.ok()).toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration.providers)
        .toEqual(providers);
    } finally {
      await client.close();
    }
  }
  await page.goto(`${origin}/settings/metadata`);
  await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const lock = await page.request.post(`${origin}/api/installation/owner/lock`, {
    headers: { Origin: origin },
  });
  expect(lock.ok()).toBe(true);
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await expect(page.getByTestId("metadata-generation-save-error")).toContainText(
    "Unlock Installation controls",
  );
  await expect(page.getByRole("button", { name: "Manual", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      expect((await client.getDaemonConfig()).config.metadataGeneration.providers).toEqual(
        providers,
      );
    } finally {
      await client.close();
    }
  }
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/metadata`);
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("metadata-generation-save-error")).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.metadataGeneration.providers)
        .toEqual([]);
    } finally {
      await client.close();
    }
  }
});

test("shared plugins preserve source review on failure and project one catalog to both environments", async ({
  page,
  context,
}, info) => {
  const repository = path.join(root, "shared-browser-plugin");
  await mkdir(repository);
  await writeFile(
    path.join(repository, "paseo-plugin.json"),
    JSON.stringify({ id: "shared-browser", requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(repository, "index.server.ts"),
    `export default function(server) {
  server.registerProvider({ id: "shared-test-runtime", label: "Shared test runtime", async connect() { throw new Error("No agent connection expected"); } });
  return () => {};
}`,
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Installation Tests"],
    ["config", "user.email", "installation@example.test"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    execFileSync("git", args, { cwd: repository });
  }
  const source = pathToFileURL(repository).href;
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/plugins`);
  await expect(page.getByTestId("shared-plugins-page")).toBeVisible();
  await page.getByTestId("shared-plugin-add").click();
  await page.getByTestId("shared-plugin-source").fill(source);
  await page.getByTestId("shared-plugin-prepare").click();
  await expect(page.getByTestId("shared-plugin-save")).toBeEnabled();
  const lock = await page.request.post(`${origin}/api/installation/owner/lock`, {
    headers: { Origin: origin },
  });
  expect(lock.ok()).toBe(true);
  await page.getByTestId("shared-plugin-save").click();
  await expect(
    page
      .getByText("Unlock Installation controls in General settings to continue.", { exact: true })
      .last(),
  ).toBeVisible();
  await expect(page.getByTestId("shared-plugin-source")).toHaveValue(source);
  const unlock = await context.newPage();
  await unlock.goto(origin);
  await unlock.getByTestId("installation-password").fill(ownerPassword);
  await unlock.getByTestId("installation-unlock").click();
  await expect(unlock.getByTestId("installation-password")).not.toBeVisible();
  await unlock.close();
  await page.getByTestId("shared-plugin-save").click();
  await expect(page.getByTestId("shared-plugin-form")).not.toBeVisible();
  const card = page.getByTestId("shared-plugin-shared-browser");
  await expect(card).toHaveCount(1);
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        });
        const snapshot = await response.json();
        return Object.values(snapshot.sources);
      },
      { timeout: 60_000 },
    )
    .toEqual([
      expect.objectContaining({ pendingRevision: null, error: null }),
      expect.objectContaining({ pendingRevision: null, error: null }),
    ]);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () =>
            (await client.listPlugins()).find((plugin) => plugin.id === "shared-browser")?.status,
        )
        .toBe("running");
    } finally {
      await client.close();
    }
  }
  for (const daemon of daemons) {
    await expect(
      page
        .getByTestId(`shared-plugin-environment-shared-browser-${daemon.serverId}`)
        .getByText("running", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  }
  const providerDefinitionId = "plugin/shared-browser/shared-test-runtime";
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        });
        const snapshot = InstallationSettingsSnapshotSchema.parse(await response.json());
        return snapshot.settings?.providerDefinitions?.find(
          (entry) => entry.id === providerDefinitionId,
        )?.bindings;
      },
      { timeout: 60_000 },
    )
    .toEqual(Object.fromEntries(daemons.map((daemon) => [daemon.serverId, "shared-test-runtime"])));
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () =>
            (await client.getDaemonConfig()).config.providers["shared-test-runtime"]?.enabled,
        )
        .toBe(true);
    } finally {
      await client.close();
    }
  }
  await card.getByRole("switch").click();
  await expect(card.getByRole("switch")).not.toBeChecked();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () =>
            (await client.listPlugins()).find((plugin) => plugin.id === "shared-browser")?.enabled,
        )
        .toBe(false);
    } finally {
      await client.close();
    }
  }
  await card.getByRole("switch").click();
  await expect(card.getByRole("switch")).toBeChecked();
  await expect
    .poll(async () => {
      const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
        headers: { Origin: origin },
        data: {},
      });
      const snapshot = await response.json();
      return Object.values(snapshot.sources);
    })
    .toEqual([
      expect.objectContaining({ pendingRevision: null, error: null }),
      expect.objectContaining({ pendingRevision: null, error: null }),
    ]);
  await page.screenshot({ path: info.outputPath("shared-plugins.png"), fullPage: true });
  await page.goto(`${origin}/settings/environments`);
  const dev = daemons[0]!;
  const availability = page
    .getByTestId(`settings-environment-${dev.serverId}`)
    .getByRole("switch", { name: "Plugin: shared-browser availability", exact: true });
  await expect(availability).toBeChecked();
  await availability.click();
  await expect(availability).not.toBeChecked();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () =>
            (await client.listPlugins()).find((plugin) => plugin.id === "shared-browser")?.enabled,
        )
        .toBe(kind === "host");
    } finally {
      await client.close();
    }
  }
  await availability.click();
  await expect(availability).toBeChecked();
  const client = await connectReadyInstallationDaemon("container");
  try {
    await expect
      .poll(
        async () =>
          (await client.listPlugins()).find((plugin) => plugin.id === "shared-browser")?.status,
      )
      .toBe("running");
  } finally {
    await client.close();
  }
  await page.goto(`${origin}/settings/providers`);
  const providerCard = page.getByTestId(`shared-provider-${providerDefinitionId}`);
  await expect(providerCard).toHaveCount(1);
  await expect(providerCard.getByText("Shared test runtime", { exact: true })).toBeVisible();
  await expect(providerCard.getByText("Offline", { exact: true })).toHaveCount(0);
  await expect(
    providerCard.getByRole("button", { name: "Shared test runtime provider details", exact: true }),
  ).toHaveCount(2);
  await providerCard.screenshot({ path: info.outputPath("plugin-provider-shared.png") });
});

test("directory bindings stay local and preserve an excluded plugin through validation failure and activation", async ({
  page,
}, info) => {
  const dev = daemons[0]!;
  const host = daemons[1]!;
  const directory = path.join(root, "dev-local-binding");
  await cp(path.join(root, "host-plugin"), directory, { recursive: true });
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/environments`);
  const row = page.getByTestId(`plugin-directory-binding-${dev.serverId}-host-authority-test`);
  await row.getByRole("button", { name: "Edit directory", exact: true }).click();
  const input = page.getByTestId("plugin-directory-binding-path");
  await input.fill(path.join(root, "missing-directory"));
  await page.getByTestId("plugin-directory-binding-save").click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Plugin manifest is missing" }),
  ).toBeVisible();
  await expect(input).toHaveValue(path.join(root, "missing-directory"));
  await input.fill(directory);
  await page.getByTestId("plugin-directory-binding-save").click();
  await expect(page.getByTestId("plugin-directory-binding-form")).not.toBeVisible();
  await expect(row).toContainText(directory);
  const client = await connectReadyInstallationDaemon("container");
  const hostClient = await connectReadyInstallationDaemon("host");
  try {
    expect(
      (await client.listPlugins()).find((plugin) => plugin.id === "host-authority-test"),
    ).toMatchObject({ path: directory, enabled: false, status: "disabled" });
    expect(
      (await hostClient.listPlugins()).find((plugin) => plugin.id === "host-authority-test"),
    ).toMatchObject({ path: path.join(root, "host-plugin"), enabled: true, status: "running" });
    const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
      headers: { Origin: origin },
      data: {},
    });
    expect(response.ok()).toBe(true);
    expect(await response.text()).not.toContain(directory);
    await page
      .getByTestId(`settings-environment-${dev.serverId}`)
      .getByRole("switch", { name: "Plugin: host-authority-test availability", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await client.listPlugins()).find((plugin) => plugin.id === "host-authority-test")
            ?.status,
        { timeout: 30_000 },
      )
      .toBe("running");
    expect(
      (await hostClient.listPlugins()).find((plugin) => plugin.id === "host-authority-test")?.path,
    ).toBe(path.join(root, "host-plugin"));
    await expect(
      page.getByTestId(`plugin-directory-binding-${host.serverId}-host-authority-test`),
    ).toContainText(path.join(root, "host-plugin"));
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("local-directory-binding.png"), fullPage: true });
  } finally {
    await client.close();
    await hostClient.close();
  }
});

test("a directory plugin is created once with separate environment paths", async ({
  page,
}, info) => {
  const pluginId = "shared-directory";
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/plugins`);
  await page.getByTestId("shared-plugin-add").click();
  await page.getByRole("button", { name: "Local directories", exact: true }).click();
  await page.getByTestId("shared-plugin-source").fill("invalid directory");
  await page.getByTestId("shared-plugin-prepare").click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter a plugin ID" })).toBeVisible();
  await page.getByTestId("shared-plugin-source").fill(pluginId);
  await page.getByTestId("shared-plugin-prepare").click();
  await page.getByTestId("shared-plugin-save").click();
  await expect(page.getByTestId("shared-plugin-form")).not.toBeVisible();
  await expect(page.getByTestId(`shared-plugin-${pluginId}`)).toHaveCount(1);
  await page
    .getByTestId(`shared-plugin-${pluginId}`)
    .getByRole("button", { name: "Directories", exact: true })
    .click();
  await expect(page).toHaveURL(`${origin}/settings/environments`);
  const paths: string[] = [];
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    const directory = path.join(root, `${kind}-shared-directory`);
    paths.push(directory);
    await cp(path.join(root, `${kind}-plugin`), directory, { recursive: true });
    const serverId = kind === "host" ? daemons[1]!.serverId : daemons[0]!.serverId;
    const row = page.getByTestId(`plugin-directory-binding-${serverId}-${pluginId}`);
    await row.getByRole("button", { name: "Edit directory", exact: true }).click();
    await page.getByTestId("plugin-directory-binding-path").fill(directory);
    await page.getByTestId("plugin-directory-binding-save").click();
    await expect(page.getByTestId("plugin-directory-binding-form")).not.toBeVisible();
    await expect(row).toContainText(directory);
    try {
      await expect
        .poll(async () => (await client.listPlugins()).find((plugin) => plugin.id === pluginId))
        .toMatchObject({ id: pluginId, path: directory, enabled: true, status: "running" });
    } finally {
      await client.close();
    }
  }
  const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
    headers: { Origin: origin },
    data: {},
  });
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  expect(
    snapshot.settings.plugins.filter((plugin: { id: string }) => plugin.id === pluginId),
  ).toEqual([{ id: pluginId, enabled: true, source: { kind: "directory" } }]);
  for (const directory of paths) expect(JSON.stringify(snapshot)).not.toContain(directory);
  await page.goto(`${origin}/settings/plugins`);
  for (const daemon of daemons)
    await expect(
      page
        .getByTestId(`shared-plugin-environment-${pluginId}-${daemon.serverId}`)
        .getByText("running", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`shared-plugin-${pluginId}`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("shared-directory-plugin.png"), fullPage: true });
});

test("personal skill catalog reaches both real environments without exposing package content", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        });
        expect(response.ok()).toBe(true);
        const snapshot = InstallationSettingsSnapshotSchema.parse(await response.json());
        if (!snapshot.settings?.skillLibrary)
          throw new Error("Expected shared personal skill definitions");
        expect(snapshot.settings.skillLibrary.map((skill) => skill.name).sort()).toEqual([
          "container-personal",
          "host-personal",
        ]);
        expect(JSON.stringify(snapshot)).not.toContain("fixture-content:");
        expect(JSON.stringify(snapshot)).not.toContain(root);
        return Object.values(snapshot.sources).every(
          (source) => source.pendingRevision === null && source.error === null,
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const result = await client.readSkillLibrary({ kind: "inventory" });
      if (result.kind !== "inventory") throw new Error("Expected skill inventory");
      for (const name of ["container-personal", "host-personal"]) {
        const skills = result.inventory.skills.filter((skill) => skill.name === name);
        expect([...new Set(skills.flatMap((skill) => skill.providers))].sort()).toEqual([
          "claude",
          "codex",
        ]);
        expect([...new Set(skills.map((skill) => skill.sha256))]).toHaveLength(1);
      }
      const selected = result.inventory.skills.find(
        (skill) => skill.name === "host-personal" && skill.providers.includes("codex"),
      );
      if (!selected) throw new Error("Expected shared Codex skill");
      const exported = await client.readSkillLibrary({ kind: "package", id: selected.id });
      if (exported.kind !== "package") throw new Error("Expected exported package");
      const changed = structuredClone(exported.package);
      changed.files[0].content = Buffer.from(
        "---\nname: host-personal\ndescription: Unapproved change\n---\nChanged locally\n",
      ).toString("base64");
      const contents = new Map(
        changed.files.map((file) => [file.path, Buffer.from(file.content, "base64")]),
      );
      changed.sha256 = packageHash(contents);
      const preview = await client.changeSkillLibrary({ kind: "preview_import", package: changed });
      if (preview.kind !== "preview") throw new Error("Expected staged local change");
      await expect(
        client.changeSkillLibrary({ kind: "apply", previewId: preview.preview.id }),
      ).rejects.toThrow("coordinator");
      const retained = await client.readSkillLibrary({ kind: "package", id: selected.id });
      expect(retained).toEqual(exported);
    } finally {
      await client.close();
    }
  }
});

test("personal skill exclusions retain files and recover from expired owner access", async ({
  page,
  context,
}, info) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
    headers: { Origin: origin },
    data: {},
  });
  const initial = InstallationSettingsSnapshotSchema.parse(await read.json());
  const skill = initial.settings?.skillLibrary?.find((entry) => entry.name === "host-personal");
  const dev = config.public.environments.find((environment) => environment.kind === "container");
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!skill || !dev || !host) throw new Error("Missing shared skill fixture");
  await page.goto(`${origin}/settings/environments`);
  const available = page.getByTestId(
    `resource-availability-${dev.serverId}-skillIdentities-${skill.identity}`,
  );
  await expect(available).toBeChecked();
  const locked = await page.request.post(`${origin}/api/installation/owner/lock`, {
    headers: { Origin: origin },
  });
  expect(locked.ok()).toBe(true);
  await available.click();
  await expect(
    page
      .getByText("Unlock Installation controls in General settings to continue.", { exact: true })
      .last(),
  ).toBeVisible();
  await expect(available).toBeChecked();
  const unlock = await context.newPage();
  await unlock.goto(origin);
  await unlock.getByTestId("installation-password").fill(ownerPassword);
  await unlock.getByTestId("installation-unlock").click();
  await expect(unlock.getByTestId("installation-password")).not.toBeVisible();
  await unlock.close();
  await available.click();
  await expect(available).not.toBeChecked();
  const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
    headers: { Origin: origin },
    data: {},
  });
  const saved = InstallationSettingsSnapshotSchema.parse(await response.json());
  expect(saved.settings?.resourceExclusions[dev.serverId].skillIdentities).toEqual([
    skill.identity,
  ]);
  expect(saved.settings?.resourceExclusions[host.serverId]?.skillIdentities ?? []).toEqual([]);
  const client = await connectReadyInstallationDaemon("container");
  try {
    const inventory = await client.readSkillLibrary({ kind: "inventory" });
    if (inventory.kind !== "inventory") throw new Error("Expected retained package inventory");
    expect(
      inventory.inventory.skills.some(
        (entry) => entry.identity === skill.identity && entry.sha256 === skill.sha256,
      ),
    ).toBe(true);
    const directory = path.join(root, "skill-admission-workspace");
    await mkdir(directory, { recursive: true });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: directory },
      title: "Skill admission fixture",
    });
    if (!created.workspace) throw new Error("Missing workspace fixture");
    const launch = {
      config: {
        provider: "mock",
        cwd: directory,
        title: "Profileless skill admission",
        modeId: "load-test",
      },
      workspaceId: created.workspace.id,
    };
    const before = (await client.fetchAgents()).entries.map((entry) => entry.agent.id);
    await expect(client.createAgent(launch)).rejects.toThrow("no verified session skill filter");
    expect((await client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual(before);
    await available.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("skill-exclusion.png"), fullPage: true });
    await available.click();
    await expect(available).toBeChecked();
    await expect(client.createAgent(launch)).resolves.toMatchObject({ provider: "mock" });
  } finally {
    await client.close();
  }
});

test("shared skill catalog reviews files and preserves drafts through expired owner access", async ({
  page,
  context,
}, info) => {
  const files: SkillFiles = new Map([
    [
      "SKILL.md",
      Buffer.from(
        "---\nname: reviewed-personal\ndescription: Shared review fixture\n---\nReviewed shared instructions\n",
      ),
    ],
    ["run.sh", Buffer.from("echo reviewed\n")],
  ]);
  files.executables = new Set(["run.sh"]);
  const source = {
    repository: "fixture/skills",
    directory: "skills/reviewed-personal",
    revision: "a".repeat(40),
  };
  const store = new InstallationSkillPackages(path.join(root, "shared-settings/skill-packages"));
  let prepared = await store.prepare(source, async () => files);
  // Source transport has dedicated owner-route tests. Keep the browser fixture offline while
  // exercising the real canonical save, private content store, and both daemon projections.
  await page.route("**/api/installation/owner/settings/skills/prepare", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ source: prepared.package.source });
    await route.fulfill({ json: prepared });
  });
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/skills`);
  await expect(page.getByTestId("shared-skill-host-personal")).toBeVisible();
  await expect(page.getByTestId("shared-skill-container-personal")).toBeVisible();
  await page.getByTestId("shared-skill-add").click();
  await page.getByRole("textbox", { name: "Repository", exact: true }).fill(source.repository);
  await page.getByRole("textbox", { name: "Skill directory", exact: true }).fill(source.directory);
  await page.getByRole("textbox", { name: "Commit SHA", exact: true }).fill(source.revision);
  await expect(page.getByTestId("shared-skill-save")).toBeDisabled();
  await page.getByTestId("shared-skill-prepare").click();
  await expect(page.getByTestId("shared-skill-save")).toBeEnabled();
  await page
    .getByTestId("shared-skill-file-run.sh")
    .getByRole("button", { name: "Inspect file", exact: true })
    .click();
  await expect(page.getByText("After: 14 bytes, executable", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("shared-skill-review.png"), fullPage: true });
  const locked = await page.request.post(`${origin}/api/installation/owner/lock`, {
    headers: { Origin: origin },
  });
  expect(locked.ok()).toBe(true);
  await page.getByTestId("shared-skill-save").click();
  await expect(
    page
      .getByText("Unlock Installation controls in General settings to continue.", { exact: true })
      .last(),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Commit SHA", exact: true })).toHaveValue(
    source.revision,
  );
  const unlock = await context.newPage();
  await unlock.goto(origin);
  await unlock.getByTestId("installation-password").fill(ownerPassword);
  await unlock.getByTestId("installation-unlock").click();
  await expect(unlock.getByTestId("installation-password")).not.toBeVisible();
  await unlock.close();
  await page.getByTestId("shared-skill-save").click();
  await expect(page.getByTestId("shared-skill-form")).not.toBeVisible();
  await expect(page.getByTestId("shared-skill-reviewed-personal")).toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () => {
            const result = await client.readSkillLibrary({ kind: "inventory" });
            return (
              result.kind === "inventory" &&
              result.inventory.skills.some(
                (skill) =>
                  skill.identity === prepared.definition.identity &&
                  skill.sha256 === prepared.definition.sha256 &&
                  skill.providers.includes("codex"),
              )
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    } finally {
      await client.close();
    }
  }

  const updatedSource = { ...source, revision: "b".repeat(40) };
  const updatedFiles = new Map([
    [
      "SKILL.md",
      Buffer.from(
        "---\nname: reviewed-personal\ndescription: Shared review fixture\n---\nReviewed shared instructions updated\n",
      ),
    ],
  ]);
  prepared = await store.prepare(updatedSource, async () => updatedFiles);
  await page
    .getByTestId("shared-skill-reviewed-personal")
    .getByRole("button", { name: "Update", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Repository", exact: true })).toHaveValue(
    source.repository,
  );
  await page.getByRole("textbox", { name: "Commit SHA", exact: true }).fill(updatedSource.revision);
  await page.getByTestId("shared-skill-prepare").click();
  await expect(
    page.getByTestId("shared-skill-file-run.sh").getByText("Removed", { exact: true }),
  ).toBeVisible();
  await page.getByTestId("shared-skill-save").click();
  await expect(page.getByTestId("shared-skill-form")).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(
          async () => {
            const result = await client.readSkillLibrary({ kind: "inventory" });
            if (result.kind !== "inventory") return false;
            const skill = result.inventory.skills.find(
              (entry) => entry.identity === prepared.definition.identity,
            );
            return (
              skill?.sha256 === prepared.definition.sha256 &&
              !skill.files.some((file) => file.path === "run.sh")
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);
    } finally {
      await client.close();
    }
  }
  await page
    .getByTestId("shared-skill-reviewed-personal")
    .getByRole("button", { name: "Details", exact: true })
    .click();
  await expect(page.getByTestId("shared-skill-package-review")).toBeVisible();
  await page
    .getByTestId("shared-skill-file-SKILL.md")
    .getByRole("button", { name: "Inspect file", exact: true })
    .click();
  await expect(
    page.getByText("Reviewed shared instructions", { exact: false }).last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).last().click();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page
    .getByTestId("shared-skill-reviewed-personal")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.getByTestId("shared-skill-reviewed-personal")).not.toBeVisible();
  await expect(page.getByTestId("shared-skill-host-personal")).toBeVisible();
  await expect(page.getByTestId("shared-skill-container-personal")).toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const inventory = await client.readSkillLibrary({ kind: "inventory" });
      expect(
        inventory.kind === "inventory" &&
          inventory.inventory.skills.some((skill) => skill.sha256 === prepared.definition.sha256),
      ).toBe(true);
    } finally {
      await client.close();
    }
  }
  await page.screenshot({ path: info.outputPath("shared-skill-catalog.png"), fullPage: true });
});

test("shared provider policy projects through authenticated admission without moving local bindings", async ({
  page,
}) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const initial = await read();
  const definitions = initial.settings?.providerDefinitions;
  const shared = definitions?.find((entry) => entry.providerType === "mock");
  if (!shared || !definitions) throw new Error("Missing shared provider fixture");
  expect(Object.keys(shared.bindings)).toHaveLength(2);
  for (const daemon of daemons)
    expect(
      definitions.some(
        (entry) => entry.providerType === "claude" && entry.bindings[daemon.serverId] === "claude",
      ),
    ).toBe(true);
  const providerDefinitions = definitions.map((entry) =>
    entry.id === shared.id
      ? Object.assign({}, entry, {
          policy: Object.assign({}, entry.policy, { label: "Updated once", enabled: true }),
        })
      : entry,
  );
  const response = await page.request.patch(`${origin}/api/installation/owner/settings`, {
    headers: { Origin: origin },
    data: { expectedRevision: initial.revision, settings: { providerDefinitions } },
  });
  expect(response.ok()).toBe(true);
  const saved = InstallationSettingsSnapshotSchema.parse(await response.json());
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every(
          (status) => status.appliedRevision === saved.revision && status.pendingRevision === null,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const localConfig = (await client.getDaemonConfig()).config;
      expect(localConfig.providers.mock).toMatchObject({
        label: "Updated once",
        enabled: true,
        env: { FIXTURE_LOCATION: kind },
      });
      await expect(
        client.patchDaemonConfig({ providers: { mock: { label: "Independent" } } }),
      ).rejects.toThrow("installation coordinator");
      await client.patchDaemonConfig({
        providers: { mock: { env: { FIXTURE_LOCATION: kind, LOCAL_ONLY: "retained" } } },
      });
      expect((await client.getDaemonConfig()).config.providers.mock.env).toMatchObject({
        LOCAL_ONLY: "retained",
      });
    } finally {
      await client.close();
    }
  }
  expect(JSON.stringify(saved)).not.toContain("FIXTURE_LOCATION");
});

test("shared account setup preserves the catalog through retries and local removal", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const initial = await read();
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  const definitions = initial.settings?.providerDefinitions;
  if (!definitions) throw new Error("Provider catalog is not initialized");
  const response = await page.request.patch(`${origin}/api/installation/owner/settings`, {
    headers: { Origin: origin },
    data: {
      expectedRevision: initial.revision,
      settings: {
        providerDefinitions: [
          ...definitions,
          {
            id: `managed/${creationId}`,
            providerType: "codex",
            accountSetup: { provider: "codex", creationId },
            bindings: Object.fromEntries(daemons.map((daemon) => [daemon.serverId, providerId])),
            policy: { label: "Shared empty account", enabled: true },
          },
        ],
      },
    },
  });
  expect(response.ok()).toBe(true);
  const saved = InstallationSettingsSnapshotSchema.parse(await response.json());
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every(
          (status) => status.appliedRevision === saved.revision && status.pendingRevision === null,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  const homes: unknown[] = [];
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const localConfig = (await client.getDaemonConfig()).config;
      expect(localConfig.providers[providerId]).toMatchObject({
        extends: "codex",
        label: "Shared empty account",
        enabled: true,
      });
      homes.push(localConfig.providers[providerId].env);
      await expect(client.createCodexAccount(creationId, "Retry name")).resolves.toMatchObject({
        providerId,
        name: "Shared empty account",
      });
      await expect(client.createCodexAccount(randomUUID(), "Independent account")).rejects.toThrow(
        "shared provider catalog",
      );
      expect(
        Object.keys((await client.getDaemonConfig()).config.providers).filter(
          (id) => id === providerId,
        ),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  }
  expect(homes[0]).not.toEqual(homes[1]);
  expect(JSON.stringify(await read())).not.toContain("CODEX_HOME");
  const host = await connectReadyInstallationDaemon("host");
  const container = await connectReadyInstallationDaemon("container");
  try {
    await expect
      .poll(
        async () => {
          try {
            await host.previewProviderRemoval(providerId);
            return true;
          } catch (error) {
            if (error instanceof Error && error.message.includes("refresh")) return false;
            throw error;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const preview = await host.previewProviderRemoval(providerId);
    const hostConfig = (await host.getDaemonConfig()).config;
    const home = ProviderOverrideSchema.parse(hostConfig.providers[providerId]).env?.CODEX_HOME;
    if (!home) throw new Error("Missing isolated account home");
    await mkdir(home, { recursive: true });
    const auth = path.join(home, "auth.json");
    await writeFile(auth, "fixture credential", { mode: 0o600 });
    await expect(host.removeProvider(providerId, preview.plan.revision)).rejects.toThrow("Exclude");
    expect(await readFile(auth, "utf8")).toBe("fixture credential");
    const current = await read();
    const hostServerId = config.public.environments.find(
      (entry) => entry.kind === "host",
    )!.serverId;
    await page.goto(`${origin}/settings/providers`);
    const remove = page.getByTestId(`shared-provider-remove-managed/${creationId}-${hostServerId}`);
    await expect(remove).toBeEnabled({ timeout: 60_000 });
    let dialog = page.waitForEvent("dialog");
    let click = remove.click();
    const cancelled = await dialog;
    expect(cancelled.message()).toContain("from Host");
    expect(cancelled.message()).toContain("other environments will remain");
    await cancelled.dismiss();
    await click;
    expect((await read()).settings?.resourceExclusions).toEqual(
      current.settings?.resourceExclusions,
    );
    expect(await readFile(auth, "utf8")).toBe("fixture credential");
    await expect(remove).toBeEnabled();
    dialog = page.waitForEvent("dialog");
    click = remove.click();
    const stale = await dialog;
    const concurrent = await page.request.patch(`${origin}/api/installation/owner/settings`, {
      headers: { Origin: origin },
      data: {
        expectedRevision: current.revision,
        settings: { autoArchiveAfterMerge: !current.settings!.autoArchiveAfterMerge },
      },
    });
    expect(concurrent.ok()).toBe(true);
    await stale.accept();
    await click;
    await expect(
      page.getByTestId(`shared-provider-remove-error-managed/${creationId}-${hostServerId}`),
    ).toContainText("Shared settings changed");
    expect(await readFile(auth, "utf8")).toBe("fixture credential");
    await page
      .getByTestId(`shared-provider-managed/${creationId}`)
      .screenshot({ path: testInfo.outputPath("removal-conflict.png") });
    await expect
      .poll(async () => (await read()).sources[hostServerId].pendingRevision, { timeout: 60_000 })
      .toBeNull();
    await expect
      .poll(
        async () => {
          try {
            await host.previewProviderRemoval(providerId);
            return true;
          } catch (error) {
            if (error instanceof Error && error.message.includes("refresh")) return false;
            throw error;
          }
        },
        { timeout: 60_000 },
      )
      .toBe(true);

    await expect(remove).toBeEnabled();
    dialog = page.waitForEvent("dialog");
    click = remove.click();
    await (await dialog).accept();
    await click;
    await expect(remove).not.toBeVisible({ timeout: 60_000 });
    await page
      .getByTestId(`shared-provider-managed/${creationId}`)
      .screenshot({ path: testInfo.outputPath("removal-complete.png") });
    await expect(readFile(auth, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await read();
    expect((await host.getDaemonConfig()).config.providers[providerId]).toMatchObject({
      removed: true,
      enabled: false,
      env: hostConfig.providers[providerId].env,
    });
    expect((await container.getDaemonConfig()).config.providers[providerId].enabled).toBe(true);
    expect((await read()).settings?.providerDefinitions).toEqual(
      saved.settings?.providerDefinitions,
    );
    await expect(host.createCodexAccount(creationId, "Shared empty account")).rejects.toThrow(
      "removed",
    );
    const restore = page.getByTestId(
      `shared-provider-restore-managed/${creationId}-${hostServerId}`,
    );
    await expect(restore).toBeVisible();
    await restore.click();
    await expect(restore).not.toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText("Connection restored. Sign in if needed", { exact: false }),
    ).toBeVisible();
    const restored = (await host.getDaemonConfig()).config.providers[providerId];
    expect(restored).toMatchObject({
      removed: false,
      enabled: false,
      env: hostConfig.providers[providerId].env,
    });
    await expect(readFile(auth, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await read()).settings?.resourceExclusions[hostServerId].providerIds).toContain(
      `managed/${creationId}`,
    );
    expect((await container.getDaemonConfig()).config.providers[providerId].enabled).toBe(true);
    await expect(
      page
        .getByTestId(`shared-provider-environment-managed/${creationId}-${hostServerId}`)
        .getByTestId(`provider-connect-${providerId}`),
    ).toBeVisible();
    await page
      .getByTestId(`shared-provider-managed/${creationId}`)
      .screenshot({ path: testInfo.outputPath("restored-binding.png") });
  } finally {
    await host.close();
    await container.close();
  }
});

test("Add Account saves one shared definition and opens local sign-in", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/providers`);
  await page.getByTestId("add-codex-account").first().click();
  await page.getByTestId("codex-account-name").fill("Shared form account");
  await page.getByTestId("codex-account-create").click();
  await expect(page.getByTestId("provider-login-panel")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Shared across environments.", { exact: false })).toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const snapshot = await read();
  const definitions = snapshot.settings?.providerDefinitions?.filter(
    (definition) => definition.policy.label === "Shared form account",
  );
  expect(definitions).toHaveLength(1);
  const definition = definitions?.[0];
  if (!definition) throw new Error("Account form did not save the shared definition");
  expect(Object.keys(definition.bindings).sort()).toEqual(
    daemons.map((daemon) => daemon.serverId).sort(),
  );
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every(
          (status) =>
            status.appliedRevision === snapshot.revision && status.pendingRevision === null,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath("shared-account-form.png"), fullPage: true });
  await page.getByTestId("codex-account-done").click();
  await expect(page.getByTestId("add-codex-account-dialog")).not.toBeVisible();
});

test("provider environment exceptions disable Host access while retaining Dev and account bindings", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const initial = await read();
  const definition = initial.settings?.providerDefinitions?.find(
    (entry) => entry.providerType === "mock",
  );
  if (!definition) throw new Error("Missing shared provider fixture");
  const host = config.public.environments.find((environment) => environment.kind === "host");
  if (!host) throw new Error("Missing host fixture");
  await page.goto(`${origin}/settings/environments`);
  const toggle = page.getByTestId(
    `resource-availability-${host.serverId}-providerIds-${definition.id}`,
  );
  await toggle.click();
  await expect
    .poll(async () => (await read()).settings?.resourceExclusions[host.serverId]?.providerIds)
    .toContain(definition.id);
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every((status) => status.pendingRevision === null),
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      const localConfig = (await client.getDaemonConfig()).config;
      expect(localConfig.providers.mock.enabled !== false).toBe(kind === "container");
      expect(localConfig.providers.mock.env).toMatchObject({ FIXTURE_LOCATION: kind });
    } finally {
      await client.close();
    }
  }
  expect((await read()).settings?.providerDefinitions).toEqual(
    initial.settings?.providerDefinitions,
  );
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("provider-environment-exception.png"),
    fullPage: true,
  });
  await toggle.click();
  await expect
    .poll(async () => (await read()).settings?.resourceExclusions[host.serverId]?.providerIds ?? [])
    .not.toContain(definition.id);
});

test("custom model edits from a provider sheet update both environments", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/providers`);
  await page
    .getByRole("button", { name: "Shared fixture provider provider details", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await page.getByTestId("custom-model-id").fill("shared-custom-model");
  await page.getByTestId("custom-model-save").click();
  await expect(page.getByTestId("custom-model-id")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  await expect
    .poll(
      async () =>
        (await read()).settings?.providerDefinitions?.find(
          (definition) => definition.providerType === "mock",
        )?.policy.additionalModels,
    )
    .toEqual([{ id: "shared-custom-model", label: "shared-custom-model" }]);
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every((status) => status.pendingRevision === null),
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      expect((await client.getDaemonConfig()).config.providers.mock.additionalModels).toEqual([
        { id: "shared-custom-model", label: "shared-custom-model" },
      ]);
    } finally {
      await client.close();
    }
  }
  await page.getByTestId("provider-settings-search").fill("shared-custom-model");
  await page.getByRole("button", { name: "Remove shared-custom-model", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).settings?.providerDefinitions?.find(
          (definition) => definition.providerType === "mock",
        )?.policy.additionalModels,
    )
    .toEqual([]);
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every((status) => status.pendingRevision === null),
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(
    page.getByTestId("provider-settings-sheet").getByText("shared-custom-model", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("shared-model-editor.png"), fullPage: true });
});

test("single provider catalog shares rename enablement and ordering across environments", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const initial = await read();
  const definition = initial.settings?.providerDefinitions?.find(
    (entry) => entry.providerType === "mock",
  );
  if (!definition) throw new Error("Missing shared provider fixture");
  await page.goto(`${origin}/settings/providers`);
  await expect(page.getByTestId(`shared-provider-${definition.id}`)).toHaveCount(1);
  await expect(page.getByTestId("host-page-providers-card")).toHaveCount(0);
  for (const daemon of daemons)
    await expect(
      page.getByTestId(`shared-provider-environment-${definition.id}-${daemon.serverId}`),
    ).toBeVisible();
  await page.getByTestId(`shared-provider-rename-${definition.id}`).click();
  await page.getByTestId("shared-provider-rename-dialog-input").fill("One shared provider");
  await page.getByTestId("shared-provider-rename-dialog-submit").click();
  await expect(page.getByTestId("shared-provider-rename-dialog-input")).not.toBeVisible();
  await page.getByTestId(`shared-provider-enabled-${definition.id}`).click();
  await expect
    .poll(
      async () =>
        (await read()).settings?.providerDefinitions?.find((entry) => entry.id === definition.id)
          ?.policy.enabled,
    )
    .toBe(false);
  await expect
    .poll(
      async () =>
        Object.values((await read()).sources).every((status) => status.pendingRevision === null),
      { timeout: 60_000 },
    )
    .toBe(true);
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      expect((await client.getDaemonConfig()).config.providers.mock).toMatchObject({
        label: "One shared provider",
        enabled: false,
      });
    } finally {
      await client.close();
    }
  }
  await page.getByTestId(`shared-provider-enabled-${definition.id}`).click();
  await expect
    .poll(
      async () =>
        (await read()).settings?.providerDefinitions?.find((entry) => entry.id === definition.id)
          ?.policy.enabled,
    )
    .toBe(true);
  await expect(page.getByText("Saving shared provider settings...", { exact: true })).toHaveCount(
    0,
  );
  await expect
    .poll(async () =>
      Object.values((await read()).sources).every((source) => source.pendingRevision === null),
    )
    .toBe(true);
  await expect(
    page.getByText(
      "Shared settings are saved. Some environments are still waiting to apply them.",
      { exact: true },
    ),
  ).toHaveCount(0);
  const ordered = [...(initial.settings?.providerDefinitions ?? [])].sort(
    (left, right) =>
      (left.policy.order ?? Number.MAX_SAFE_INTEGER) -
      (right.policy.order ?? Number.MAX_SAFE_INTEGER),
  );
  const next = ordered[ordered.findIndex((entry) => entry.id === definition.id) + 1];
  if (!next) throw new Error("Missing reorder destination fixture");
  const drag = page.getByTestId(`shared-provider-drag-${definition.id}`);
  await drag.focus();
  await page.keyboard.press("Space");
  await expect(drag).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[id^="DndLiveRegion-"]')).toContainText(
    `over droppable area ${next.id}`,
  );
  await page.keyboard.press("Space");
  await expect
    .poll(
      async () =>
        (await read()).settings?.providerDefinitions?.find((entry) => entry.id === definition.id)
          ?.policy.order,
    )
    .toBe(1);
  await page.getByTestId(`shared-provider-${definition.id}`).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("shared-provider-catalog.png"),
    fullPage: true,
  });
});

test("catalog enrollment failure stays visible and does not install an independent runtime", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/providers`);
  await page.getByTestId("provider-catalog-search").fill("Auggie");
  const add = page
    .getByTestId("host-page-add-provider-card")
    .getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeEnabled();
  const journal = path.join(root, "shared-settings", "state.json");
  const backup = path.join(root, "shared-settings", "state.enrollment-backup.json");
  await rename(journal, backup);
  await mkdir(journal);
  try {
    await add.click();
    await expect(page.getByTestId("provider-install-error")).toContainText(
      "Unable to access shared installation settings",
    );
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.getByTestId("provider-install-error")).toBeVisible();
    await expect(add).toBeEnabled();
    const snapshot = InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
    expect(
      snapshot.settings?.providerDefinitions?.filter((entry) => entry.id === "catalog/acp/auggie"),
    ).toEqual([]);
    const client = await connectReadyInstallationDaemon("host");
    try {
      expect((await client.getDaemonConfig()).config.providers.auggie).toBeUndefined();
    } finally {
      await client.close();
    }
    await page.getByTestId("provider-install-error").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("catalog-install-error.png") });
  } finally {
    await rm(journal, { recursive: true });
    await rename(backup, journal);
  }
});

test("catalog runtime enrollment reuses one disabled shared provider across both environments", async ({
  page,
}, testInfo) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const read = async () =>
    InstallationSettingsSnapshotSchema.parse(
      await (
        await page.request.post(`${origin}/api/installation/owner/settings/read`, {
          headers: { Origin: origin },
          data: {},
        })
      ).json(),
    );
  const initial = await read();
  const id = "catalog/acp/auggie";
  const created = await page.request.patch(`${origin}/api/installation/owner/settings`, {
    headers: { Origin: origin },
    data: {
      expectedRevision: initial.revision,
      settings: {
        providerDefinitions: [
          ...(initial.settings?.providerDefinitions ?? []),
          {
            id,
            providerType: "auggie",
            bindings: {},
            policy: { label: "Shared catalog runtime", enabled: false },
          },
        ],
      },
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto(`${origin}/settings/providers`);
  await expect(page.getByTestId(`shared-provider-${id}`)).toBeVisible();
  for (const kind of ["host", "container"] as const) {
    await page
      .getByTestId("provider-runtime-environment")
      .getByText(kind === "host" ? "Host" : "Dev container", { exact: true })
      .click();
    await page.getByTestId("provider-catalog-search").fill("Auggie");
    const add = page
      .getByTestId("host-page-add-provider-card")
      .getByRole("button", { name: "Add", exact: true });
    await add.click();
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.providers.auggie)
        .toMatchObject({
          extends: "acp",
          label: "Shared catalog runtime",
          enabled: false,
        });
    } finally {
      await client.close();
    }
    await expect(
      page
        .getByTestId("host-page-add-provider-card")
        .getByRole("button", { name: "Adding", exact: true }),
    ).toHaveCount(0);
    await expect(add).toHaveCount(0);
    await expect(page.getByTestId("provider-install-error")).toHaveCount(0);
  }
  const definitions = (await read()).settings?.providerDefinitions?.filter(
    (entry) => entry.id === id,
  );
  expect(definitions).toEqual([
    {
      id,
      providerType: "auggie",
      bindings: Object.fromEntries(daemons.map((daemon) => [daemon.serverId, "auggie"])),
      policy: { label: "Shared catalog runtime", enabled: false },
    },
  ]);
  await page.getByTestId(`shared-provider-${id}`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("shared-catalog-enrollment.png") });
});

test("browser tools share one default with explicit environment exceptions", async ({
  page,
}, info) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  await page.goto(`${origin}/settings/agents`);
  const toggle = page.getByTestId("host-page-browser-tools-switch");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.browserTools.enabled)
        .toBe(true);
      await expect(client.patchDaemonConfig({ browserTools: { enabled: false } })).rejects.toThrow(
        "installation coordinator",
      );
      expect((await client.getDaemonConfig()).config.browserTools.enabled).toBe(true);
    } finally {
      await client.close();
    }
  }
  await page.goto(`${origin}/settings/environments`);
  const dev = daemons[0]!;
  const availability = page
    .getByTestId(`settings-environment-${dev.serverId}`)
    .getByRole("switch", { name: "Browser tools availability", exact: true });
  await expect(availability).toBeChecked();
  await availability.click();
  await expect(availability).not.toBeChecked();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.browserTools.enabled)
        .toBe(kind === "host");
    } finally {
      await client.close();
    }
  }
  await page.screenshot({
    path: info.outputPath("browser-environment-exception.png"),
    fullPage: true,
  });
  await page.goto(`${origin}/settings/agents`);
  await expect(toggle).toBeChecked();
  await page.route(
    "**/api/installation/owner/settings",
    async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const data = route.request().postDataJSON();
      const response = await route.fetch({ postData: { ...data, expectedRevision: 0 } });
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await toggle.click();
  await expect(page.getByTestId("host-page-browser-tools-error")).toBeVisible();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("host-page-browser-tools-error")).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.browserTools.enabled)
        .toBe(false);
    } finally {
      await client.close();
    }
  }
});

test("shared policy saves preserve drafts and show retryable errors", async ({ page }, info) => {
  await page.goto(origin);
  await page.getByTestId("installation-password").fill(ownerPassword);
  await page.getByTestId("installation-unlock").click();
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
  const rejectNextSave = async () => {
    await page.route(
      "**/api/installation/owner/settings",
      async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        const data = route.request().postDataJSON();
        const response = await route.fetch({ postData: { ...data, expectedRevision: 0 } });
        await route.fulfill({ response });
      },
      { times: 1 },
    );
  };
  for (const field of [
    { section: "agents", card: "host-page-inject-mcp-card", property: "mcp" },
    {
      section: "workspaces",
      card: "host-page-auto-archive-merged-workspaces-card",
      property: "autoArchiveAfterMerge",
    },
    {
      section: "terminals",
      card: "host-page-terminal-agent-hooks-card",
      property: "enableTerminalAgentHooks",
    },
  ] as const) {
    await page.goto(`${origin}/settings/${field.section}`);
    const card = page.getByTestId(field.card);
    const toggle = card.getByRole("switch");
    await expect(toggle).toBeVisible();
    const before = await toggle.isChecked();
    await rejectNextSave();
    await toggle.click();
    await expect(card.getByRole("alert")).toBeVisible();
    await expect(toggle).toBeChecked({ checked: before });
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !before });
    await expect(card.getByRole("alert")).not.toBeVisible();
    for (const kind of ["host", "container"] as const) {
      const client = await connectReadyInstallationDaemon(kind);
      try {
        await expect
          .poll(async () => {
            const settings = (await client.getDaemonConfig()).config;
            return field.property === "mcp"
              ? settings.mcp.injectIntoAgents
              : settings[field.property];
          })
          .toBe(!before);
      } finally {
        await client.close();
      }
    }
  }
  await page.goto(`${origin}/settings/agents`);
  await page.getByTestId("host-page-append-system-prompt-edit").click();
  const draft = page.getByTestId("host-page-append-system-prompt-input");
  await draft.fill("Keep my unsaved instructions");
  const response = await page.request.post(`${origin}/api/installation/owner/settings/read`, {
    headers: { Origin: origin },
  });
  const snapshot = await response.json();
  const concurrent = await page.request.patch(`${origin}/api/installation/owner/settings`, {
    headers: { Origin: origin },
    data: {
      expectedRevision: snapshot.revision,
      settings: { appendSystemPrompt: "Concurrent saved instructions" },
    },
  });
  expect(concurrent.ok()).toBe(true);
  await rejectNextSave();
  await page.getByTestId("host-page-append-system-prompt-save").click();
  const sheet = page.getByTestId("host-page-append-system-prompt-sheet");
  await expect(
    page.getByRole("alert").filter({ hasText: "Shared settings changed" }),
  ).toBeVisible();
  await expect(page.getByTestId("host-page-append-system-prompt-card")).toContainText(
    "Concurrent saved instructions",
  );
  await expect(draft).toHaveValue("Keep my unsaved instructions");
  await page.screenshot({
    path: info.outputPath("shared-settings-draft-conflict.png"),
    fullPage: true,
  });
  await page.getByTestId("host-page-append-system-prompt-save").click();
  await expect(sheet).not.toBeVisible();
  for (const kind of ["host", "container"] as const) {
    const client = await connectReadyInstallationDaemon(kind);
    try {
      await expect
        .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
        .toContain("Keep my unsaved instructions");
    } finally {
      await client.close();
    }
  }
  await page.goto(`${origin}/settings/environments`);
  await expect(page.getByTestId(`installation-maintenance-${daemons[0]!.serverId}`)).toBeVisible();
  await expect(page.getByTestId("host-page-restart-button")).toHaveCount(0);
  await page.getByTestId(`installation-maintenance-${daemons[0]!.serverId}`).click();
  await expect(page).toHaveURL(/settings\/general\?installation=1/);
  await expect(page.getByTestId("installation-password")).not.toBeVisible();
});

for (const sourceKind of ["host", "container"] as const) {
  test(`new tasks switch from ${sourceKind} without abandoning the draft or workspace`, async ({
    page,
  }, info) => {
    const sourceIndex = sourceKind === "host" ? 1 : 0;
    const destinationIndex = sourceKind === "host" ? 0 : 1;
    const destinationKind = sourceKind === "host" ? "container" : "host";
    const sourceDaemon = daemons[sourceIndex]!;
    const destinationDaemon = daemons[destinationIndex]!;
    const source = await connectInstallationDaemon(config, sourceKind);
    const destination = await connectInstallationDaemon(config, destinationKind);
    const sourceDirectory = path.join(sourceDaemon.paseoHome, "draft-source");
    const destinationDirectory = path.join(destinationDaemon.paseoHome, "draft-destination");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(destinationDirectory, { recursive: true });
    try {
      const created = await source.createWorkspace({
        source: { kind: "directory", path: sourceDirectory },
        title: "Mixed environment work",
      });
      if (!created.workspace) throw new Error(created.error ?? "Missing test workspace");
      const workspace = created.workspace;
      const before = (await destination.fetchWorkspaces()).entries.map((item) => item.id);
      const uploadDirectory = path.join(destinationDaemon.paseoHome, "uploads");
      const previousUploads = await readdir(uploadDirectory, { recursive: true }).catch(
        () => [] as string[],
      );
      await page.goto(origin);
      await page.getByTestId("installation-password").fill(ownerPassword);
      await page.getByTestId("installation-unlock").click();
      await expect(page.getByTestId("installation-password")).not.toBeVisible();
      const openDraft = (id: string) =>
        page.goto(
          `${origin}${buildHostWorkspaceOpenRoute(sourceDaemon.serverId, workspace.id, `draft:${id}`)}`,
        );
      await openDraft(`environment-${sourceKind}`);
      await expectComposerVisible(page, { timeout: 60_000 });
      await fillComposerDraft(page, "Keep this exact draft while switching environments.");
      await page.getByRole("button", { name: "Add attachment", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByText("Upload file", { exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: "environment-notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Keep these attachment bytes."),
      });
      await expect(page.getByTestId("composer-file-attachment-pill")).toContainText(
        "environment-notes.txt",
      );
      await page.getByTestId("task-environment").getByRole("button").click();
      if (destinationKind === "host") page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByText(destinationKind === "host" ? "Host" : "Dev container", { exact: true })
        .last()
        .click();
      await expect(
        page.getByText(
          `Choose this workspace's folder in ${destinationKind === "host" ? "Host" : "Dev container"}.`,
        ),
      ).toBeVisible();
      await expect(page.getByTestId("preset-handoff-modal")).toHaveCount(0);
      expect((await destination.fetchWorkspaces()).entries.map((item) => item.id)).toEqual(before);
      await page.getByTestId("task-environment-folder").click();
      await page.getByTestId("project-directory-host-path").fill("/missing-task-directory");
      await page.getByTestId("project-directory-open-path").click();
      await expect(page.getByTestId("project-directory-error")).toBeVisible();
      await page.getByRole("button", { name: "Shared folders", exact: true }).click();
      await page.getByTestId("project-directory-root-home").click();
      await page.getByTestId("project-directory-child-draft-destination").click();
      await page.getByRole("button", { name: "Select this folder", exact: true }).click();
      await expect(page.getByTestId("task-environment")).toContainText(
        destinationKind === "host" ? "Host" : "Dev container",
      );
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue(
        "Keep this exact draft while switching environments.",
      );
      await page.screenshot({
        path: info.outputPath("task-environment-draft.png"),
        fullPage: true,
      });
      await page.getByTestId("agent-preset-selector").click();
      await expect(page.getByTestId("preset-environment-card")).toHaveCount(0);
      if (info.project.name === "phone") await page.getByTestId("preset-section-account").click();
      await page.getByTestId("preset-account-mock").click();
      await page.getByTestId("preset-use-profile").click();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await destination.fetchAgents()).entries.filter(
              ({ agent }) => agent.cwd === destinationDirectory,
            ).length,
        )
        .toBe(1);
      const task = (await destination.fetchAgents()).entries.find(
        ({ agent }) => agent.cwd === destinationDirectory,
      )!.agent;
      const uploadedFiles = (await readdir(uploadDirectory, { recursive: true })).filter(
        (file) => file.endsWith("environment-notes.txt") && !previousUploads.includes(file),
      );
      expect(uploadedFiles).toHaveLength(1);
      expect(await readFile(path.join(uploadDirectory, uploadedFiles[0]!), "utf8")).toBe(
        "Keep these attachment bytes.",
      );
      const companion = (await destination.fetchWorkspaces()).entries.find(
        (item) => item.id === task.workspaceId,
      )!;
      expect(companion.projectMembership?.environmentOwner).toEqual({
        serverId: sourceDaemon.serverId,
        workspaceId: workspace.id,
      });
      await expect(page).toHaveURL(
        new RegExp(`/h/${sourceDaemon.serverId}/workspace/${workspace.id}`),
      );
      await page.reload();
      await expectComposerVisible(page, { timeout: 60_000 });
      if (info.project.name === "desktop") {
        await expect(
          page.getByTestId(`sidebar-workspace-row-${sourceDaemon.serverId}:${workspace.id}`),
        ).toBeVisible();
        await expect(
          page.getByTestId(`sidebar-workspace-row-${destinationDaemon.serverId}:${companion.id}`),
        ).toHaveCount(0);
      }
      await page.screenshot({
        path: info.outputPath("mixed-environment-workspace.png"),
        fullPage: true,
      });
      await openDraft(`second-environment-${sourceKind}`);
      await expectComposerVisible(page, { timeout: 60_000 });
      await page.getByTestId("task-environment").getByRole("button").click();
      if (destinationKind === "host") page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByText(destinationKind === "host" ? "Host" : "Dev container", { exact: true })
        .last()
        .click();
      await expect(page.getByText(destinationDirectory, { exact: true })).toBeVisible();
      await expect(page.getByTestId("task-environment-folder")).toHaveCount(0);
      expect(
        (await destination.fetchWorkspaces()).entries.filter((item) => !before.includes(item.id)),
      ).toHaveLength(1);
      await page.goto(`${origin}/new?serverId=${sourceDaemon.serverId}`);
      await expectComposerVisible(page, { timeout: 60_000 });
      await fillComposerDraft(page, "Keep the new workspace draft too.");
      await page.getByTestId("new-workspace-environment").getByRole("button").click();
      if (destinationKind === "host") page.once("dialog", (dialog) => void dialog.accept());
      await page
        .getByText(destinationKind === "host" ? "Host" : "Dev container", { exact: true })
        .last()
        .click();
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toHaveValue(
        "Keep the new workspace draft too.",
      );
      await expect(page.getByTestId("preset-handoff-modal")).toHaveCount(0);
      await expect(page.getByText("Environment", { exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /^(Send message|Create)$/ })).toBeInViewport();
      await page.screenshot({
        path: info.outputPath("new-workspace-environment.png"),
        fullPage: true,
      });
    } finally {
      await source.close();
      await destination.close();
    }
  });
}
