import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient } from "../support/helpers/seed-client";

const filesystemRoot = path.parse(tmpdir()).root;
const hostHome = path.join(filesystemRoot, "host-example");

// The isolated daemon maps its real filesystem root to a synthetic host path.
// Only the temporary project directory is created or registered.
test.use({
  e2eDaemonEnvironment: {
    PASEO_HOST_FILESYSTEM: JSON.stringify({
      version: 1,
      hostHome,
      shares: [
        {
          id: "projects",
          hostPath: path.join(hostHome, "Documents"),
          containerPath: filesystemRoot,
        },
      ],
    }),
  },
});

test("browses shared host folders, opens a project, and explains unshared host paths", async ({
  page,
}, info) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-browser-"));
  const projectPath = path.join(root, "Project");
  await mkdir(projectPath);
  let projectId: string | null = null;
  try {
    await gotoAppShell(page);
    for (const enabled of [false, true]) {
      await page.evaluate((value) => {
        localStorage.setItem(
          "@paseo:e2e-disable-default-seed-once",
          localStorage.getItem("@paseo:e2e-seed-nonce") ?? "",
        );
        const key = "@paseo:create-agent-preferences";
        localStorage.setItem(
          key,
          JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), vortonMode: value }),
        );
      }, enabled);
      await page.reload();
      if (enabled) await page.getByTestId("sidebar-footer-overflow").click();
      await page.getByTestId("sidebar-add-project").click();
      await page.getByTestId("add-project-flow-method-shared-folders").click();
      const input = page.getByTestId("project-directory-host-path");
      await input.fill("~/Downloads/unshared");
      await page.getByTestId("project-directory-open-path").click();
      await expect(page.getByTestId("project-directory-error")).toContainText("not shared");
      await input.fill(
        `~/Documents/${path.relative(filesystemRoot, root).split(path.sep).join("/")}`,
      );
      await page.getByTestId("project-directory-open-path").click();
      await page.getByTestId("project-directory-child-Project").click();
      await expect(page.getByTestId("project-directory-browser")).toContainText(projectPath);
      await page.screenshot({ path: info.outputPath(`folders-${enabled}.png`) });
      await page.getByTestId("add-project-flow-back").click();
      await page.getByTestId("add-project-flow-method-shared-folders").click();
      await page
        .getByTestId("project-directory-host-path")
        .fill(
          `~/Documents/${path.relative(filesystemRoot, projectPath).split(path.sep).join("/")}`,
        );
      await page.getByTestId("project-directory-open-path").click();
      await expect(page.getByTestId("project-directory-select")).toBeVisible();
      if (!enabled) await page.keyboard.press("Escape");
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByTestId("sidebar-footer-overflow").click();
    await page.getByTestId("sidebar-add-project").click();
    await page.getByTestId("add-project-flow-method-shared-folders").click();
    await page
      .getByTestId("project-directory-host-path")
      .fill(`~/Documents/${path.relative(filesystemRoot, projectPath).split(path.sep).join("/")}`);
    await page.getByTestId("project-directory-open-path").click();
    await expect(page.getByTestId("project-directory-select")).toBeVisible();
    await page.screenshot({ path: info.outputPath("folders-compact.png") });
    await page.getByTestId("project-directory-select").click();
    await expect(page).toHaveURL(/\/new\?.*projectId=/);
    const url = new URL(page.url());
    projectId = url.searchParams.get("projectId");
    expect(url.searchParams.get("dir")).toBe(projectPath);
    expect(projectId).toBeTruthy();
  } finally {
    const client = await connectSeedClient();
    try {
      if (!projectId) projectId = (await client.addProject(projectPath)).project?.projectId ?? null;
      if (projectId) await client.removeProject(projectId);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("new directories use the chosen shared parent", async ({ page }) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-shared-parent-"));
  const projectPath = path.join(root, "Created");
  let projectId: string | null = null;
  try {
    await gotoAppShell(page);
    await page.getByTestId("sidebar-add-project").click();
    await page.getByTestId("add-project-flow-method-new-directory").click();
    await page.getByTestId("add-project-toggle-browser").click();
    await page
      .getByTestId("project-directory-host-path")
      .fill(`~/Documents/${path.relative(filesystemRoot, root).split(path.sep).join("/")}`);
    await page.getByTestId("project-directory-open-path").click();
    await page.getByTestId("project-directory-select").click();
    await page.getByTestId("add-project-flow-input").fill("Created");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/new\?.*projectId=/);
    const url = new URL(page.url());
    projectId = url.searchParams.get("projectId");
    expect(url.searchParams.get("dir")).toBe(projectPath);
  } finally {
    const client = await connectSeedClient();
    try {
      if (!projectId) projectId = (await client.addProject(projectPath)).project?.projectId ?? null;
      if (projectId) await client.removeProject(projectId);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});
