/**
 * The settings catalog: every settings section, the panes each section stacks,
 * and a searchable entry for every setting a pane renders.
 *
 * Settings render as one continuous column of sections. Each pane reuses an
 * existing settings component; the catalog only decides order, grouping,
 * availability and search. Keep it free of React so search and coverage tests
 * run in plain Node.
 *
 * Adding a setting row to a pane means adding its entry here. The coverage test
 * in `catalog.test.ts` scans each pane's source for row labels and fails when a
 * label has no entry.
 */

export const SETTINGS_SECTION_IDS = [
  "general",
  "accounts",
  "agents",
  "chat",
  "terminal",
  "appearance",
  "workspaces",
  "environments",
  "plugins",
  "maintenance",
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Where a setting's value lives, shown so owners know what a change affects. */
export type SettingScope = "device" | "installation" | "environment";

export interface SettingsAvailability {
  /** Electron desktop app only. */
  desktopOnly?: boolean;
  /** Browser and Electron only. */
  webOnly?: boolean;
  /** iOS and Android only. */
  nativeOnly?: boolean;
  /** Needs at least one connected environment. */
  requiresHost?: boolean;
  /** Needs a configured execution installation. */
  requiresInstallation?: boolean;
  /** Replaced by an installation-wide page when an installation exists. */
  withoutInstallation?: boolean;
}

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  /** Extra words people use for this whole section. */
  keywords: readonly string[];
}

export interface SettingsPaneDefinition extends SettingsAvailability {
  id: string;
  section: SettingsSectionId;
  label: string;
  /** Old `/settings/<slug>` routes that now open this pane. */
  legacySlugs?: readonly string[];
  keywords?: readonly string[];
}

