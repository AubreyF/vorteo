import { expect, type Locator, type Page } from "@playwright/test";

export type AddProjectFlowPage =
  | "host"
  | "method"
  | "directory-search"
  | "github-search"
  | "github-location"
  | "new-directory-parent"
  | "new-directory-name"
  | "folder-browser"
  | "clone-destination";

export type AddProjectMethod =
  | "open-folder"
  | "directory-search"
  | "browse"
  | "github"
  | "new-directory";

// E2E daemons advertise folder browsing, so Open and New use the browser page.
const METHOD_DESTINATIONS: Record<Exclude<AddProjectMethod, "browse">, AddProjectFlowPage> = {
  "open-folder": "folder-browser",
  "directory-search": "directory-search",
  github: "github-search",
  "new-directory": "folder-browser",
};

export function addProjectFlow(page: Page): Locator {
  return page.getByTestId("add-project-flow");
}

export function addProjectFlowInput(page: Page): Locator {
  return page.getByTestId("add-project-flow-input");
}

export function addProjectFlowBack(page: Page): Locator {
  return page.getByTestId("add-project-flow-back");
}

export function addProjectFlowHost(page: Page, serverId: string): Locator {
  return page.getByTestId(`add-project-flow-host-${serverId}`);
}

export function addProjectFlowMethod(page: Page, method: AddProjectMethod): Locator {
  return page.getByTestId(`add-project-flow-method-${method}`);
}

export async function expectAddProjectPage(page: Page, kind: AddProjectFlowPage): Promise<Locator> {
  const currentPage = page.getByTestId(`add-project-flow-page-${kind}`);
  await expect(currentPage).toBeVisible({ timeout: 30_000 });
  return currentPage;
}

async function openAddProjectFlowSurface(
  page: Page,
  expectedPage: "host" | "method",
): Promise<void> {
  // Add project lives in the sidebar's overflow menu.
  const addProject = page.locator('[data-testid="sidebar-add-project"]:visible');
  if (!(await addProject.isVisible())) {
    await page.locator('[data-testid="sidebar-footer-overflow"]:visible').click();
  }
  await addProject.click();
  await expect(addProjectFlow(page)).toBeVisible({ timeout: 30_000 });
  await expectAddProjectPage(page, expectedPage);
}

export async function openAddProjectFlow(page: Page): Promise<void> {
  await openAddProjectFlowSurface(page, "method");
}

export async function openAddProjectHostSelection(page: Page): Promise<void> {
  await openAddProjectFlowSurface(page, "host");
  await expect(addProjectFlowInput(page)).toBeFocused();
}

export async function chooseAddProjectMethod(page: Page, method: AddProjectMethod): Promise<void> {
  const option = addProjectFlowMethod(page, method);
  await expect(option).toBeVisible();
  await option.click();
  if (method !== "browse") {
    await expectAddProjectPage(page, METHOD_DESTINATIONS[method]);
  }
}

export function addProjectFlowLocation(page: Page): Locator {
  return page.getByTestId("add-project-flow-location-title");
}

// Types a path into the folder browser and enters it, then waits for the listing.
export async function browseAddProjectFolderPath(
  page: Page,
  typedPath: string,
  expectedLocation: string | RegExp,
): Promise<void> {
  await addProjectFlowInput(page).fill(typedPath);
  await page.getByTestId("add-project-flow-go-to").click();
  await expect(addProjectFlowLocation(page)).toContainText(expectedLocation, { timeout: 30_000 });
  await expect(addProjectFlowInput(page)).toHaveValue("");
}

export async function expectNewWorkspaceForAddedProject(
  page: Page,
  input: {
    serverId: string;
    projectId: string;
    projectName: string;
    projectPath: string;
  },
): Promise<void> {
  await expect(page).toHaveURL(/\/new\?.*projectId=/u, { timeout: 30_000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/new");
  expect(url.searchParams.get("serverId")).toBe(input.serverId);
  expect(url.searchParams.get("projectId")).toBe(input.projectId);
  expect(url.searchParams.get("dir")).toBe(input.projectPath);
  await expect(page.getByRole("button", { name: "Workspace project" })).toContainText(
    input.projectName,
    { timeout: 30_000 },
  );
}
