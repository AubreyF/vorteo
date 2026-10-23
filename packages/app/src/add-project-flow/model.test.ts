import { describe, expect, it } from "vitest";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  browseAddProjectFolder,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectActiveIndex,
  moveAddProjectSelection,
  openAddProjectFlow,
  openCloneDestinationPage,
  openDirectorySearchPage,
  openFolderBrowserPage,
  openGithubLocationPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setFolderBrowserNaming,
  setNewDirectoryName,
  selectProjectsFolderHost,
  type AddProjectHost,
} from "./model";
import {
  addProjectMethodEmptyText,
  buildAddProjectMethods,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  projectsCloneDestination,
} from "./options";

const HOST: AddProjectHost = {
  serverId: "host-1",
  label: "Local",
  canAddProject: true,
  canBrowse: true,
  canBrowseFolders: false,
  canCloneGithubRepositories: true,
  canSearchGithubRepositories: true,
  canCreateDirectory: true,
  projectsRoot: null,
};

const PROJECTS_HOST: AddProjectHost = {
  ...HOST,
  serverId: "installation-host",
  label: "Host",
  canBrowseFolders: true,
  projectsRoot: "/Users/owner/Projects",
};
const PROJECTS_DEV: AddProjectHost = {
  ...PROJECTS_HOST,
  serverId: "installation-dev",
  label: "Dev",
};
const REPOSITORY = {
  id: "repo-1",
  nameWithOwner: "getpaseo/paseo",
  cloneUrl: "git@github.com:getpaseo/paseo.git",
  description: null,
  updatedAt: null,
};

describe("Add Project navigation", () => {
  it("skips a single connected host without adding it to history", () => {
    const state = openAddProjectFlow({ hosts: [HOST] });

    expect(currentAddProjectPage(state)).toEqual({
      kind: "method",
      hostId: "host-1",
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
    expect(backAddProjectPage(state)).toBeNull();
  });

  it("restores page input and selection after Back", () => {
    const secondHost = { ...HOST, serverId: "host-2", label: "Remote" };
    let state = openAddProjectFlow({ hosts: [HOST, secondHost] });
    state = setAddProjectPageInput(state, "rem");
    state = setAddProjectActiveIndex(state, 1);
    state = chooseAddProjectHost(state, secondHost.serverId);
    state = openDirectorySearchPage(state, secondHost.serverId);

    state = backAddProjectPage(state) ?? state;
    state = backAddProjectPage(state) ?? state;

    expect(currentAddProjectPage(state)).toEqual({
      kind: "host",
      query: "rem",
      activeIndex: 1,
      error: null,
    });
  });

  it("wraps keyboard selection in both directions", () => {
    expect(moveAddProjectActiveIndex(2, 3, "next")).toBe(0);
    expect(moveAddProjectActiveIndex(0, 3, "previous")).toBe(2);
    expect(moveAddProjectSelection(0, [true, false, true], "next")).toBe(2);
  });

  it("restores a directory name after returning to and reselecting its parent", () => {
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openNewDirectoryParentPage(state, HOST.serverId);
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");
    state = setNewDirectoryName(state, "command-center");
    state = backAddProjectPage(state) ?? state;
    state = openNewDirectoryNamePage(state, HOST.serverId, "~/dev");

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "new-directory-name",
      parentPath: "~/dev",
      name: "command-center",
    });
  });

  it("restores the GitHub destination query and active parent when reopening a repository", () => {
    const repository = {
      id: "repo-1",
      nameWithOwner: "getpaseo/paseo",
      cloneUrl: "git@github.com:getpaseo/paseo.git",
      description: null,
      visibility: "public",
      updatedAt: null,
    };
    let state = openAddProjectFlow({ hosts: [HOST] });
    state = openGithubLocationPage(state, HOST.serverId, repository);
    state = setAddProjectPageInput(state, "~/dev");
    state = setAddProjectActiveIndex(state, 2);
    state = backAddProjectPage(state) ?? state;
    state = openGithubLocationPage(state, HOST.serverId, repository);

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "github-location",
      query: "~/dev",
      activeIndex: 2,
    });
  });
});

