import type {
  ProjectDirectoryBrowsePayload,
  ProjectDirectoryBrowseRequest,
} from "@getpaseo/protocol/messages";
import { shortenPath } from "@/utils/shorten-path";

// One browser serves every Add Project destination: opening an existing folder,
// creating a folder, and choosing where a clone lands. Locations come from the
// daemon's browse roots, so a selected parent always exists when it is used.

export type FolderBrowseRequest = Omit<ProjectDirectoryBrowseRequest, "type" | "requestId">;
export type FolderBrowseRoot = ProjectDirectoryBrowsePayload["roots"][number];
export type FolderBrowseDirectory = NonNullable<ProjectDirectoryBrowsePayload["directory"]>;

export type FolderBrowserPurpose =
  | { kind: "open" }
  | { kind: "create" }
  | { kind: "clone"; repositoryName: string };

export type FolderBrowserRow =
  | {
      kind: "location";
      id: string;
      title: string;
      subtitle: string | null;
      target: FolderBrowseRequest;
    }
  | { kind: "folder"; id: string; title: string; target: FolderBrowseRequest }
  | { kind: "use-current"; id: string; title: string; subtitle: string; disabled: boolean }
  | { kind: "create"; id: string; title: string; subtitle: string; name: string }
  | { kind: "go-to"; id: string; title: string; target: FolderBrowseRequest }
  // Opens a typed or searched path directly. Only offered when opening a folder.
  | { kind: "open-path"; id: string; title: string; subtitle: string | null; path: string }
  // Typed-path actions for folders outside the browsable locations, such as
  // /tmp on a native host. The daemon validates the parent when they run.
  | {
      kind: "create-at-path";
      id: string;
      title: string;
      subtitle: string;
      parentPath: string;
      name: string;
    }
  | { kind: "clone-at-path"; id: string; title: string; subtitle: string; parentPath: string }
  // A daemon search match that the browser can show; entering it browses there.
  | { kind: "search-result"; id: string; title: string; target: FolderBrowseRequest }
  | { kind: "page"; id: string; title: string; target: FolderBrowseRequest };

export interface FolderLocationLabel {
  // Where the user is, in terms they recognize: a host path, or a named
  // container location. Container home is never abbreviated to "~", because
  // "~" means the host user's home everywhere else in this flow.
  title: string;
  // The other side of a shared folder, when it is useful context.
  detail: string | null;
}

const PAGE_SIZE = 100;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, "/");
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  return trimmed.length === 0 ? path.slice(0, 1) : trimmed;
}

function isInside(parent: string, candidate: string): boolean {
  const base = normalizeSeparators(trimTrailingSeparators(parent));
  const path = normalizeSeparators(trimTrailingSeparators(candidate));
  if (path === base) return true;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(prefix);
}

