import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_SLUGS } from "@/utils/host-routes";
import { en } from "@/i18n/resources/en";
import {
  SETTINGS_ENTRIES,
  SETTINGS_PANES,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_IDS,
  resolveSettingsTarget,
} from "./catalog";

const SRC = path.resolve(__dirname, "..");

/**
 * Source files rendered by each pane. The coverage check reads row labels from
 * these files, so a new row without a catalog entry fails here.
 */
const PANE_SOURCES: Record<string, readonly string[]> = {
  "general.newWorkspace": ["screens/settings/general/workspace-defaults-section.tsx"],
  "general.sending": ["screens/settings/general/sending-section.tsx"],
  "general.notifications": ["desktop/components/desktop-notifications-section.tsx"],
  "chat.chat": ["screens/settings/chat/chat-section.tsx"],
  "chat.editor": ["screens/settings/editor-section.tsx"],
  "terminal.terminal": ["screens/settings/terminal/terminal-section.tsx"],
  "appearance.appearance": ["screens/settings/appearance/appearance-section.tsx"],
  "environments.environments": [
    "screens/settings/host-appearance-section.tsx",
    "execution-installation/resource-exclusions.tsx",
  ],
  "agents.metadata": ["screens/settings/metadata-generation-page.tsx"],
  "agents.browserData": ["desktop/browser/settings/browser-data-section.tsx"],
  "maintenance.installation": ["execution-installation/panel.tsx"],
};

/** Labels in pane sources that are not settings rows: dialogs, form fields and states. */
const NOT_ROWS = new Set([
  "settings.notifications.sentTitle",
  "settings.notifications.sendFailedTitle",
  "settings.metadataGeneration.model",
  "settings.metadataGeneration.docs",
  "settings.metadataGeneration.saveError",
  "settings.host.daemon.rename.title",
  "Dev preview monitor",
  "Native helper",
  "Waiting for compatible environments",
  // Sub-headings inside one instruction request's review, not settings rows.
  "Changes",
  "Full proposed instructions (applied exactly)",
  "Current instructions",
]);

function lookup(key: string): string | undefined {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Row labels a source file renders: `label=`, row titles and setting hints are excluded. */
function rowLabels(source: string): string[] {
  const labels = new Set<string>();
  const patterns = [
    /\blabel=\{t\("([^"]+)"\)\}/g,
    /\blabel="([^"]+)"/g,
    /rowTitle\}>\s*\{t\("([^"]+)"\)\}/g,
    /rowTitle\}>\s*([^<{][^<{]*?)\s*</g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) labels.add(match[1].trim());
  }
  return [...labels];
}

describe("settings catalog", () => {
  it("lists every section once, in order", () => {
    expect(SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...SETTINGS_SECTION_IDS]);
  });

  it("gives every pane and entry a unique id and a known parent", () => {
    const paneIds = SETTINGS_PANES.map((pane) => pane.id);
    expect(new Set(paneIds).size).toBe(paneIds.length);
    for (const pane of SETTINGS_PANES) {
      expect(SETTINGS_SECTION_IDS).toContain(pane.section);
      expect(pane.id.startsWith(`${pane.section}.`)).toBe(true);
    }
    const entryIds = SETTINGS_ENTRIES.map((entry) => entry.id);
    expect(new Set(entryIds).size).toBe(entryIds.length);
    for (const entry of SETTINGS_ENTRIES) {
      expect(paneIds, entry.id).toContain(entry.pane);
      expect(entry.id.startsWith(entry.pane.split(".")[0]), entry.id).toBe(true);
    }
  });

  it("resolves translated labels for entries that name an i18n key", () => {
    for (const entry of SETTINGS_ENTRIES) {
      if (entry.labelKey) expect(lookup(entry.labelKey), entry.id).toBe(entry.label);
    }
  });

  it("indexes every pane that renders settings", () => {
    const indexed = new Set(SETTINGS_ENTRIES.map((entry) => entry.pane));
    const unindexed = SETTINGS_PANES.filter(
      (pane) => pane.id !== "general.attention" && !indexed.has(pane.id),
    ).map((pane) => pane.id);
    expect(unindexed).toEqual([]);
  });

  it("routes every previous settings address to a pane", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      const target = resolveSettingsTarget(slug);
      if (slug === "general") continue;
      expect(target.pane ?? target.section, slug).not.toBe("general");
    }
    expect(resolveSettingsTarget("providers")).toEqual({
      section: "accounts",
      pane: "accounts.providers",
    });
    expect(resolveSettingsTarget("diagnostics")).toEqual({
      section: "maintenance",
      pane: "maintenance.diagnostics",
    });
    expect(resolveSettingsTarget("unknown")).toEqual({ section: "general", pane: null });
  });

  it("has an entry for every row label a pane renders", () => {
    const missing: string[] = [];
    let scanned = 0;
    for (const [paneId, files] of Object.entries(PANE_SOURCES)) {
      const entries = SETTINGS_ENTRIES.filter((entry) => entry.pane === paneId);
      const known = new Set(entries.flatMap((entry) => [entry.label, entry.labelKey ?? ""]));
      for (const file of files) {
        const source = readFileSync(path.join(SRC, file), "utf8");
        for (const label of rowLabels(source)) {
          scanned += 1;
          if (NOT_ROWS.has(label) || known.has(label)) continue;
          const translated = lookup(label);
          if (translated && known.has(translated)) continue;
          missing.push(`${paneId}: ${label}`);
        }
      }
    }
    expect(missing).toEqual([]);
    // Guards the scanner itself: a broken pattern would otherwise pass vacuously.
    expect(scanned).toBeGreaterThan(25);
  });
});