describe("Add Project options", () => {
  it("hides every mutating method when the host lacks stable project identity", () => {
    const outdatedHost = { ...HOST, canAddProject: false };

    expect(buildAddProjectMethods(outdatedHost)).toEqual([]);
    expect(addProjectMethodEmptyText(outdatedHost)).toBe("Update the host to use Add Project.");
  });

  it("keeps host-upgrade methods discoverable while hiding local-only Browse", () => {
    expect(
      buildAddProjectMethods({
        ...HOST,
        canBrowse: false,
        canCloneGithubRepositories: false,
        canSearchGithubRepositories: false,
        canCreateDirectory: false,
      }),
    ).toEqual([
      {
        id: "directory-search",
        label: "Search for directory",
        description: "Find a directory on Local",
      },
      {
        id: "new-directory",
        label: "New project folder",
        description: "Update this host to create folders",
        disabled: true,
      },
      {
        id: "github",
        label: "Clone from GitHub",
        description: "Update this host to clone GitHub repositories",
        disabled: true,
      },
    ]);
  });

  it("replaces directory search with the folder browser on hosts that can list folders", () => {
    expect(
      buildAddProjectMethods({ ...HOST, canBrowse: false, canBrowseFolders: true }).map(
        (method) => method.id,
      ),
    ).toEqual(["open-folder", "new-directory", "github"]);
  });

  it("offers manual URL and protocol-specific owner/repo clone choices", () => {
    expect(buildManualGithubRepositoryChoices("git@github.com:getpaseo/paseo.git")).toEqual([
      expect.objectContaining({
        id: "manual:git@github.com:getpaseo/paseo.git",
        nameWithOwner: "getpaseo/paseo",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      }),
    ]);
    expect(buildManualGithubRepositoryChoices("getpaseo/paseo")).toEqual([
      expect.objectContaining({ cloneProtocol: "https", cloneUrl: "getpaseo/paseo" }),
      expect.objectContaining({ cloneProtocol: "ssh", cloneUrl: "getpaseo/paseo" }),
    ]);
    expect(buildManualGithubRepositoryChoices("paseo")).toEqual([]);
  });

  it("shows final clone paths while retaining parent paths as values", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["~/dev", "~/workspace"],
        repositoryName: "paseo",
        existingPaths: ["~/workspace/paseo"],
      }),
    ).toEqual([
      {
        id: "~/dev",
        path: "~/dev",
        displayPath: "~/dev/paseo",
        secondaryText: "Parent directory: ~/dev",
        disabled: false,
      },
      {
        id: "~/workspace",
        path: "~/workspace",
        displayPath: "~/workspace/paseo",
        secondaryText: "Already exists",
        disabled: true,
      },
    ]);
  });

  it("shows equivalent absolute-home and tilde destinations only once", () => {
    expect(
      buildCloneLocationOptions({
        parents: ["/Users/moboudra/dev", "~/dev"],
        repositoryName: "dotfiles",
        existingPaths: [],
      }),
    ).toEqual([
      {
        id: "/Users/moboudra/dev",
        path: "/Users/moboudra/dev",
        displayPath: "/Users/moboudra/dev/dotfiles",
        secondaryText: "Parent directory: /Users/moboudra/dev",
        disabled: false,
      },
    ]);
  });
});