function relativeTo(parent: string, candidate: string): string {
  const base = normalizeSeparators(trimTrailingSeparators(parent));
  const path = normalizeSeparators(trimTrailingSeparators(candidate));
  if (path === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.slice(prefix.length);
}

function joinDisplayPath(base: string, relative: string): string {
  if (relative === "." || relative === "") return base;
  const normalized = normalizeSeparators(relative);
  return base.endsWith("/") ? `${base}${normalized}` : `${base}/${normalized}`;
}

export function isContainerOnlyRoot(root: FolderBrowseRoot): boolean {
  return root.hostPath === null;
}

export function rootTitle(root: FolderBrowseRoot): string {
  return root.hostPath ? shortenPath(root.hostPath) : root.label;
}

export function rootSubtitle(root: FolderBrowseRoot): string | null {
  if (!root.hostPath) return null;
  return root.hostPath === root.containerPath ? null : "Shared folder";
}

export function folderLocationLabel(
  roots: FolderBrowseRoot[],
  directory: FolderBrowseDirectory,
): FolderLocationLabel {
  if (directory.hostPath) {
    const root = roots.find((candidate) => candidate.id === directory.rootId);
    const shared = root?.hostPath != null && root.hostPath !== root.containerPath;
    return { title: shortenPath(directory.hostPath), detail: shared ? "Shared folder" : null };
  }
  const root = roots.find((candidate) => candidate.id === directory.rootId);
  const label = root?.label ?? "Container";
  return { title: joinDisplayPath(label, directory.path), detail: null };
}

// Display path for a folder that will exist under the current directory.
export function childDisplayPath(
  roots: FolderBrowseRoot[],
  directory: FolderBrowseDirectory,
  name: string,
): string {
  return joinDisplayPath(folderLocationLabel(roots, directory).title, name);
}

// Maps a container path, such as a recent project's parent, to a browsable
// location. The most specific root wins so nested shares resolve correctly.
export function containerPathToRequest(
  path: string,
  roots: FolderBrowseRoot[],
): FolderBrowseRequest | null {
  const root = roots
    .filter((candidate) => isInside(candidate.containerPath, path))
    .sort((a, b) => b.containerPath.length - a.containerPath.length)[0];
  if (!root) return null;
  return { rootId: root.id, path: relativeTo(root.containerPath, path) };
}

function hostPathToRequest(path: string, roots: FolderBrowseRoot[]): FolderBrowseRequest | null {
  const root = roots
    .filter((candidate) => candidate.hostPath && isInside(candidate.hostPath, path))
    .sort((a, b) => (b.hostPath?.length ?? 0) - (a.hostPath?.length ?? 0))[0];
  if (!root?.hostPath) return null;
  return { rootId: root.id, path: relativeTo(root.hostPath, path) };
}

export function looksLikePath(input: string): boolean {
  const trimmed = input.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/u.test(trimmed)
  );
}

// Typed paths are host paths first: "~" is the host user's home, and an
// absolute path inside a shared folder resolves through that share. Container
// paths are accepted next so pasted daemon paths still work. Anything else goes
// to the daemon as a host path, which explains unshared folders.
export function typedPathToRequest(input: string, roots: FolderBrowseRoot[]): FolderBrowseRequest {
  const trimmed = input.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) return { hostPath: trimmed };
  return (
    hostPathToRequest(trimmed, roots) ??
    containerPathToRequest(trimmed, roots) ?? { hostPath: trimmed }
  );
}

// The daemon's own path for a typed path, for actions that bypass browsing.
// Host paths inside a shared folder become their container paths. In a
// container, "~" means the host home to the owner but the container home to the
// daemon, so those paths must be browsed instead.
export function typedPathToDaemonPath(input: string, roots: FolderBrowseRoot[]): string | null {
  const trimmed = input.trim();
  const inContainer = roots.some(isContainerOnlyRoot);
  if (trimmed === "~" || trimmed.startsWith("~/")) return inContainer ? null : trimmed;
  const request = hostPathToRequest(trimmed, roots);
  const root = request ? roots.find((candidate) => candidate.id === request.rootId) : null;
  if (!request || !root) return trimmed;
  return joinDisplayPath(trimTrailingSeparators(root.containerPath), request.path ?? ".");
}

export function parentRequest(directory: FolderBrowseDirectory): FolderBrowseRequest | null {
  if (directory.parent === null) return null;
  return { rootId: directory.rootId, path: directory.parent };
}

