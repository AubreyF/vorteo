import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient } from "../support/helpers/seed-client";
import {
  addProjectFlowInput,
  addProjectFlowLocation,
  browseAddProjectFolderPath,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";

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

test("browses shared host folders by host path, opens a project, and explains unshared paths", async ({
  page,
}, info) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-browser-"));
  const projectPath = path.join(root, "Project");
  await mkdir(projectPath);
  const hostRoot = `~/Documents/${path.relative(filesystemRoot, root).split(path.sep).join("/")}`;
  let projectId: string | null = null;
  try {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "open-folder");
    // Shared folders are listed by their host path, ahead of container storage.
    await expect(
      page.getByTestId(`add-project-flow-location-${encodeURIComponent("root:projects")}`),
    ).toContainText(path.join(hostHome, "Documents"));

    await addProjectFlowInput(page).fill("~/Downloads/unshared");
    await page.getByTestId("add-project-flow-go-to").click();
    await expect(page.getByTestId("add-project-flow-query-error")).toContainText("not shared");

    await browseAddProjectFolderPath(page, hostRoot, path.basename(root));
    await page.getByTestId("add-project-flow-folder-Project").click();
    await expect(addProjectFlowLocation(page)).toContainText(`${path.basename(root)}/Project`);
    await expect(page.getByTestId("add-project-flow-location")).toContainText("Shared folder");
    await expect(addProjectFlowLocation(page)).toContainText(path.join(hostHome, "Documents"));
    await page.screenshot({ path: info.outputPath("folders-desktop.png") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByTestId("sidebar-footer-overflow").click();
    await page.getByTestId("sidebar-add-project").click();
    await chooseAddProjectMethod(page, "open-folder");
    await browseAddProjectFolderPath(page, `${hostRoot}/Project`, "Project");
    await expect(page.getByTestId("add-project-flow-use-folder")).toBeVisible();
    await page.screenshot({ path: info.outputPath("folders-compact.png") });
    await page.getByTestId("add-project-flow-use-folder").click();
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

test("new project folders are created in the browsed shared folder", async ({ page }) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-shared-parent-"));
  const projectPath = path.join(root, "Created");
  let projectId: string | null = null;
  try {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "new-directory");
    await browseAddProjectFolderPath(
      page,
      `~/Documents/${path.relative(filesystemRoot, root).split(path.sep).join("/")}`,
      path.basename(root),
    );
    await page.keyboard.type("Created");
    const create = page.getByTestId("add-project-flow-create-folder");
    await expect(create).toContainText(`${path.basename(root)}/Created`);
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
