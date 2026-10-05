import { buildHostAgentDetailRoute } from "../../../app/src/utils/host-routes";
import { expectComposerVisible } from "../support/helpers/composer";
import { test, expect } from "@playwright/test";
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
  await writeFile(
    path.join(root, "restart-jobs.json"),
    JSON.stringify([
      {
        id: randomUUID(),
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
  await page.goto(`${origin}/settings/general?installation=1`);
  await expect(page.getByTestId("installation-status-container-daemon")).toContainText(
    "Approval needed",
  );
  const card = page.getByTestId(`restart-request-${job.id}`);
  await expect(card).toContainText("Approval needed");
  page.on("dialog", () => {
    throw new Error("Installation controls must not open browser dialogs");
  });
  await page.getByTestId(`restart-approve-${job.id}`).click();
  await expect(page.getByTestId(`restart-confirmation-${job.id}`)).toContainText(
    "may be interrupted",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await card.screenshot({ path: testInfo.outputPath("installation-inline-review.png") });
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId(`restart-confirmation-${job.id}`)).toHaveCount(0);
  await expect(page.getByTestId("installation-status-container-daemon")).toContainText(
    "Approval needed",
  );
  await page.getByTestId(`restart-approve-${job.id}`).click();
  await page.getByTestId(`restart-confirm-${job.id}`).click();
  await expect(
    page.getByText("Restart approved. Its progress is shown here.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("installation-status-container-daemon")).toContainText(
    "Restarted",
    { timeout: 150_000 },
  );
  await page.getByTestId("restart-history-toggle").click();
  await expect(card).toContainText("environment identity verified");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("installation-controls.png"), fullPage: true });
});

for (const destinationMode of ["existing", "new"] as const) {
  test(`environment profile selection uses a ${destinationMode} workspace in a shared project`, async ({
    page,
  }, testInfo) => {
    const sourceKind = destinationMode === "new" ? "container" : "host";
    const destinationKind = destinationMode === "new" ? "host" : "container";
    const sourceServerId = daemons[destinationMode === "new" ? 0 : 1]!.serverId;
    const destinationServerId = daemons[destinationMode === "new" ? 1 : 0]!.serverId;
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
          `https://github.com/example/shared-${destinationMode}.git`,
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
      await expectComposerVisible(page);
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
      if (destinationMode === "existing")
        await page.getByTestId("preset-destination-existing").click();
      await expect(page.getByTestId("preset-handoff-confirm")).toBeDisabled();
      await page
        .getByTestId("preset-handoff-context")
        .fill(
          "Continue the reviewed task in the destination workspace. Preserve the original chat.",
        );
      if (destinationMode === "existing") {
        if (!destinationWorkspace) throw new Error("Missing destination workspace");
        await page.getByTestId("preset-destination-existing").click();
        await page.getByTestId("preset-destination-workspace").click();
        await page
          .getByText(`${destinationWorkspace.projectDisplayName} / ${destinationWorkspace.name}`, {
            exact: true,
          })
          .click();
      } else {
        await page.getByTestId("preset-destination-add-project").click();
        await page.getByTestId("add-project-flow-method-directory-search").click();
        const input = page.getByTestId("add-project-flow-input");
        const missing = path.join(root, "does-not-exist");
        await input.fill(missing);
        await page.getByTestId(`add-project-flow-path-${encodeURIComponent(missing)}`).click();
        await expect(page.getByTestId("add-project-flow-error")).toBeVisible();
        await expect(page.getByTestId("preset-handoff-modal")).toBeAttached();
        await input.fill(destinationPath);
        await page
          .getByTestId(`add-project-flow-path-${encodeURIComponent(destinationPath)}`)
          .click();
        await expect(page.getByTestId("add-project-flow")).not.toBeVisible();
        await page.getByTestId("preset-destination-name").fill("Host project task");
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
      if (destinationWorkspace) expect(successor.workspaceId).toBe(destinationWorkspace.id);
      const sourceProject = (await sourceClient.listProjects()).projects.find(
        (project) => project.projectRootPath === sourcePath,
      )!;
      const destinationProject = (await destinationClient.listProjects()).projects.find(
        (project) => project.projectRootPath === destinationPath,
      )!;
      expect(destinationProject.projectKey).toBe(sourceProject.projectKey);
      const workspaces = (await destinationClient.fetchWorkspaces()).entries.filter(
        (workspace) => workspace.projectId === destinationProject.projectId,
      );
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.id).toBe(successor.workspaceId);
      expect(successor.labels?.["paseo:continued-from-server"]).toBe(sourceServerId);
      expect((await sourceClient.fetchAgent(source.id))?.agent.cwd).toBe(sourcePath);
      await expect(page).toHaveURL(new RegExp(`/h/${destinationServerId}/workspace/`));
    } finally {
      await sourceClient.close();
      await destinationClient.close();
    }
  });
}