describe("Projects folder flow", () => {
  it("skips the host step and prefers the installation's Host daemon", () => {
    const state = openAddProjectFlow({
      hosts: [PROJECTS_DEV, PROJECTS_HOST, HOST],
      installationHostId: PROJECTS_HOST.serverId,
    });

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "method",
      hostId: PROJECTS_HOST.serverId,
    });
    expect(backAddProjectPage(state)).toBeNull();
  });

  it("falls back to the first online host with a Projects folder", () => {
    expect(
      selectProjectsFolderHost([HOST, PROJECTS_DEV, PROJECTS_HOST], "offline-host")?.serverId,
    ).toBe(PROJECTS_DEV.serverId);
    expect(selectProjectsFolderHost([HOST], PROJECTS_HOST.serverId)).toBeNull();
  });

  it("keeps host selection for hosts without a Projects folder", () => {
    const secondHost = { ...HOST, serverId: "host-2" };
    const state = openAddProjectFlow({ hosts: [HOST, secondHost] });

    expect(currentAddProjectPage(state).kind).toBe("host");
  });

  it("leaves host selection once a Projects folder host connects", () => {
    const secondHost = { ...HOST, serverId: "host-2" };
    let state = openAddProjectFlow({ hosts: [HOST, secondHost] });
    state = applyAvailableAddProjectHosts(
      state,
      [HOST, secondHost, PROJECTS_HOST],
      undefined,
      PROJECTS_HOST.serverId,
    );

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "method",
      hostId: PROJECTS_HOST.serverId,
    });
  });

  it("offers only choosing a folder and cloning", () => {
    expect(buildAddProjectMethods(PROJECTS_HOST)).toEqual([
      {
        id: "open-folder",
        label: "Choose a folder",
        description: "Pick or create a folder in ~/Projects",
      },
      {
        id: "github",
        label: "Clone from GitHub",
        description: expect.any(String),
        disabled: false,
      },
    ]);
  });

  it("names a new folder inline, then enters the created folder", () => {
    let state = openAddProjectFlow({ hosts: [PROJECTS_HOST] });
    state = openFolderBrowserPage(state, PROJECTS_HOST.serverId, { kind: "open" }, { path: "." });
    state = setAddProjectPageInput(state, "ap");
    state = setFolderBrowserNaming(state, "");

    expect(currentAddProjectPage(state)).toMatchObject({ newFolderName: "", query: "" });

    state = setFolderBrowserNaming(state, "app");
    // Typing in the filter never edits the name.
    state = setAddProjectPageInput(state, "x");
    expect(currentAddProjectPage(state)).toMatchObject({ newFolderName: "app", query: "x" });

    state = browseAddProjectFolder(state, { rootId: "projects", path: "app" });
    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "folder-browser",
      request: { rootId: "projects", path: "app" },
      newFolderName: null,
      query: "",
    });
  });

  it("confirms the default clone destination before offering another location", () => {
    let state = openAddProjectFlow({ hosts: [PROJECTS_HOST] });
    state = openCloneDestinationPage(state, PROJECTS_HOST.serverId, REPOSITORY);
    // The confirmation page has no text input.
    state = setAddProjectPageInput(state, "ignored");

    expect(currentAddProjectPage(state)).toEqual({
      kind: "clone-destination",
      hostId: PROJECTS_HOST.serverId,
      repository: REPOSITORY,
      activeIndex: 0,
      error: null,
      isSubmitting: false,
    });
  });

  it("clones into <Projects>/<repository> by default", () => {
    expect(projectsCloneDestination("/Users/owner/Projects", REPOSITORY)).toEqual({
      parentPath: "/Users/owner/Projects",
      path: "/Users/owner/Projects/paseo",
      displayPath: "~/Projects/paseo",
    });
    expect(
      projectsCloneDestination("/Users/owner/Projects/", { nameWithOwner: "acme/tools" }).path,
    ).toBe("/Users/owner/Projects/tools");
  });

  it("changes the clone location in the folder browser and returns to the default", () => {
    let state = openAddProjectFlow({ hosts: [PROJECTS_HOST] });
    state = openCloneDestinationPage(state, PROJECTS_HOST.serverId, REPOSITORY);
    state = openFolderBrowserPage(
      state,
      PROJECTS_HOST.serverId,
      { kind: "clone", repository: REPOSITORY },
      { path: "." },
    );

    expect(currentAddProjectPage(state)).toMatchObject({
      kind: "folder-browser",
      hostId: PROJECTS_HOST.serverId,
      purpose: { kind: "clone", repository: REPOSITORY },
      request: { path: "." },
    });
    const back = backAddProjectPage(state);
    expect(back && currentAddProjectPage(back).kind).toBe("clone-destination");
  });

  it("keeps the earlier methods on hosts without a Projects folder", () => {
    expect(buildAddProjectMethods(HOST).map((method) => method.label)).toEqual([
      "Search for directory",
      "Choose in Finder",
      "New project folder",
      "Clone from GitHub",
    ]);
    expect(
      buildAddProjectMethods({ ...HOST, canBrowseFolders: true }).map((method) => method.label),
    ).toEqual(["Open a folder", "Choose in Finder", "New project folder", "Clone from GitHub"]);
  });
});