function pathBaseName(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

function parentPath(path: string): string | null {
  const trimmed = trimTrailingSeparators(path);
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

// Parents of recent projects are the likeliest places for a new one.
export function recentLocationRows(
  recentProjectPaths: string[],
  roots: FolderBrowseRoot[],
  limit = 4,
): FolderBrowserRow[] {
  const rows: FolderBrowserRow[] = [];
  const seen = new Set<string>();
  for (const projectPath of recentProjectPaths) {
    const parent = parentPath(projectPath);
    if (!parent) continue;
    const target = containerPathToRequest(parent, roots);
    if (!target?.rootId) continue;
    const key = `${target.rootId}\u0000${target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const root = roots.find((candidate) => candidate.id === target.rootId);
    if (!root) continue;
    const title = root.hostPath
      ? shortenPath(joinDisplayPath(root.hostPath, target.path ?? "."))
      : joinDisplayPath(root.label, target.path ?? ".");
    rows.push({ kind: "location", id: `recent:${key}`, title, subtitle: "Recent", target });
    if (rows.length >= limit) break;
  }
  return rows;
}

export function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a folder name";
  if (trimmed === "." || trimmed === "..") return "Choose a different folder name";
  if (/[\\/]/u.test(trimmed) || trimmed.includes("\0")) {
    return "Folder names cannot contain slashes";
  }
  return null;
}

export interface BuildFolderBrowserRowsInput {
  purpose: FolderBrowserPurpose;
  payload: ProjectDirectoryBrowsePayload | null;
  request: FolderBrowseRequest;
  filter: string;
  recentProjectPaths: string[];
  // Daemon directory-search matches for the filter, as daemon paths.
  searchResults?: string[];
}

export function isTopLevelRequest(request: FolderBrowseRequest): boolean {
  return request.rootId === undefined && request.hostPath === undefined;
}

// Directory search runs only from the top-level locations list. Inside a
// folder, typing filters that folder's children instead.
export function folderBrowserSearchQuery(request: FolderBrowseRequest, filter: string): string {
  const trimmed = filter.trim();
  if (!isTopLevelRequest(request) || !trimmed || looksLikePath(trimmed)) return "";
  return trimmed;
}

// Daemon paths shown in the owner's terms: shared folders by host path,
// container storage by location name.
export function displayDaemonPath(path: string, roots: FolderBrowseRoot[]): string {
  const target = containerPathToRequest(path, roots);
  const root = target ? roots.find((candidate) => candidate.id === target.rootId) : null;
  if (!target || !root) return path;
  return root.hostPath
    ? shortenPath(joinDisplayPath(root.hostPath, target.path ?? "."))
    : joinDisplayPath(root.label, target.path ?? ".");
}

export function buildFolderBrowserRows(input: BuildFolderBrowserRowsInput): FolderBrowserRow[] {
  const filter = input.filter.trim();
  const roots = input.payload?.roots ?? [];
  if (looksLikePath(filter)) return typedPathRows(filter, input.purpose, roots);

  const directory = input.payload?.directory ?? null;
  if (!directory) {
    return [
      ...topLevelRows(roots, filter, input.recentProjectPaths),
      ...searchResultRows(input.purpose, roots, input.searchResults ?? []),
    ];
  }

  const needle = filter.toLowerCase();
  const matches = directory.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  // Exact matches first, then prefix matches, so Enter picks the obvious folder.
  const ranked = needle
    ? [...matches].sort((a, b) => matchRank(a.name, needle) - matchRank(b.name, needle))
    : matches;
  const folders: FolderBrowserRow[] = ranked.map((entry) => ({
    kind: "folder",
    id: `folder:${entry.path}`,
    title: entry.name,
    target: { rootId: directory.rootId, path: entry.path },
  }));

  const rows: FolderBrowserRow[] = [];
  if (!filter) {
    const current = currentFolderActionRow(input.purpose, roots, directory);
    if (current) rows.push(current);
  }
  rows.push(...folders);
  if (input.purpose.kind === "create" && filter) {
    const exists = directory.entries.some((entry) => entry.name.toLowerCase() === needle);
    if (!exists && validateFolderName(filter) === null) {
      rows.push({
        kind: "create",
        id: `create:${filter}`,
        title: `Create folder “${filter}”`,
        subtitle: childDisplayPath(roots, directory, filter),
        name: filter,
      });
    }
  }
  if (!filter) rows.push(...pageRows(input.request, directory));
  return rows;
}

function typedPathRows(
  filter: string,
  purpose: FolderBrowserPurpose,
  roots: FolderBrowseRoot[],
): FolderBrowserRow[] {
  const goTo: FolderBrowserRow = {
    kind: "go-to",
    id: `go-to:${filter}`,
    title: `Browse ${filter}`,
    target: typedPathToRequest(filter, roots),
  };
  const daemonPath = typedPathToDaemonPath(filter, roots);
  if (purpose.kind === "create") {
    const rows: FolderBrowserRow[] = [{ ...goTo, title: `Go to ${filter}` }];
    const parent = parentPath(filter);
    const daemonParent = daemonPath ? parentPath(daemonPath) : null;
    const name = pathBaseName(filter);
    if (parent && daemonParent && validateFolderName(name) === null && name !== "~") {
      rows.push({
        kind: "create-at-path",
        id: `create-at-path:${filter}`,
        title: `Create folder “${name}”`,
        subtitle: `In ${parent}`,
        parentPath: daemonParent,
        name,
      });
    }
    return rows;
  }
  if (purpose.kind === "clone") {
    const rows: FolderBrowserRow[] = [{ ...goTo, title: `Go to ${filter}` }];
    if (daemonPath) {
      rows.push({
        kind: "clone-at-path",
        id: `clone-at-path:${filter}`,
        title: `Clone into ${filter}`,
        subtitle: joinDisplayPath(trimTrailingSeparators(filter), purpose.repositoryName),
        parentPath: daemonPath,
      });
    }
    return rows;
  }
  if (!daemonPath) return [goTo];
  // A pasted path usually means "open this". The daemon validates it.
  return [
    {
      kind: "open-path",
      id: `open-path:${filter}`,
      title: `Open ${filter}`,
      subtitle: null,
      path: daemonPath,
    },
    goTo,
  ];
}

function searchResultRows(
  purpose: FolderBrowserPurpose,
  roots: FolderBrowseRoot[],
  paths: string[],
): FolderBrowserRow[] {
  return paths.flatMap<FolderBrowserRow>((path) => {
    const title = displayDaemonPath(path, roots);
    if (purpose.kind === "open") {
      return [{ kind: "open-path", id: `open-path:${path}`, title, subtitle: null, path }];
    }
    const target = containerPathToRequest(path, roots);
    return target ? [{ kind: "search-result", id: `search:${path}`, title, target }] : [];
  });
}

function matchRank(name: string, needle: string): number {
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  return 2;
}

function topLevelRows(
  roots: FolderBrowseRoot[],
  filter: string,
  recentProjectPaths: string[],
): FolderBrowserRow[] {
  const needle = filter.toLowerCase();
  // Shared host folders come first: they are what "my folders" means to the
  // owner. Container-only storage follows under its own name.
  const ordered = [...roots].sort(
    (a, b) => Number(isContainerOnlyRoot(a)) - Number(isContainerOnlyRoot(b)),
  );
  const rootRows: FolderBrowserRow[] = ordered.map((root) => ({
    kind: "location",
    id: `root:${root.id}`,
    title: rootTitle(root),
    subtitle: rootSubtitle(root),
    target: { rootId: root.id },
  }));
  const rows = [...recentLocationRows(recentProjectPaths, roots), ...rootRows];
  if (!needle) return rows;
  return rows.filter((row) => row.kind === "location" && row.title.toLowerCase().includes(needle));
}

function currentFolderActionRow(
  purpose: FolderBrowserPurpose,
  roots: FolderBrowseRoot[],
  directory: FolderBrowseDirectory,
): FolderBrowserRow | null {
  const location = folderLocationLabel(roots, directory).title;
  if (purpose.kind === "open") {
    return {
      kind: "use-current",
      id: "use-current",
      title: "Open this folder",
      subtitle: location,
      disabled: false,
    };
  }
  if (purpose.kind === "clone") {
    const exists = directory.entries.some(
      (entry) => entry.name.toLowerCase() === purpose.repositoryName.toLowerCase(),
    );
    return {
      kind: "use-current",
      id: "use-current",
      title: exists ? `“${purpose.repositoryName}” already exists here` : "Clone here",
      subtitle: childDisplayPath(roots, directory, purpose.repositoryName),
      disabled: exists,
    };
  }
  return null;
}

function pageRows(
  request: FolderBrowseRequest,
  directory: FolderBrowseDirectory,
): FolderBrowserRow[] {
  const rows: FolderBrowserRow[] = [];
  const base = { rootId: directory.rootId, path: directory.path, showHidden: request.showHidden };
  const offset = request.offset ?? 0;
  if (offset > 0) {
    rows.push({
      kind: "page",
      id: "page:previous",
      title: "Previous folders",
      target: { ...base, offset: Math.max(0, offset - PAGE_SIZE) },
    });
  }
  if (directory.nextOffset !== null) {
    rows.push({
      kind: "page",
      id: "page:next",
      title: "More folders",
      target: { ...base, offset: directory.nextOffset },
    });
  }
  return rows;
}

export function folderBrowserEmptyText(input: {
  purpose: FolderBrowserPurpose;
  directory: FolderBrowseDirectory | null;
  filter: string;
}): string {
  if (!input.directory) return "No matching locations";
  if (input.filter.trim()) {
    return input.purpose.kind === "create"
      ? "Choose a different folder name"
      : "No matching folders";
  }
  return "No folders here";
}

export function folderBrowserPlaceholder(
  purpose: FolderBrowserPurpose,
  atTopLevel: boolean,
): string {
  if (atTopLevel) return "Search folders by name or enter a path...";
  if (purpose.kind === "create") return "New folder name, or filter folders...";
  return "Filter folders or enter a path...";
}

// Friendly text for create failures. The daemon's own messages include
// container paths, which mean nothing to the owner.
export function createFolderErrorText(input: {
  errorCode: string | null;
  error: string | null;
  name: string;
}): string {
  switch (input.errorCode) {
    case "directory_exists":
      return `A folder named “${input.name}” already exists here`;
    case "permission_denied":
      return "This location does not allow new folders";
    case "parent_directory_not_found":
      return "This folder no longer exists. Go up and choose another location.";
    case "invalid_name":
      return input.error ?? "Choose a different folder name";
    default:
      return input.error ?? "Unable to create folder";
  }
}

// Projects folder flow. The list only moves between folders; choosing happens in a
// fixed footer that always names its target.

export interface ProjectsFolderRow {
  id: string;
  title: string;
  target: FolderBrowseRequest;
  // Daemon path of the folder, for one-click actions on its row.
  path: string;
  git: boolean;
  projectId: string | null;
  // Choosing a row enters the folder, except an existing project while adding, which opens it.
  action: "enter" | "open-project";
  // A git checkout that is not yet a project can be added straight from its row.
  canAdd: boolean;
}

export function projectsFolderRows(input: {
  purpose: FolderBrowserPurpose;
  directory: FolderBrowseDirectory | null;
  filter: string;
}): ProjectsFolderRow[] {
  const { directory, purpose } = input;
  if (!directory) return [];
  const needle = input.filter.trim().toLowerCase();
  const matches = directory.entries.filter((entry) => entry.name.toLowerCase().includes(needle));
  const ranked = needle
    ? [...matches].sort((a, b) => matchRank(a.name, needle) - matchRank(b.name, needle))
    : matches;
  const adding = purpose.kind !== "clone";
  return ranked.map((entry) => {
    const projectId = entry.projectId ?? null;
    const git = entry.git === true;
    return {
      id: `folder:${entry.path}`,
      title: entry.name,
      target: { rootId: directory.rootId, path: entry.path },
      path: joinDisplayPath(trimTrailingSeparators(directory.containerPath), entry.name),
      git,
      projectId,
      action: adding && projectId ? "open-project" : "enter",
      canAdd: adding && git && !projectId,
    };
  });
}

// Where the Projects folder browser opens: the last folder used on this host, else the root.
export function projectsFolderStartRequest(lastPath: string | undefined): FolderBrowseRequest {
  return { path: lastPath && lastPath.trim() ? lastPath : "." };
}

export interface ProjectsFolderCrumb {
  label: string;
  target: FolderBrowseRequest;
}

// "Projects / app / packages": each segment returns to that folder.
export function projectsFolderBreadcrumb(
  directory: FolderBrowseDirectory | null,
): ProjectsFolderCrumb[] {
  const crumbs: ProjectsFolderCrumb[] = [
    { label: "Projects", target: directory ? { rootId: directory.rootId, path: "." } : {} },
  ];
  if (!directory || directory.path === ".") return crumbs;
  const segments = normalizeSeparators(directory.path).split("/").filter(Boolean);
  segments.forEach((segment, index) => {
    crumbs.push({
      label: segment,
      target: { rootId: directory.rootId, path: segments.slice(0, index + 1).join("/") },
    });
  });
  return crumbs;
}

export type ProjectsFolderFooterAction = "add" | "open" | "clone";

export interface ProjectsFolderFooter {
  action: ProjectsFolderFooterAction;
  label: string;
  // Where the action lands, in the owner's terms.
  detail: string;
  disabled: boolean;
  // Why the action is unavailable, when it is.
  reason: string | null;
  canCreateFolder: boolean;
}

function samePath(left: string, right: string): boolean {
  return (
    normalizeSeparators(trimTrailingSeparators(left)) ===
    normalizeSeparators(trimTrailingSeparators(right))
  );
}

export function projectsFolderFooter(input: {
  purpose: FolderBrowserPurpose;
  directory: FolderBrowseDirectory | null;
  // Roots of projects this host already has.
  projectPaths: readonly string[];
}): ProjectsFolderFooter {
  const { directory, purpose } = input;
  const atRoot = directory?.parent === null;
  const name = !directory || atRoot ? "Projects" : pathBaseName(directory.containerPath);
  const detail = directory ? shortenPath(directory.containerPath) : "";
  if (purpose.kind === "clone") {
    const exists =
      directory?.entries.some(
        (entry) => entry.name.toLowerCase() === purpose.repositoryName.toLowerCase(),
      ) ?? false;
    return {
      action: "clone",
      label: "Clone here",
      detail: directory
        ? shortenPath(
            joinDisplayPath(
              trimTrailingSeparators(directory.containerPath),
              purpose.repositoryName,
            ),
          )
        : "",
      disabled: !directory || exists,
      reason: exists ? `“${purpose.repositoryName}” already exists here` : null,
      canCreateFolder: directory !== null,
    };
  }
  const isProject =
    directory !== null &&
    input.projectPaths.some((path) => samePath(path, directory.containerPath));
  if (isProject) {
    return {
      action: "open",
      label: `Open “${name}”`,
      detail,
      disabled: false,
      reason: null,
      canCreateFolder: true,
    };
  }
  return {
    action: "add",
    label: `Add “${name}” as project`,
    detail,
    disabled: !directory || atRoot,
    reason: atRoot ? "Open or create a folder inside Projects to add it" : null,
    canCreateFolder: directory !== null,
  };
}

// The folder a new-folder row creates, shown while the name is typed.
export function newFolderPreview(directory: FolderBrowseDirectory, name: string): string {
  return shortenPath(joinDisplayPath(trimTrailingSeparators(directory.containerPath), name.trim()));
}

// After creating a folder, the browser moves into it.
export function childFolderRequest(
  directory: FolderBrowseDirectory,
  name: string,
  showHidden?: boolean,
): FolderBrowseRequest {
  const path = directory.path === "." ? name : `${normalizeSeparators(directory.path)}/${name}`;
  return showHidden
    ? { rootId: directory.rootId, path, showHidden }
    : { rootId: directory.rootId, path };
}
