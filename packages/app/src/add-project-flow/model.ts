import type { FolderBrowseRequest } from "./folder-browser";

export interface AddProjectHost {
  serverId: string;
  label: string;
  canAddProject: boolean;
  canBrowse: boolean;
  // The daemon can list its folders, so every destination uses the folder browser.
  canBrowseFolders: boolean;
  canCloneGithubRepositories: boolean;
  canSearchGithubRepositories: boolean;
  canCreateDirectory: boolean;
  // The installation's Projects folder. Hosts that advertise one get the simpler flow:
  // every new project is chosen, created or cloned inside it.
  projectsRoot: string | null;
}

export interface GithubRepositoryChoice {
  id: string;
  nameWithOwner: string;
  cloneUrl: string;
  cloneProtocol?: "https" | "ssh";
  description: string | null;
  updatedAt: string | null;
}

export type FolderBrowserPagePurpose =
  | { kind: "open" }
  | { kind: "create" }
  | { kind: "clone"; repository: GithubRepositoryChoice };

interface PageState {
  activeIndex: number;
  error: string | null;
}

interface SearchPageState extends PageState {
  query: string;
}

export type AddProjectPage =
  | ({ kind: "host" } & SearchPageState)
  | ({ kind: "method"; hostId: string; isSubmitting: boolean } & PageState)
  | ({ kind: "directory-search"; hostId: string; isSubmitting: boolean } & SearchPageState)
  | ({ kind: "github-search"; hostId: string } & SearchPageState)
  | ({
      kind: "github-location";
      hostId: string;
      repository: GithubRepositoryChoice;
      isSubmitting: boolean;
    } & SearchPageState)
  | ({
      kind: "folder-browser";
      hostId: string;
      purpose: FolderBrowserPagePurpose;
      // The folder being shown. An empty request lists the top-level locations.
      request: FolderBrowseRequest;
      isSubmitting: boolean;
      // Projects folder flow: the name typed for a new folder, while naming one.
      newFolderName?: string | null;
    } & SearchPageState)
  | ({
      // Projects folder flow: confirm the default clone destination or change it.
      kind: "clone-destination";
      hostId: string;
      repository: GithubRepositoryChoice;
      isSubmitting: boolean;
    } & PageState)
  | ({ kind: "new-directory-parent"; hostId: string } & SearchPageState)
  | {
      kind: "new-directory-name";
      hostId: string;
      parentPath: string;
      name: string;
      activeIndex: number;
      error: string | null;
      isSubmitting: boolean;
    };

export interface AddProjectFlowState {
  hosts: AddProjectHost[];
  pages: AddProjectPage[];
  newDirectoryNameDrafts: Record<string, string>;
  githubLocationDrafts: Record<string, { query: string; activeIndex: number }>;
}

export interface OpenAddProjectFlowInput {
  hosts: AddProjectHost[];
  preferredHostId?: string;
  // The installation's Host daemon, preferred for Projects folder work.
  installationHostId?: string;
}

// With a Projects folder there is no host step: projects are shared across environments,
// so the installation's Host daemon adds them, otherwise the first capable online host.
export function selectProjectsFolderHost(
  hosts: AddProjectHost[],
  installationHostId?: string,
): AddProjectHost | null {
  const capable = hosts.filter((host) => host.canAddProject && host.projectsRoot !== null);
  return capable.find((host) => host.serverId === installationHostId) ?? capable[0] ?? null;
}

function initialHost(
  hosts: AddProjectHost[],
  preferredHostId: string | undefined,
  installationHostId: string | undefined,
): AddProjectHost | null {
  const projectsHost = selectProjectsFolderHost(hosts, installationHostId);
  if (projectsHost) return projectsHost;
  const preferredHost = preferredHostId
    ? hosts.find((host) => host.serverId === preferredHostId)
    : null;
  return preferredHost ?? (hosts.length === 1 ? hosts[0] : null) ?? null;
}

type SearchPageKind = Extract<AddProjectPage, { query: string }>["kind"];

function searchPage<TKind extends SearchPageKind>(kind: TKind) {
  return { kind, query: "", activeIndex: 0, error: null } as const;
}

