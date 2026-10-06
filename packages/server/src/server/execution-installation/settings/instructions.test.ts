import { expect, test } from "vitest";
import { nativeHostInstallationInstructions, readUserSystemPrompt } from "./instructions.js";
import { SettingsEnvironmentFake, SettingsJournalFake } from "./fakes.js";
import { InstallationSettingsService } from "./service.js";

function fixture() {
  const host = new SettingsEnvironmentFake("host");
  const container = new SettingsEnvironmentFake("container");
  const instructions = nativeHostInstallationInstructions(
    "/private/installation/skills/installation-maintenance/SKILL.md",
  );
  host.installationInstructions = instructions;
  const journal = new SettingsJournalFake();
  const service = new InstallationSettingsService(journal, [host, container]);
  return { host, container, instructions, journal, service };
}

test("legacy host authority is not shared and custom user content survives migration and updates", async () => {
  const { host, container, instructions, journal, service } = fixture();
  const custom = "  Keep this indentation.\n\nFollow the project rules.\n";
  host.config.appendSystemPrompt = `${instructions}\n\n${custom}`;
  container.config.appendSystemPrompt = custom;
  const migrated = await service.reconcile();
  expect(migrated.conflicts).toBeUndefined();
  expect(migrated.settings?.appendSystemPrompt).toBe(custom);
  expect(host.patches).toEqual([]);
  const updated = "New shared instructions.\n";
  await service.update({ expectedRevision: 1, settings: { appendSystemPrompt: updated } });
  await service.reconcile();
  expect(host.config.appendSystemPrompt).toBe(`${instructions}\n\n${updated}`);
  expect(container.config.appendSystemPrompt).toBe(updated);
  expect(JSON.stringify({ state: journal.state, backups: journal.backups })).not.toContain(
    instructions,
  );
  const snapshot = service.snapshot();
  expect(await service.reconcile()).toEqual(snapshot);
  expect(host.patches).toHaveLength(1);
});

test("migration conflicts expose only differing user content and preserve host authority after resolution", async () => {
  const { host, container, instructions, service } = fixture();
  host.config.appendSystemPrompt = `${instructions}\n\nHost custom content`;
  container.config.appendSystemPrompt = "Dev custom content";
  const migrated = await service.reconcile();
  expect(migrated.conflicts?.fields).toEqual(["appendSystemPrompt"]);
  expect(migrated.conflicts?.candidates.host.appendSystemPrompt).toBe("Host custom content");
  expect(migrated.conflicts?.candidates.container.appendSystemPrompt).toBe("Dev custom content");
  await service.update({
    expectedRevision: 1,
    settings: { appendSystemPrompt: "Reviewed user content" },
  });
  await service.reconcile();
  expect(host.config.appendSystemPrompt).toBe(`${instructions}\n\nReviewed user content`);
  expect(container.config.appendSystemPrompt).toBe("Reviewed user content");
});

test("a misplaced generated host banner is removed from dev without importing or duplicating authority", async () => {
  const { host, container, instructions, service } = fixture();
  host.config.appendSystemPrompt = instructions;
  container.config.appendSystemPrompt = instructions;
  const snapshot = await service.reconcile();
  expect(snapshot.settings?.appendSystemPrompt).toBe("");
  expect(host.config.appendSystemPrompt).toBe(instructions);
  expect(container.config.appendSystemPrompt).toBe("");
  await expect(
    service.update({ expectedRevision: 1, settings: { appendSystemPrompt: instructions } }),
  ).rejects.toMatchObject({ reason: "installation-instructions" });
});

test("only the exact installer banner is separated, without trimming user-authored instructions", () => {
  const instructions = nativeHostInstallationInstructions("/private/skill.md");
  const custom = "This is the trusted native host environment. This sentence is user-authored.\n";
  expect(readUserSystemPrompt(custom, [instructions])).toBe(custom);
  expect(readUserSystemPrompt(`  custom text\n\n${instructions}`, [instructions])).toBe(
    "  custom text",
  );
});