export interface SettingsEntryDefinition extends SettingsAvailability {
  id: string;
  pane: string;
  /** Text shown on the row, used to find and highlight it after a jump. */
  label: string;
  /** i18n key for `label`, so search matches the translated row title. */
  labelKey?: string;
  hint?: string;
  hintKey?: string;
  keywords?: readonly string[];
  scope: SettingScope;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDefinition[] = [
  {
    id: "general",
    label: "General",
    keywords: [
      "home",
      "attention",
      "notifications",
      "about",
      "version",
      "release notes",
      "changelog",
      "github",
      "hosts",
      "diagnostics",
    ],
  },
  {
    id: "accounts",
    label: "Accounts & profiles",
    keywords: [
      "providers",
      "accounts",
      "profiles",
      "presets",
      "usage",
      "quota",
      "sign in",
      "login",
    ],
  },
  {
    id: "agents",
    label: "Agent behavior",
    keywords: ["agents", "tools", "skills", "system prompt", "metadata", "browser", "permissions"],
  },
  {
    id: "chat",
    label: "Chat & editor",
    keywords: [
      "chat",
      "timeline",
      "editor",
      "vim",
      "shortcuts",
      "keyboard",
      "open location",
      "sending",
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    keywords: ["terminal", "shell", "scrollback", "hooks"],
  },
  {
    id: "appearance",
    label: "Appearance",
    keywords: ["theme", "fonts", "dark mode", "light mode", "language", "look"],
  },
  {
    id: "workspaces",
    label: "Workspaces & projects",
    keywords: ["projects", "repositories", "worktrees", "archive", "new workspace", "defaults"],
  },
  {
    id: "environments",
    label: "Environments",
    keywords: ["hosts", "daemons", "machines", "connections", "pair", "devices", "servers"],
  },
  {
    id: "plugins",
    label: "Plugins & integrations",
    keywords: ["plugins", "extensions", "integrations", "cli"],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    keywords: ["installation", "restart", "updates", "upstream", "diagnostics", "owner"],
  },
];

export const SETTINGS_PANES: readonly SettingsPaneDefinition[] = [
  { id: "general.attention", section: "general", label: "Needs attention" },
  {
    id: "general.notifications",
    section: "general",
    label: "Notifications",
    legacySlugs: ["notifications"],
    desktopOnly: true,
  },
  // About was its own section; its routes now open these panes.
  {
    id: "general.about",
    section: "general",
    label: "About",
    legacySlugs: ["about"],
  },
  {
    id: "general.hosts",
    section: "general",
    label: "Connected hosts",
    legacySlugs: ["diagnostics"],
    keywords: ["diagnostics", "connection check"],
  },

  {
    id: "accounts.providers",
    section: "accounts",
    label: "Providers",
    legacySlugs: ["providers"],
    requiresHost: true,
  },
  {
    id: "accounts.profiles",
    section: "accounts",
    label: "Profiles",
    legacySlugs: ["profiles"],
    requiresHost: true,
    // Each provider's page shows its profiles when an installation exists.
    withoutInstallation: true,
  },
  {
    id: "accounts.usage",
    section: "accounts",
    label: "Usage",
    legacySlugs: ["usage"],
    requiresHost: true,
    // Usage sits on each connection of a provider's page when an installation exists.
    withoutInstallation: true,
  },

  {
    id: "agents.tools",
    section: "agents",
    label: "Agent tools",
    legacySlugs: ["agents"],
    requiresHost: true,
  },
  {
    id: "agents.skills",
    section: "agents",
    label: "Skills",
    legacySlugs: ["skills"],
  },
  {
    id: "agents.metadata",
    section: "agents",
    label: "Metadata generation",
    legacySlugs: ["metadata"],
    requiresHost: true,
  },
  {
    id: "agents.browserData",
    section: "agents",
    label: "Browser data",
    legacySlugs: ["browser"],
    desktopOnly: true,
  },
  {
    id: "agents.permissions",
    section: "agents",
    label: "Permissions",
    legacySlugs: ["permissions"],
    desktopOnly: true,
  },

  { id: "chat.chat", section: "chat", label: "Chat", legacySlugs: ["chat"] },
  { id: "chat.sending", section: "chat", label: "Sending" },
  {
    id: "chat.openLocation",
    section: "chat",
    label: "Open location",
    desktopOnly: true,
  },
  {
    id: "chat.editor",
    section: "chat",
    label: "Editor",
    legacySlugs: ["editor"],
    webOnly: true,
  },
  {
    id: "chat.shortcuts",
    section: "chat",
    label: "Keyboard shortcuts",
    legacySlugs: ["shortcuts"],
    desktopOnly: true,
  },

  {
    id: "terminal.terminal",
    section: "terminal",
    label: "Terminal",
    legacySlugs: ["terminal"],
  },
  {
    id: "terminal.profiles",
    section: "terminal",
    label: "Terminal profiles",
    legacySlugs: ["terminals"],
    requiresHost: true,
  },

  {
    id: "appearance.appearance",
    section: "appearance",
    label: "Appearance",
    legacySlugs: ["appearance", "sidebar"],
  },
  { id: "appearance.language", section: "appearance", label: "Language" },

  {
    id: "workspaces.newWorkspace",
    section: "workspaces",
    label: "New workspace",
    keywords: ["default", "new chat"],
  },
  {
    id: "workspaces.projects",
    section: "workspaces",
    label: "Projects",
    legacySlugs: ["projects"],
    requiresHost: true,
  },
  {
    id: "workspaces.workspaces",
    section: "workspaces",
    label: "Workspaces",
    legacySlugs: ["workspaces"],
    requiresHost: true,
  },

  {
    id: "environments.environments",
    section: "environments",
    label: "Environments",
    legacySlugs: ["environments"],
    requiresHost: true,
  },
  {
    id: "environments.connections",
    section: "environments",
    label: "Connections",
    // Device pairing was retired in favor of authenticated direct connections.
    legacySlugs: ["connections", "pair-device"],
  },

  {
    id: "plugins.plugins",
    section: "plugins",
    label: "Plugins",
    legacySlugs: ["plugins"],
    requiresHost: true,
  },
  {
    id: "plugins.integrations",
    section: "plugins",
    label: "Integrations",
    legacySlugs: ["integrations"],
    desktopOnly: true,
  },

  {
    id: "maintenance.installation",
    section: "maintenance",
    label: "Installation",
    requiresInstallation: true,
  },
  {
    id: "maintenance.updates",
    section: "maintenance",
    label: "Vorteo updates",
  },
  {
    id: "maintenance.upstream",
    section: "maintenance",
    label: "Paseo upstream updates",
  },
];

const device = "device" as const;
const installation = "installation" as const;
const environment = "environment" as const;

export const SETTINGS_ENTRIES: readonly SettingsEntryDefinition[] = [
  // General
  {
    id: "general.notifications.permission",
    pane: "general.notifications",
    label: "Notification permission",
    labelKey: "settings.notifications.permission",
    keywords: ["alerts", "allow"],
    scope: device,
  },
  {
    id: "general.notifications.sound",
    pane: "general.notifications",
    label: "Play sound",
    labelKey: "settings.notifications.playSound",
    keywords: ["audio", "chime", "alert"],
    scope: device,
  },
  {
    id: "general.notifications.test",
    pane: "general.notifications",
    label: "Test notification",
    labelKey: "settings.notifications.test",
    scope: device,
  },
  {
    id: "general.about.version",
    pane: "general.about",
    label: "App version",
    labelKey: "settings.about.appVersion",
    keywords: ["build", "version number"],
    scope: device,
  },
  {
    id: "general.about.whatsNew",
    pane: "general.about",
    label: "What's new",
    labelKey: "changelog.title",
    keywords: ["changelog", "release notes"],
    scope: device,
  },
  {
    id: "general.about.github",
    pane: "general.about",
    label: "GitHub",
    labelKey: "settings.about.github",
    keywords: ["source code", "repository", "issues", "community"],
    scope: device,
  },
  {
    id: "general.about.releaseChannel",
    pane: "general.about",
    label: "Release channel",
    labelKey: "settings.about.releaseChannel.label",
    keywords: ["beta", "stable"],
    desktopOnly: true,
    scope: device,
  },
  {
    id: "general.about.appUpdates",
    pane: "general.about",
    label: "App updates",
    labelKey: "settings.about.updates.label",
    keywords: ["desktop update", "install update"],
    desktopOnly: true,
    scope: device,
  },
  {
    id: "general.hosts.versions",
    pane: "general.hosts",
    label: "Connected hosts",
    labelKey: "settings.about.connectedHosts",
    keywords: ["daemon version", "version mismatch"],
    scope: environment,
  },
  {
    id: "general.hosts.connectionCheck",
    pane: "general.hosts",
    label: "Connection check",
    keywords: ["connection check", "host", "dev", "dns", "tailscale", "latency", "reachability"],
    scope: device,
  },
  {
    id: "general.hosts.legacyTerminalRenderer",
    pane: "general.hosts",
    label: "Use legacy terminal renderer",
    labelKey: "settings.diagnostics.legacyTerminalRenderer.label",
    keywords: ["webview", "terminal"],
    nativeOnly: true,
    scope: device,
  },
  {
    id: "general.hosts.app",
    pane: "general.hosts",
    label: "App diagnostic",
    labelKey: "settings.diagnostics.app.rowTitle",
    keywords: ["logs", "debug", "troubleshoot", "support"],
    scope: device,
  },
  {
    id: "general.hosts.audio",
    pane: "general.hosts",
    label: "Test audio",
    labelKey: "settings.diagnostics.testAudio",
    keywords: ["sound", "speaker", "voice"],
    scope: device,
  },

  // Accounts & profiles
  {
    id: "accounts.providers.list",
    pane: "accounts.providers",
    label: "Providers",
    keywords: [
      "accounts",
      "connections",
      "claude",
      "codex",
      "copilot",
      "opencode",
      "pi",
      "connect",
      "sign in",
      "profiles",
      "default profile",
      "model defaults",
      "usage",
      "plan usage",
      "environment access",
    ],
    scope: environment,
  },
  {
    id: "accounts.providers.order",
    pane: "accounts.providers",
    label: "Provider order",
    keywords: ["reorder", "drag", "priority"],
    scope: installation,
  },
  {
    id: "accounts.profiles.default",
    pane: "accounts.profiles",
    label: "Default profile",
    keywords: ["preset", "default configuration"],
    scope: installation,
  },
  {
    id: "accounts.profiles.list",
    pane: "accounts.profiles",
    label: "Profiles",
    keywords: ["presets", "workflows", "model", "reasoning", "instructions", "workers"],
    scope: installation,
  },
  {
    id: "accounts.profiles.launchDefaults",
    pane: "accounts.profiles",
    label: "Edit defaults",
    keywords: ["provider defaults", "launch defaults", "model picker"],
    scope: installation,
  },
  {
    id: "accounts.profiles.olderCopies",
    pane: "accounts.profiles",
    label: "Older copies",
    keywords: ["duplicate profiles", "legacy profiles", "migrated profiles"],
    scope: installation,
  },
  {
    id: "accounts.profiles.preferredModels",
    pane: "accounts.profiles",
    label: "Preferred models and reasoning",
    keywords: ["model picker", "favorites"],
    scope: installation,
  },
  {
    id: "accounts.profiles.preferredReasoning",
    pane: "accounts.profiles",
    label: "Preferred reasoning",
    keywords: ["thinking", "effort"],
    scope: installation,
  },
  {
    id: "accounts.usage.plan",
    pane: "accounts.usage",
    label: "Plan usage",
    hint: "Each account also shows its quota beside its status.",
    keywords: ["quota", "limits", "credits", "reset", "weekly", "session"],
    scope: environment,
  },

  // Agent behavior
  {
    id: "agents.tools.vorteoTools",
    pane: "agents.tools",
    label: "Enable Vorteo tools",
    keywords: ["mcp", "worktrees", "schedules", "orchestration"],
    scope: installation,
  },
  {
    id: "agents.tools.browserTools",
    pane: "agents.tools",
    label: "Browser tools",
    keywords: ["browser automation", "tabs", "screenshots", "playwright"],
    scope: installation,
  },
  {
    id: "agents.tools.systemPrompt",
    pane: "agents.tools",
    label: "System prompt",
    keywords: ["instructions", "custom prompt"],
    scope: installation,
  },
  {
    id: "agents.tools.orchestrationSkills",
    pane: "agents.tools",
    label: "Orchestration skills",
    keywords: ["skill library"],
    scope: environment,
  },
  {
    id: "agents.skills.library",
    pane: "agents.skills",
    label: "Filter skills",
    keywords: ["skills", "install skill", "github", "discovery paths", "inventory"],
    scope: environment,
  },
  {
    id: "agents.metadata.model",
    pane: "agents.metadata",
    label: "Model selection",
    labelKey: "settings.metadataGeneration.selection",
    keywords: ["titles", "branch names", "commit messages", "pull request drafts"],
    scope: installation,
  },
  {
    id: "agents.browserData.clear",
    pane: "agents.browserData",
    label: "Cookies and site data",
    labelKey: "settings.general.browserData.siteData",
    keywords: ["clear browser data", "sign-ins"],
    scope: device,
  },
  {
    id: "agents.permissions.microphone",
    pane: "agents.permissions",
    label: "Microphone",
    labelKey: "settings.permissions.microphone",
    keywords: ["voice", "dictation", "audio"],
    scope: device,
  },

  // Chat & editor
  {
    id: "chat.chat.reasoning",
    pane: "chat.chat",
    label: "Always expand reasoning",
    labelKey: "settings.general.autoExpandReasoning.label",
    keywords: ["thinking", "chain of thought"],
    scope: device,
  },
  {
    id: "chat.chat.toolCalls",
    pane: "chat.chat",
    label: "Tool call display",
    labelKey: "settings.general.toolCallDetail.label",
    keywords: ["summary", "full detail", "timeline"],
    scope: device,
  },
  {
    id: "chat.chat.outline",
    pane: "chat.chat",
    label: "Chat outline",
    labelKey: "settings.appearance.chatOutline.title",
    keywords: ["jump between prompts", "navigation"],
    scope: device,
  },
  {
    id: "chat.sending.defaultSend",
    pane: "chat.sending",
    label: "Default send",
    labelKey: "settings.general.defaultSend.label",
    keywords: ["enter", "steer", "queue", "interrupt", "submit"],
    scope: device,
  },
  {
    id: "chat.openLocation.destinations",
    pane: "chat.openLocation",
    label: "Open location",
    labelKey: "settings.layout.openInSidePane.title",
    keywords: ["side pane", "split", "explorer", "diffs", "service urls"],
    scope: device,
  },
  {
    id: "chat.editor.vim",
    pane: "chat.editor",
    label: "Vim keybindings",
    labelKey: "settings.editor.vimKeybindings",
    keywords: ["vi", "modal editing", "keyboard"],
    scope: device,
  },
  {
    id: "chat.shortcuts.list",
    pane: "chat.shortcuts",
    label: "Shortcuts",
    labelKey: "settings.sections.shortcuts",
    keywords: ["keyboard shortcuts", "hotkeys", "keybindings", "rebind"],
    scope: device,
  },

  // Terminal
  {
    id: "terminal.terminal.scrollback",
    pane: "terminal.terminal",
    label: "Terminal scrollback",
    labelKey: "settings.general.terminalScrollback.label",
    keywords: ["buffer", "lines", "history"],
    scope: device,
  },
  {
    id: "terminal.profiles.hooks",
    pane: "terminal.profiles",
    label: "Enable terminal agent hooks",
    keywords: ["notifications", "status", "terminal agents"],
    scope: environment,
  },
  {
    id: "terminal.profiles.list",
    pane: "terminal.profiles",
    label: "Terminal profiles",
    labelKey: "settings.host.terminalProfiles.sectionTitle",
    keywords: ["claude code", "codex", "opencode", "commands", "launch"],
    scope: installation,
  },

  // Appearance
  {
    id: "appearance.theme",
    pane: "appearance.appearance",
    label: "Theme",
    labelKey: "settings.appearance.theme.title",
    keywords: ["dark", "light", "midnight", "claude", "ghostty", "pure black", "colors"],
    scope: device,
  },
  {
    id: "appearance.interfaceFont",
    pane: "appearance.appearance",
    label: "Interface font",
    labelKey: "settings.appearance.fonts.interfaceFont",
    keywords: ["typeface", "font family"],
    scope: device,
  },
  {
    id: "appearance.interfaceSize",
    pane: "appearance.appearance",
    label: "Interface size",
    labelKey: "settings.appearance.fonts.interfaceSize",
    keywords: ["font size", "zoom", "text size"],
    scope: device,
  },
  {
    id: "appearance.contentSize",
    pane: "appearance.appearance",
    label: "Content size",
    labelKey: "settings.appearance.fonts.contentSize",
    keywords: ["font size", "markdown", "chat text"],
    scope: device,
  },
  {
    id: "appearance.codeFont",
    pane: "appearance.appearance",
    label: "Code font",
    labelKey: "settings.appearance.fonts.codeFont",
    keywords: ["monospace", "terminal font"],
    scope: device,
  },
  {
    id: "appearance.codeSize",
    pane: "appearance.appearance",
    label: "Code size",
    labelKey: "settings.appearance.fonts.codeSize",
    keywords: ["monospace", "font size"],
    scope: device,
  },
  {
    id: "appearance.contentWidth",
    pane: "appearance.appearance",
    label: "Content width",
    labelKey: "settings.appearance.layout.contentWidth",
    keywords: ["max width", "column", "wide screens"],
    scope: device,
  },
  {
    id: "appearance.highlightTheme",
    pane: "appearance.appearance",
    label: "Highlight theme",
    labelKey: "settings.appearance.syntax.highlightTheme",
    keywords: ["syntax", "code colors"],
    scope: device,
  },
  {
    id: "appearance.language",
    pane: "appearance.language",
    label: "Language",
    labelKey: "settings.general.language.label",
    keywords: ["locale", "translation", "english", "spanish", "japanese"],
    scope: device,
  },

  // Workspaces & projects
  {
    id: "workspaces.newWorkspace.environment",
    pane: "workspaces.newWorkspace",
    label: "Default environment",
    keywords: ["new workspace", "host", "where new chats run"],
    scope: installation,
  },
  {
    id: "workspaces.newWorkspace.account",
    pane: "workspaces.newWorkspace",
    label: "Default account",
    keywords: ["new chat", "provider", "claude", "codex"],
    scope: installation,
  },
  {
    id: "workspaces.newWorkspace.profile",
    pane: "workspaces.newWorkspace",
    label: "Default profile",
    keywords: ["new chat", "preset", "model"],
    scope: installation,
  },
  {
    id: "workspaces.projects.list",
    pane: "workspaces.projects",
    label: "Projects",
    labelKey: "settings.hostSections.projects",
    keywords: ["repositories", "folders", "project settings"],
    scope: installation,
  },
  {
    id: "workspaces.archiveMerged",
    pane: "workspaces.workspaces",
    label: "Archive merged PR workspaces",
    keywords: ["auto archive", "pull request", "cleanup"],
    scope: environment,
  },

  // Environments
  {
    id: "environments.name",
    pane: "environments.environments",
    label: "Name",
    labelKey: "settings.host.appearance.name.label",
    keywords: ["rename host", "label"],
    scope: device,
  },
  {
    id: "environments.color",
    pane: "environments.environments",
    label: "Color",
    labelKey: "settings.host.appearance.color.label",
    keywords: ["host color"],
    scope: device,
  },
  {
    id: "environments.badge",
    pane: "environments.environments",
    label: "Sidebar badge",
    labelKey: "settings.host.appearance.badge.label",
    keywords: ["host badge"],
    scope: device,
  },
  {
    id: "environments.restart",
    pane: "environments.environments",
    label: "Restart daemon",
    labelKey: "settings.host.daemon.restart.title",
    keywords: ["reboot", "reload host"],
    scope: environment,
  },
  {
    id: "environments.update",
    pane: "environments.environments",
    label: "Update daemon",
    labelKey: "settings.host.daemon.update.title",
    keywords: ["upgrade host"],
    scope: environment,
  },
  {
    id: "environments.remove",
    pane: "environments.environments",
    label: "Remove host",
    labelKey: "settings.host.daemon.remove.title",
    keywords: ["delete host", "disconnect", "danger zone"],
    scope: device,
  },
  {
    id: "environments.exceptions",
    pane: "environments.environments",
    label: "Environment exceptions",
    keywords: ["exclusions", "excluded profiles", "availability"],
    scope: installation,
  },
  {
    id: "environments.connections.list",
    pane: "environments.connections",
    label: "Connections",
    labelKey: "settings.host.connections.title",
    keywords: ["add connection", "ssh", "relay", "tcp", "remote host", "pair device", "phone"],
    scope: device,
  },

  // Plugins & integrations
  {
    id: "plugins.enable",
    pane: "plugins.plugins",
    label: "Enable plugins",
    labelKey: "settings.plugins.globalTitle",
    keywords: ["extensions", "install plugin", "trusted plugins"],
    scope: installation,
  },
  {
    id: "plugins.integrations.cli",
    pane: "plugins.integrations",
    label: "Command line",
    labelKey: "settings.integrations.commandLine.title",
    keywords: ["cli", "install", "terminal command"],
    scope: device,
  },

  // Maintenance
  {
    id: "maintenance.installation.owner",
    pane: "maintenance.installation",
    label: "Owner password",
    keywords: ["unlock", "owner access", "lock controls"],
    scope: installation,
  },
  {
    id: "maintenance.installation.restarts",
    pane: "maintenance.installation",
    label: "Host and container",
    keywords: ["restart approvals", "approve restart", "restart history", "daemon"],
    scope: installation,
  },
  {
    id: "maintenance.installation.automatic",
    pane: "maintenance.installation",
    label: "Automatic daemon updates and restarts",
    keywords: ["auto update", "idle restart"],
    scope: installation,
  },
  {
    id: "maintenance.installation.authorization",
    pane: "maintenance.installation",
    label: "Automatic maintenance authorization",
    scope: installation,
  },
  {
    id: "maintenance.installation.instructions",
    pane: "maintenance.installation",
    label: "Agent instruction changes",
    keywords: ["system prompt", "instruction request", "approve instructions"],
    scope: installation,
  },
  {
    id: "maintenance.installation.sessionHost",
    pane: "maintenance.installation",
    label: "Session host",
    keywords: ["durable sessions", "session host install"],
    scope: installation,
  },
  {
    id: "maintenance.updates.vorteo",
    pane: "maintenance.updates",
    label: "Vorteo updates",
    labelKey: "settings.about.vortonUpdates.title",
    keywords: ["check for updates", "new commits", "host update task"],
    scope: installation,
  },
  {
    id: "maintenance.upstream.merge",
    pane: "maintenance.upstream",
    label: "Paseo upstream updates",
    labelKey: "settings.about.upstreamUpdates.title",
    keywords: ["upstream merge", "host merge task", "copy host prompt"],
    scope: installation,
  },
];

export interface SettingsTarget {
  section: SettingsSectionId;
  /** The pane to scroll to, or null for the top of the section. */
  pane: string | null;
}

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

/**
 * Resolves a `/settings/<slug>` route to where it now lives. New section ids
 * open the section; slugs from the previous layout open the pane that absorbed
 * them, so bookmarks and agent-provided links keep working.
 */
export function resolveSettingsTarget(slug: string): SettingsTarget {
  if (isSettingsSectionId(slug)) return { section: slug, pane: null };
  const pane = SETTINGS_PANES.find((candidate) => candidate.legacySlugs?.includes(slug));
  if (pane) return { section: pane.section, pane: pane.id };
  return { section: "general", pane: null };
}

export interface SettingsAvailabilityContext {
  isDesktopApp: boolean;
  isWeb: boolean;
  isNative: boolean;
  hasHosts: boolean;
  hasInstallation: boolean;
}

export function isAvailable(
  item: SettingsAvailability,
  context: SettingsAvailabilityContext,
): boolean {
  if (item.desktopOnly && !context.isDesktopApp) return false;
  if (item.webOnly && !context.isWeb) return false;
  if (item.nativeOnly && !context.isNative) return false;
  if (item.requiresHost && !context.hasHosts) return false;
  if (item.requiresInstallation && !context.hasInstallation) return false;
  if (item.withoutInstallation && context.hasInstallation) return false;
  return true;
}

export function getSection(id: SettingsSectionId): SettingsSectionDefinition {
  const section = SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
  if (!section) throw new Error(`Unknown settings section: ${id}`);
  return section;
}

export function getPane(id: string): SettingsPaneDefinition | undefined {
  return SETTINGS_PANES.find((pane) => pane.id === id);
}

export function panesForSection(
  section: SettingsSectionId,
  context: SettingsAvailabilityContext,
): SettingsPaneDefinition[] {
  return SETTINGS_PANES.filter((pane) => pane.section === section && isAvailable(pane, context));
}