function methodPage(hostId: string): AddProjectPage {
  return { kind: "method", hostId, activeIndex: 0, error: null, isSubmitting: false };
}

export function openAddProjectFlow(input: OpenAddProjectFlowInput): AddProjectFlowState {
  const host = initialHost(input.hosts, input.preferredHostId, input.installationHostId);
  return {
    hosts: input.hosts,
    pages: host ? [methodPage(host.serverId)] : [searchPage("host")],
    newDirectoryNameDrafts: {},
    githubLocationDrafts: {},
  };
}

export function applyAvailableAddProjectHosts(
  state: AddProjectFlowState,
  hosts: AddProjectHost[],
  preferredHostId?: string,
  installationHostId?: string,
): AddProjectFlowState {
  const current = currentAddProjectPage(state);
  if (state.pages.length !== 1 || current.kind !== "host") {
    return { ...state, hosts };
  }
  const host = initialHost(hosts, preferredHostId, installationHostId);
  return {
    ...state,
    hosts,
    pages: host ? [methodPage(host.serverId)] : state.pages,
  };
}

export function currentAddProjectPage(state: AddProjectFlowState): AddProjectPage {
  const page = state.pages[state.pages.length - 1];
  if (!page) {
    throw new Error("Add Project flow must always contain a page");
  }
  return page;
}

export function updateCurrentAddProjectPage(
  state: AddProjectFlowState,
  update: (page: AddProjectPage) => AddProjectPage,
): AddProjectFlowState {
  const index = state.pages.length - 1;
  return {
    ...state,
    pages: state.pages.map((page, pageIndex) => (pageIndex === index ? update(page) : page)),
  };
}

export function pushAddProjectPage(
  state: AddProjectFlowState,
  page: AddProjectPage,
): AddProjectFlowState {
  return { ...state, pages: [...state.pages, page] };
}

export function backAddProjectPage(state: AddProjectFlowState): AddProjectFlowState | null {
  if (state.pages.length === 1) {
    return null;
  }
  return { ...state, pages: state.pages.slice(0, -1) };
}

export function chooseAddProjectHost(
  state: AddProjectFlowState,
  hostId: string,
): AddProjectFlowState {
  return pushAddProjectPage(state, methodPage(hostId));
}

export function openDirectorySearchPage(
  state: AddProjectFlowState,
  hostId: string,
): AddProjectFlowState {
  return pushAddProjectPage(state, {
    ...searchPage("directory-search"),
    hostId,
    isSubmitting: false,
  });
}

export function openGithubSearchPage(
  state: AddProjectFlowState,
  hostId: string,
): AddProjectFlowState {
  return pushAddProjectPage(state, { ...searchPage("github-search"), hostId });
}

export function openGithubLocationPage(
  state: AddProjectFlowState,
  hostId: string,
  repository: GithubRepositoryChoice,
): AddProjectFlowState {
  const draft = state.githubLocationDrafts[githubLocationDraftKey(hostId, repository.id)];
  return pushAddProjectPage(state, {
    kind: "github-location",
    query: draft?.query ?? "",
    activeIndex: draft?.activeIndex ?? 0,
    error: null,
    hostId,
    repository,
    isSubmitting: false,
  });
}

export function openFolderBrowserPage(
  state: AddProjectFlowState,
  hostId: string,
  purpose: FolderBrowserPagePurpose,
  request: FolderBrowseRequest = {},
): AddProjectFlowState {
  return pushAddProjectPage(state, {
    ...searchPage("folder-browser"),
    hostId,
    purpose,
    request,
    isSubmitting: false,
  });
}

export function openCloneDestinationPage(
  state: AddProjectFlowState,
  hostId: string,
  repository: GithubRepositoryChoice,
): AddProjectFlowState {
  return pushAddProjectPage(state, {
    kind: "clone-destination",
    hostId,
    repository,
    activeIndex: 0,
    error: null,
    isSubmitting: false,
  });
}

// Projects folder flow: New folder shows an inline name row until the folder is created
// or naming is cancelled. Null leaves naming.
export function setFolderBrowserNaming(
  state: AddProjectFlowState,
  name: string | null,
): AddProjectFlowState {
  return updateCurrentAddProjectPage(state, (page) =>
    page.kind === "folder-browser"
      ? { ...page, newFolderName: name, query: "", activeIndex: 0, error: null }
      : page,
  );
}

