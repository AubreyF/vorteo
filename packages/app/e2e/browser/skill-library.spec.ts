import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as base, expect } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsHost } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";

const test = base.extend<{}, { skillHome: string }>({
  skillHome: [
    async ({ browserName }, provide) => {
      void browserName;
      const home = await mkdtemp(path.join(os.tmpdir(), "skill-library-browser-"));
      const target = path.join(home, ".agents/skills/browser-example");
      await mkdir(target, { recursive: true });
      await writeFile(
        path.join(target, "SKILL.md"),
        "---\nname: browser-example\ndescription: Browser library fixture\n---\nReviewed fixture instructions\n",
      );
      await writeFile(
        path.join(target, ".vorteo-skill-source.json"),
        JSON.stringify({
          repository: "example/skills",
          revision: "a".repeat(40),
          directory: "skills/browser-example",
        }),
      );
      const linked = path.join(home, ".agents/skills/linked-example");
      const claude = path.join(home, ".claude/skills");
      await mkdir(linked, { recursive: true });
      await mkdir(claude, { recursive: true });
      await writeFile(
        path.join(linked, "SKILL.md"),
        "---\nname: linked-example\ndescription: Shared provider fixture\n---\nShared instructions\n",
      );
      await writeFile(
        path.join(linked, ".vorteo-skill-source.json"),
        JSON.stringify({
          repository: "example/skills",
          revision: "a".repeat(40),
          directory: "skills/linked-example",
        }),
      );
      await symlink(linked, path.join(claude, "linked-example"), "junction");
      try {
        await provide(home);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
  e2eDaemonEnvironment: [
    async ({ skillHome }, provide) => {
      await provide({ HOME: skillHome });
    },
    { scope: "worker" },
  ],
});
test.use({ vortonMode: true });

test("inspects skills and preserves an edit made after removal preview", async ({
  page,
  skillHome,
}) => {
  await gotoAppShell(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await page.getByPlaceholder("Name, provider, ownership, or environment").fill("browser-example");
  await expect(page.getByText("browser-example", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("Reviewed fixture instructions", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Preview removal", exact: true }).click();
  await expect(
    page.getByText(`remove: ${path.join(skillHome, ".agents/skills/browser-example")}`, {
      exact: true,
    }),
  ).toBeVisible();
  const note = path.join(skillHome, ".agents/skills/browser-example/notes.txt");
  await writeFile(note, "Local work remains intact");
  await page.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await expect(
    page.getByText("Skill changed since preview; review a fresh preview", { exact: false }),
  ).toBeVisible();
  expect(await readFile(note, "utf8")).toBe("Local work remains intact");
  await page.getByRole("button", { name: "Preview removal", exact: true }).click();
  await expect(page.getByText(/Previous content:\s*Local work remains intact/)).toBeVisible();
  await page.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await expect(
    page.getByText("Change applied. Recovery is available in History.", { exact: true }),
  ).toBeVisible();
});

test("groups provider links and keeps removal scoped to the selected path", async ({
  page,
  skillHome,
}) => {
  await page.goto("/settings/skills");
  await page.getByPlaceholder("Name, provider, ownership, or environment").fill("linked-example");
  await expect(page.getByText("linked-example", { exact: true })).toHaveCount(1);
  await expect(page.getByText("personal, claude, codex, Inspected", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Name, provider, ownership, or environment").fill("claude");
  await expect(page.getByText("linked-example", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Inspect claude path", exact: true }).click();
  await page.getByRole("button", { name: "Preview removal", exact: true }).click();
  const link = path.join(skillHome, ".claude/skills/linked-example");
  await expect(page.getByText(`remove: ${link}`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply reviewed change", exact: true }).click();
  await expect(
    page.getByText("Change applied. Recovery is available in History.", { exact: true }),
  ).toBeVisible();
  await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await readFile(path.join(skillHome, ".agents/skills/linked-example/SKILL.md"), "utf8"),
  ).toContain("Shared instructions");
});

test("opens Skills from compact settings and a direct link", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/skills$/);
  await expect(page.getByPlaceholder("Name, provider, ownership, or environment")).toBeVisible();
  await page.reload();
  await expect(page.getByPlaceholder("Name, provider, ownership, or environment")).toBeVisible();
});

test.describe("Standard mode", () => {
  test.use({ vortonMode: false });
  test("keeps the skill library out of Standard controls", async ({ page }) => {
    await gotoAppShell(page);
    await openSettings(page);
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toHaveCount(0);
    await openSettingsHost(page, getServerId());
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByText("Orchestration skills", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Skill library", exact: true })).toHaveCount(0);
  });
});
