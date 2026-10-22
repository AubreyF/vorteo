import { MIN_TEXT_WIDTH } from "@/agent-stream/columns/geometry";
import {
  buildExplorerCheckoutKey,
  isExplorerTab,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";
import { z } from "zod";

export const SUPPORTING_CARD_DEFAULTS = {
  goal: true,
  tasks: true,
  questions: true,
  journal: true,
  queue: true,
  subagents: true,
  providerSubagents: true,
  files: false,
  changes: false,
  // Collapsed by default: expanding it reads the provider's context breakdown.
  context: false,
  /** Left-sidebar cards that span every thread and account. */
  globalQuestions: true,
  globalQuota: true,
} as const;
export type SupportingCardLayout = "sidebar" | "inline";
export type SupportingCardKind = keyof typeof SUPPORTING_CARD_DEFAULTS;
export type SupportingCardUpdate = boolean | ((expanded: boolean) => boolean);
const SupportingCardStateSchema = z
  .object({
    goal: z.boolean(),
    tasks: z.boolean(),
    questions: z.boolean(),
    journal: z.boolean(),
    queue: z.boolean(),
    subagents: z.boolean(),
    providerSubagents: z.boolean(),
    files: z.boolean(),
    changes: z.boolean(),
    context: z.boolean(),
    globalQuestions: z.boolean(),
    globalQuota: z.boolean(),
  })
  .partial();

export type MobilePanelView = "agent" | "agent-list" | "file-explorer";

export interface MobilePanelSelection {
  target: MobilePanelView;
  revision: number;
}

export interface DesktopSidebarState {
  agentListOpen: boolean;
}

export type SortOption = "name" | "modified" | "size";

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 56;
export const MAX_SIDEBAR_WIDTH = 600;
export const COMPACT_SIDEBAR_WIDTH = 56;
export const SIDEBAR_COMPACT_SNAP_WIDTH = 160;
export const COMPACT_LABELED_SIDEBAR_WIDTH = 240;
export const SIDEBAR_OUTER_GAP = 8;

export const DEFAULT_TREE_RAIL_WIDTH = 260;
export const MIN_TREE_RAIL_WIDTH = 180;
export const MAX_TREE_RAIL_WIDTH = 600;

export interface PanelLayoutInput {
  isCompact: boolean;
}

export interface PanelCoreState {
  mobilePanel: MobilePanelSelection;
  desktop: DesktopSidebarState;
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function clampSidebarWidth(width: number): number {
  return clampNumber(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function clampTreeRailWidth(width: number): number {
  return clampNumber(width, MIN_TREE_RAIL_WIDTH, MAX_TREE_RAIL_WIDTH);
}

export function selectIsAgentListOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return input.isCompact ? state.mobilePanel.target === "agent-list" : state.desktop.agentListOpen;
}

/**
 * The overlay explorer exists only on compact layouts. Wider layouts render the
 * explorer as workspace tabs — see `@/workspace-tabs/explorer-surface`.
 */
export function selectIsCompactFileExplorerOpen(state: PanelCoreState): boolean {
  return state.mobilePanel.target === "file-explorer";
}

export function setMobilePanelTarget(
  selection: MobilePanelSelection,
  target: MobilePanelView,
): MobilePanelSelection {
  if (selection.target === target) {
    return selection;
  }
  return { target, revision: selection.revision + 1 };
}

function resolveExplorerTabFromCheckout(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): ExplorerTab {
  return resolveExplorerTabForCheckout({
    serverId: checkout.serverId,
    cwd: checkout.cwd,
    isGit: checkout.isGit,
    explorerTabByCheckout: state.explorerTabByCheckout,
  });
}

export interface OpenFileExplorerPatch {
  mobilePanel: MobilePanelSelection;
  explorerTab: ExplorerTab;
}

export function buildOpenFileExplorerPatch(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): OpenFileExplorerPatch {
  return {
    mobilePanel: setMobilePanelTarget(state.mobilePanel, "file-explorer"),
    explorerTab: resolveExplorerTabFromCheckout(state, checkout),
  };
}

export type ToggleFileExplorerPatch = OpenFileExplorerPatch | { mobilePanel: MobilePanelSelection };

export function buildToggleFileExplorerPatch(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): ToggleFileExplorerPatch {
  if (!selectIsCompactFileExplorerOpen(state)) {
    return buildOpenFileExplorerPatch(state, checkout);
  }
  return { mobilePanel: setMobilePanelTarget(state.mobilePanel, "agent") };
}

const ExplorerTabSchema = z.enum(["changes", "files", "pr"]);
const DesktopSidebarStorageSchema = z.strictObject({
  agentListOpen: z.boolean().optional(),
  // Legacy focus-mode keys are accepted only to discard them during migration.
  focusModeEnabled: z.boolean().optional(),
  zoomed: z.boolean().optional(),
  focused: z.boolean().optional(),
  // Accepted only so migration can discard the former docked explorer sidebar.
  // The schema is strict and a parse failure drops the whole entry, so removing
  // this key outright would wipe every upgrading user's panel state.
  fileExplorerOpen: z.boolean().optional(),
});

export const PanelPersistedStateSchema = z.strictObject({
  supportingCardExpanded: SupportingCardStateSchema.optional(),
  inlineCardExpanded: SupportingCardStateSchema.optional(),
  mobileView: z.enum(["agent", "agent-list", "file-explorer"]).optional(),
  mobilePanel: z
    .strictObject({
      target: z.enum(["agent", "agent-list", "file-explorer"]),
      revision: z.number().int().nonnegative(),
    })
    .optional(),
  desktop: DesktopSidebarStorageSchema.optional(),
  explorerTab: ExplorerTabSchema.optional(),
  explorerTabByCheckout: z.record(z.string(), ExplorerTabSchema).optional(),
  expandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  // Accepted only so migration can discard the former per-file diff expansion state.
  diffExpandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  diffCollapsedFoldersByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  collapsedFilePathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  // Card heights the owner dragged, keyed by card; absent cards size automatically.
  cardHeights: z.record(z.string(), z.number()).optional(),
  sidebarWidth: z.number().optional(),
  sidebarCompact: z.boolean().optional(),
  sidebarNarrow: z.boolean().optional(),
  // Accepted only so migration can discard the former docked explorer sidebar width.
  explorerWidth: z.number().optional(),
  explorerSortOption: z.enum(["name", "modified", "size"]).optional(),
  explorerShowHiddenFiles: z.boolean().optional(),
  explorerFilesSplitRatio: z.number().optional(),
  treeRailWidth: z.number().optional(),
  fileTreeVisible: z.boolean().optional(),
});

type MigratablePanelState = z.infer<typeof PanelPersistedStateSchema>;

function migratePanelExplorerTabByCheckout(state: MigratablePanelState, version: number): void {
  if (
    version < 4 ||
    typeof state.explorerTabByCheckout !== "object" ||
    !state.explorerTabByCheckout
  ) {
    state.explorerTabByCheckout = {};
    return;
  }
  const entries = Object.entries(state.explorerTabByCheckout);
  const next: Record<string, ExplorerTab> = {};
  for (const [key, value] of entries) {
    if (!isExplorerTab(value)) {
      continue;
    }
    next[key] = value;
  }
  state.explorerTabByCheckout = next;
}

// v16 narrowed the rail. Existing installs almost all carry the old 320 default,
// so the reset is what makes the narrower rail visible to anyone but a new user.
function migrateTreeRailWidth(state: MigratablePanelState, version: number): void {
  if (version < 16 || typeof state.treeRailWidth !== "number") {
    delete state.explorerFilesSplitRatio;
    state.treeRailWidth = DEFAULT_TREE_RAIL_WIDTH;
    return;
  }
  state.treeRailWidth = clampTreeRailWidth(state.treeRailWidth);
}

function migrateCardLayouts(state: MigratablePanelState, version: number) {
  // Seed both layouts from the existing device choice once, then keep them independent.
  if (version < 19 && state.inlineCardExpanded === undefined) {
    state.inlineCardExpanded = { ...state.supportingCardExpanded };
  }
}

export function migratePanelState(persistedState: unknown, version: number): MigratablePanelState {
  const result = PanelPersistedStateSchema.safeParse(persistedState);
  const state: MigratablePanelState = result.success ? result.data : {};

  migrateCardLayouts(state, version);

  // The docked explorer sidebar is gone; wider layouts render the explorer as
  // workspace tabs. Left behind, `fileExplorerOpen` kept drawing a sidebar that
  // nothing could close.
  delete state.explorerWidth;
  if (state.desktop) {
    delete state.desktop.fileExplorerOpen;
  }
  if (!isExplorerTab(state.explorerTab)) {
    state.explorerTab = "changes";
  }
  // A previously hidden desktop sidebar becomes the persistent minimal rail.
  if (state.desktop?.agentListOpen === false) {
    state.sidebarCompact = true;
    state.desktop.agentListOpen = true;
  }
  migratePanelExplorerTabByCheckout(state, version);
  if (state.desktop) {
    delete state.desktop.focusModeEnabled;
    delete state.desktop.zoomed;
    delete state.desktop.focused;
  }
  if (version < 6 || typeof state.sidebarWidth !== "number") {
    state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  }
  if (
    version < 9 ||
    typeof state.expandedPathsByWorkspace !== "object" ||
    !state.expandedPathsByWorkspace
  ) {
    state.expandedPathsByWorkspace = {};
  }
  delete state.diffExpandedPathsByWorkspace;
  if (
    version < 12 ||
    typeof state.diffCollapsedFoldersByWorkspace !== "object" ||
    !state.diffCollapsedFoldersByWorkspace
  ) {
    state.diffCollapsedFoldersByWorkspace = {};
  }
  if (
    typeof state.collapsedFilePathsByWorkspace !== "object" ||
    !state.collapsedFilePathsByWorkspace
  ) {
    state.collapsedFilePathsByWorkspace = {};
  }
  if (typeof state.explorerShowHiddenFiles !== "boolean") {
    state.explorerShowHiddenFiles = true;
  }
  migrateTreeRailWidth(state, version);
  if (typeof state.fileTreeVisible !== "boolean") {
    state.fileTreeVisible = true;
  }
  if (version < 12) {
    // Compact panel position is transient UI state. Cold starts always begin
    // at content, regardless of what an older version persisted.
    delete state.mobileView;
    delete state.mobilePanel;
  }

  return state;
}

export { buildExplorerCheckoutKey, resolveExplorerTabForCheckout };
export type { ExplorerTab, ExplorerCheckoutContext };

// Keep the minimal rail visible and preserve the user's expanded resize width.
export function cycleDesktopSidebar(state: { sidebarCompact: boolean; sidebarNarrow: boolean }) {
  return { sidebarCompact: !state.sidebarCompact, sidebarNarrow: false };
}

/** Resize constraints are presentation only; never replace the saved desktop choice. */
export function resolveResponsiveSidebar(
  state: {
    sidebarCompact: boolean;
    sidebarNarrow: boolean;
    sidebarWidth: number;
    sidebarViewportOverride?: number | null;
  },
  viewportWidth: number,
) {
  // Ignore the retired intermediate mode in existing device preferences.
  const requestedWidth = state.sidebarWidth;
  const autoCompact =
    viewportWidth < requestedWidth + MIN_TEXT_WIDTH + SIDEBAR_OUTER_GAP * 2 &&
    state.sidebarViewportOverride !== viewportWidth;
  return {
    sidebarCompact: state.sidebarCompact || autoCompact,
    sidebarNarrow: false,
  };
}
