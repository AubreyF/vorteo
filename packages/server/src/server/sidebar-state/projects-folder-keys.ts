// Moves sidebar project view keys recorded under an alias of the Projects folder, such as
// `host:<serverId>:<old container path>`, to the folder's logical path. Project keys
// changed when the Dev registry moved, so state saved under the earlier keys no longer
// matched any project and lost its order and collapse state. See
// docs/execution-installation.md#projects-folder.
import type { SidebarState } from "@getpaseo/protocol/sidebar-state";

type MapKey = (key: string) => string;

/** Prefixes that wrap a project view key in `collapsedWorkspaceGroups` and `childOrder`. */
const GROUP_PREFIXES = ["standing:", "factory:"] as const;
const PROJECT_CONTAINER_PREFIX = "project:";

function mapPrefixed(key: string, prefixes: readonly string[], mapKey: MapKey): string {
  for (const prefix of prefixes) {
    if (key.startsWith(prefix)) return `${prefix}${mapKey(key.slice(prefix.length))}`;
  }
  return key;
}

/** Maps entries in order. A moved entry whose new form is already present is dropped. */
function mapList(values: readonly string[], mapKey: MapKey): string[] {
  const unchanged = new Set(values.filter((value) => mapKey(value) === value));
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const mapped = mapKey(value);
    if (mapped !== value && unchanged.has(mapped)) continue;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

/** Maps record keys. When the old and new keys both exist, the new key's value wins. */
function mapRecord<T>(
  record: Record<string, T>,
  mapKey: MapKey,
  mapValue: (value: T) => T = (value) => value,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (mapKey(key) === key) next[key] = mapValue(value);
  }
  for (const [key, value] of Object.entries(record)) {
    const mapped = mapKey(key);
    if (mapped !== key && !(mapped in next)) next[mapped] = mapValue(value);
  }
  return next;
}

/**
 * Returns the state with every project view key passed through `mapProjectKey`, or null
 * when nothing changes. Workspace keys (`serverId:workspaceId`), folder ids and server
 * filters are left alone because `mapProjectKey` only rewrites path-bearing keys.
 */
export function rewriteSidebarStateProjectKeys(
  state: SidebarState,
  mapProjectKey: MapKey,
): SidebarState | null {
  const mapGroup = (key: string) => mapPrefixed(key, GROUP_PREFIXES, mapProjectKey);
  const mapContainer = (key: string) => mapPrefixed(key, [PROJECT_CONTAINER_PREFIX], mapProjectKey);
  const next: SidebarState = {
    ...state,
    projectOrder: mapList(state.projectOrder, mapProjectKey),
    workspaceOrderByProject: mapRecord(state.workspaceOrderByProject, mapProjectKey),
    collapsedProjects: mapRecord(state.collapsedProjects, mapProjectKey),
    collapsedWorkspaceGroups: mapRecord(state.collapsedWorkspaceGroups, mapGroup),
    projectFilters: mapList(state.projectFilters, mapProjectKey),
  };
  if (state.sidebarFolders) {
    next.sidebarFolders = Object.fromEntries(
      Object.entries(state.sidebarFolders).map(([id, folder]) => [
        id,
        folder.scope.kind === "project"
          ? {
              ...folder,
              scope: { ...folder.scope, projectKey: mapProjectKey(folder.scope.projectKey) },
            }
          : folder,
      ]),
    );
  }
  if (state.itemFolder) next.itemFolder = mapRecord(state.itemFolder, mapProjectKey);
  if (state.childOrder) {
    next.childOrder = mapRecord(state.childOrder, mapContainer, (entries) =>
      mapList(entries, mapProjectKey),
    );
  }
  return JSON.stringify(next) === JSON.stringify(state) ? null : next;
}