// Moving between folders stays on one page; Back leaves the browser.
export function browseAddProjectFolder(
  state: AddProjectFlowState,
  request: FolderBrowseRequest,
): AddProjectFlowState {
  return updateCurrentAddProjectPage(state, (page) =>
    page.kind === "folder-browser"
      ? { ...page, request, query: "", newFolderName: null, activeIndex: 0, error: null }
      : page,
  );
}

export function openNewDirectoryParentPage(
  state: AddProjectFlowState,
  hostId: string,
): AddProjectFlowState {
  return pushAddProjectPage(state, { ...searchPage("new-directory-parent"), hostId });
}

export function openNewDirectoryNamePage(
  state: AddProjectFlowState,
  hostId: string,
  parentPath: string,
): AddProjectFlowState {
  const draftKey = newDirectoryDraftKey(hostId, parentPath);
  return pushAddProjectPage(state, {
    kind: "new-directory-name",
    hostId,
    parentPath,
    name: state.newDirectoryNameDrafts[draftKey] ?? "",
    activeIndex: 0,
    error: null,
    isSubmitting: false,
  });
}

export function setAddProjectPageInput(
  state: AddProjectFlowState,
  value: string,
): AddProjectFlowState {
  const page = currentAddProjectPage(state);
  const updated = updateCurrentAddProjectPage(state, (current) => {
    if (current.kind === "new-directory-name") {
      return { ...current, name: value, activeIndex: 0, error: null };
    }
    if (current.kind === "method" || current.kind === "clone-destination") return current;
    return { ...current, query: value, activeIndex: 0, error: null };
  });
  if (page.kind !== "github-location") return updated;
  const draftKey = githubLocationDraftKey(page.hostId, page.repository.id);
  return {
    ...updated,
    githubLocationDrafts: {
      ...updated.githubLocationDrafts,
      [draftKey]: { query: value, activeIndex: 0 },
    },
  };
}

export function setNewDirectoryName(
  state: AddProjectFlowState,
  value: string,
): AddProjectFlowState {
  const page = currentAddProjectPage(state);
  if (page.kind !== "new-directory-name") return state;
  const draftKey = newDirectoryDraftKey(page.hostId, page.parentPath);
  const updated = setAddProjectPageInput(state, value);
  return {
    ...updated,
    newDirectoryNameDrafts: {
      ...updated.newDirectoryNameDrafts,
      [draftKey]: value,
    },
  };
}

function newDirectoryDraftKey(hostId: string, parentPath: string): string {
  return `${hostId}\u0000${parentPath}`;
}

function githubLocationDraftKey(hostId: string, repositoryId: string): string {
  return `${hostId}\u0000${repositoryId}`;
}

export function setAddProjectActiveIndex(
  state: AddProjectFlowState,
  activeIndex: number,
): AddProjectFlowState {
  const page = currentAddProjectPage(state);
  const updated = updateCurrentAddProjectPage(state, (current) => ({ ...current, activeIndex }));
  if (page.kind !== "github-location") return updated;
  const draftKey = githubLocationDraftKey(page.hostId, page.repository.id);
  return {
    ...updated,
    githubLocationDrafts: {
      ...updated.githubLocationDrafts,
      [draftKey]: { query: page.query, activeIndex },
    },
  };
}

export function moveAddProjectActiveIndex(
  activeIndex: number,
  optionCount: number,
  direction: "next" | "previous",
): number {
  if (optionCount === 0) return 0;
  const delta = direction === "next" ? 1 : -1;
  const next = activeIndex + delta;
  if (next < 0) return optionCount - 1;
  if (next >= optionCount) return 0;
  return next;
}

export function moveAddProjectSelection(
  activeIndex: number,
  selectable: readonly boolean[],
  direction: "next" | "previous",
): number {
  if (!selectable.some(Boolean)) return 0;
  let next = activeIndex;
  for (let count = 0; count < selectable.length; count += 1) {
    next = moveAddProjectActiveIndex(next, selectable.length, direction);
    if (selectable[next]) return next;
  }
  return activeIndex;
}
