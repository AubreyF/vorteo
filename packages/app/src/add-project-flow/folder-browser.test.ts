import { describe, expect, it } from "vitest";
import type { ProjectDirectoryBrowsePayload } from "@getpaseo/protocol/messages";
import {
  buildFolderBrowserRows,
  childFolderRequest,
  containerPathToRequest,
  createFolderErrorText,
  folderBrowserSearchQuery,
  folderLocationLabel,
  newFolderPreview,
  projectsFolderBreadcrumb,
  projectsFolderFooter,
  projectsFolderRows,
  projectsFolderStartRequest,
  typedPathToRequest,
  validateFolderName,
  type FolderBrowseDirectory,
  type FolderBrowseRoot,
} from "./folder-browser";

const roots: FolderBrowseRoot[] = [
  { id: "home", label: "Container home", containerPath: "/home/paseo", hostPath: null },
  { id: "dev", label: "dev", containerPath: "/mnt/host/dev", hostPath: "/Users/owner/dev" },
  { id: "workspace", label: "Container workspace", containerPath: "/workspace", hostPath: null },
];

function directory(overrides: Partial<FolderBrowseDirectory> = {}): FolderBrowseDirectory {
  return {
    rootId: "dev",
    path: ".",
    parent: null,
    containerPath: "/mnt/host/dev",
    hostPath: "/Users/owner/dev",
    entries: [
      { name: "aubos", path: "aubos" },
      { name: "paseo", path: "paseo" },
      { name: "paseo-site", path: "paseo-site" },
    ],
    nextOffset: null,
    ...overrides,
  };
}

function payload(dir: FolderBrowseDirectory | null): ProjectDirectoryBrowsePayload {
  return { roots, directory: dir, error: null, errorCode: null, requestId: "r" };
}

describe("folder browser rows", () => {
  it("lists shared host folders before container storage and never shows the container home as ~", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "create" },
      payload: payload(null),
      request: {},
      filter: "",
      recentProjectPaths: [],
    });
    expect(rows.map((row) => row.title)).toEqual([
      "~/dev",
      "Container home",
      "Container workspace",
    ]);
  });

  it("suggests parents of recent projects as starting locations", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "create" },
      payload: payload(null),
      request: {},
      filter: "",
      recentProjectPaths: ["/mnt/host/dev/paseo", "/mnt/host/dev/aubos", "/home/paseo/scratch/x"],
    });
    expect(rows.slice(0, 2)).toMatchObject([
      {
        kind: "location",
        title: "~/dev",
        subtitle: "Recent",
        target: { rootId: "dev", path: "." },
      },
      {
        kind: "location",
        title: "Container home/scratch",
        target: { rootId: "home", path: "scratch" },
      },
    ]);
  });

  it("offers to create a typed folder name only when no folder has that name", () => {
    const base = {
      purpose: { kind: "create" } as const,
      payload: payload(directory()),
      request: { rootId: "dev" },
      recentProjectPaths: [],
    };
    const created = buildFolderBrowserRows({ ...base, filter: "gari-parti" });
    expect(created).toEqual([
      {
        kind: "create",
        id: "create:gari-parti",
        title: "Create folder “gari-parti”",
        subtitle: "~/dev/gari-parti",
        name: "gari-parti",
      },
    ]);
    const existing = buildFolderBrowserRows({ ...base, filter: "Paseo" });
    expect(existing.map((row) => row.kind)).toEqual(["folder", "folder"]);
    expect(existing[0]?.title).toBe("paseo");
  });

  it("keeps matching folders ahead of the create row so Enter enters the obvious folder", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "create" },
      payload: payload(directory()),
      request: { rootId: "dev" },
      filter: "pas",
      recentProjectPaths: [],
    });
    expect(rows.map((row) => row.kind)).toEqual(["folder", "folder", "create"]);
  });

  it("puts open and clone actions first and blocks cloning over an existing folder", () => {
    const open = buildFolderBrowserRows({
      purpose: { kind: "open" },
      payload: payload(directory()),
      request: { rootId: "dev" },
      filter: "",
      recentProjectPaths: [],
    });
    expect(open[0]).toMatchObject({ kind: "use-current", title: "Open this folder" });
    const clone = buildFolderBrowserRows({
      purpose: { kind: "clone", repositoryName: "paseo" },
      payload: payload(directory()),
      request: { rootId: "dev" },
      filter: "",
      recentProjectPaths: [],
    });
    expect(clone[0]).toMatchObject({
      kind: "use-current",
      disabled: true,
      subtitle: "~/dev/paseo",
    });
  });

  it("turns a typed path into a go-to row first", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "create" },
      payload: payload(directory()),
      request: { rootId: "dev" },
      filter: "/Users/owner/dev/paseo",
      recentProjectPaths: [],
    });
    expect(rows.slice(0, 1)).toEqual([
      {
        kind: "go-to",
        id: "go-to:/Users/owner/dev/paseo",
        title: "Go to /Users/owner/dev/paseo",
        target: { rootId: "dev", path: "paseo" },
      },
    ]);
  });

  it("opens a pasted path directly when opening, and only browses to it otherwise", () => {
    const base = {
      payload: payload(null),
      request: {},
      filter: "/Users/owner/dev/paseo",
      recentProjectPaths: [],
    };
    expect(
      buildFolderBrowserRows({ ...base, purpose: { kind: "open" } }).map((row) => row.kind),
    ).toEqual(["open-path", "go-to"]);
    expect(buildFolderBrowserRows({ ...base, purpose: { kind: "create" } }).slice(1)).toEqual([
      {
        kind: "create-at-path",
        id: "create-at-path:/Users/owner/dev/paseo",
        title: "Create folder “paseo”",
        subtitle: "In /Users/owner/dev",
        parentPath: "/mnt/host/dev",
        name: "paseo",
      },
    ]);
    expect(
      buildFolderBrowserRows({
        ...base,
        filter: "/tmp/",
        purpose: { kind: "clone", repositoryName: "repo" },
      }).map((row) => [row.kind, "subtitle" in row ? row.subtitle : null]),
    ).toEqual([
      ["go-to", null],
      ["clone-at-path", "/tmp/repo"],
    ]);
  });

  it("maps typed host paths to daemon paths and browses container ~ paths instead", () => {
    const open = (filter: string) =>
      buildFolderBrowserRows({
        purpose: { kind: "open" },
        payload: payload(null),
        request: {},
        filter,
        recentProjectPaths: [],
      });
    expect(open("/Users/owner/dev/paseo")[0]).toMatchObject({
      kind: "open-path",
      path: "/mnt/host/dev/paseo",
    });
    expect(open("~/dev").map((row) => row.kind)).toEqual(["go-to"]);
  });

  it("labels top-level search matches by location instead of container paths", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "create" },
      payload: payload(null),
      request: {},
      filter: "proj",
      recentProjectPaths: [],
      searchResults: ["/home/paseo/projects", "/elsewhere/projects"],
    });
    expect(rows).toEqual([
      {
        kind: "search-result",
        id: "search:/home/paseo/projects",
        title: "Container home/projects",
        target: { rootId: "home", path: "projects" },
      },
    ]);
    expect(folderBrowserSearchQuery({ rootId: "dev" }, "proj")).toBe("");
    expect(folderBrowserSearchQuery({}, "~/dev")).toBe("");
    expect(folderBrowserSearchQuery({}, " proj ")).toBe("proj");
  });

  it("pages large folders", () => {
    const rows = buildFolderBrowserRows({
      purpose: { kind: "open" },
      payload: payload(directory({ nextOffset: 200 })),
      request: { rootId: "dev", path: ".", offset: 100 },
      filter: "",
      recentProjectPaths: [],
    });
    expect(rows.filter((row) => row.kind === "page").map((row) => row.title)).toEqual([
      "Previous folders",
      "More folders",
    ]);
  });
});

describe("folder browser locations", () => {
  it("labels container locations by name and shared folders by host path", () => {
    expect(
      folderLocationLabel(roots, directory({ rootId: "home", path: "projects", hostPath: null })),
    ).toEqual({ title: "Container home/projects", detail: null });
    expect(
      folderLocationLabel(roots, directory({ path: "paseo", hostPath: "/Users/owner/dev/paseo" })),
    ).toEqual({ title: "~/dev/paseo", detail: "Shared folder" });
  });

  it("resolves typed host paths, then container paths, and leaves ~ to the daemon", () => {
    expect(typedPathToRequest("~/dev", roots)).toEqual({ hostPath: "~/dev" });
    expect(typedPathToRequest("/Users/owner/dev/a/", roots)).toEqual({ rootId: "dev", path: "a" });
    expect(typedPathToRequest("/home/paseo/x/y", roots)).toEqual({ rootId: "home", path: "x/y" });
    expect(typedPathToRequest("/Users/owner/Downloads", roots)).toEqual({
      hostPath: "/Users/owner/Downloads",
    });
  });

  it("prefers the most specific root for container paths", () => {
    const nested: FolderBrowseRoot[] = [
      { id: "root", label: "/", containerPath: "/", hostPath: "/host" },
      { id: "home", label: "Container home", containerPath: "/home/paseo", hostPath: null },
    ];
    expect(containerPathToRequest("/home/paseo/a", nested)).toEqual({ rootId: "home", path: "a" });
    expect(containerPathToRequest("/tmp", nested)).toEqual({ rootId: "root", path: "tmp" });
  });
});

describe("folder names and errors", () => {
  it("rejects names that would escape the selected folder", () => {
    expect(validateFolderName("ok-name")).toBeNull();
    expect(validateFolderName(" ")).toBe("Enter a folder name");
    expect(validateFolderName("..")).toBe("Choose a different folder name");
    expect(validateFolderName("a/b")).toBe("Folder names cannot contain slashes");
  });

  it("hides container paths in create failures", () => {
    expect(
      createFolderErrorText({
        errorCode: "directory_exists",
        error: "Directory already exists: /home/paseo/x",
        name: "x",
      }),
    ).toBe("A folder named “x” already exists here");
  });
});

describe("Projects folder browser", () => {
  const projectsRoot = "/Users/owner/Projects";

  function projectsDirectory(
    overrides: Partial<FolderBrowseDirectory> = {},
  ): FolderBrowseDirectory {
    return {
      rootId: "projects",
      path: ".",
      parent: null,
      containerPath: projectsRoot,
      hostPath: projectsRoot,
      entries: [
        { name: "notes", path: "notes" },
        { name: "paseo", path: "paseo", git: true, projectId: "project-paseo" },
        { name: "site", path: "site", git: true },
      ],
      nextOffset: null,
      ...overrides,
    };
  }
  const nested = projectsDirectory({
    path: "clients/acme",
    parent: "clients",
    containerPath: `${projectsRoot}/clients/acme`,
    hostPath: `${projectsRoot}/clients/acme`,
    entries: [],
  });

  it("enters folders, opens existing projects and offers one-click add for checkouts", () => {
    const rows = projectsFolderRows({
      purpose: { kind: "open" },
      directory: projectsDirectory(),
      filter: "",
    });
    expect(
      rows.map((row) => ({
        title: row.title,
        action: row.action,
        canAdd: row.canAdd,
        path: row.path,
      })),
    ).toEqual([
      { title: "notes", action: "enter", canAdd: false, path: `${projectsRoot}/notes` },
      { title: "paseo", action: "open-project", canAdd: false, path: `${projectsRoot}/paseo` },
      { title: "site", action: "enter", canAdd: true, path: `${projectsRoot}/site` },
    ]);
  });

  it("only navigates while choosing where to clone", () => {
    const rows = projectsFolderRows({
      purpose: { kind: "clone", repositoryName: "paseo" },
      directory: projectsDirectory(),
      filter: "",
    });
    expect(rows.every((row) => row.action === "enter" && !row.canAdd)).toBe(true);
  });

  it("filters children with the closest match first", () => {
    const rows = projectsFolderRows({
      purpose: { kind: "open" },
      directory: projectsDirectory({
        entries: [
          { name: "my-site", path: "my-site" },
          { name: "site", path: "site" },
        ],
      }),
      filter: "site",
    });
    expect(rows.map((row) => row.title)).toEqual(["site", "my-site"]);
  });

  it("breadcrumbs start at Projects and return to each ancestor", () => {
    expect(projectsFolderBreadcrumb(nested)).toEqual([
      { label: "Projects", target: { rootId: "projects", path: "." } },
      { label: "clients", target: { rootId: "projects", path: "clients" } },
      { label: "acme", target: { rootId: "projects", path: "clients/acme" } },
    ]);
  });

  it("cannot add the Projects folder itself", () => {
    expect(
      projectsFolderFooter({
        purpose: { kind: "open" },
        directory: projectsDirectory(),
        projectPaths: [],
      }),
    ).toEqual({
      action: "add",
      label: "Add “Projects” as project",
      detail: "~/Projects",
      disabled: true,
      reason: "Open or create a folder inside Projects to add it",
      canCreateFolder: true,
    });
  });

  it("names the current folder as the add target, or opens it when it is a project", () => {
    expect(
      projectsFolderFooter({ purpose: { kind: "open" }, directory: nested, projectPaths: [] }),
    ).toMatchObject({ action: "add", label: "Add “acme” as project", disabled: false });
    expect(
      projectsFolderFooter({
        purpose: { kind: "open" },
        directory: nested,
        projectPaths: [`${projectsRoot}/clients/acme/`],
      }),
    ).toMatchObject({ action: "open", label: "Open “acme”", disabled: false });
  });

  it("clones into any folder, including Projects itself, unless the name is taken", () => {
    expect(
      projectsFolderFooter({
        purpose: { kind: "clone", repositoryName: "tools" },
        directory: projectsDirectory(),
        projectPaths: [],
      }),
    ).toMatchObject({
      action: "clone",
      label: "Clone here",
      detail: "~/Projects/tools",
      disabled: false,
    });
    expect(
      projectsFolderFooter({
        purpose: { kind: "clone", repositoryName: "Paseo" },
        directory: projectsDirectory(),
        projectPaths: [],
      }),
    ).toMatchObject({ disabled: true, reason: "“Paseo” already exists here" });
  });

  it("clones into a nested folder or one just created there", () => {
    const clone = { kind: "clone", repositoryName: "tools" } as const;
    expect(
      projectsFolderFooter({ purpose: clone, directory: nested, projectPaths: [] }),
    ).toMatchObject({
      action: "clone",
      label: "Clone here",
      detail: "~/Projects/clients/acme/tools",
      disabled: false,
      canCreateFolder: true,
    });
    const created = projectsDirectory({
      path: "clients/acme/vendor",
      parent: "clients/acme",
      containerPath: `${projectsRoot}/clients/acme/vendor`,
      hostPath: `${projectsRoot}/clients/acme/vendor`,
      entries: [],
    });
    expect(
      projectsFolderFooter({ purpose: clone, directory: created, projectPaths: [] }),
    ).toMatchObject({ label: "Clone here", detail: "~/Projects/clients/acme/vendor/tools" });
  });

  it("enters a new folder after creating it at any depth, then targets it for adding", () => {
    expect(newFolderPreview(projectsDirectory(), " app ")).toBe("~/Projects/app");
    expect(childFolderRequest(projectsDirectory(), "app")).toEqual({
      rootId: "projects",
      path: "app",
    });
    const request = childFolderRequest(nested, "app", true);
    expect(request).toEqual({ rootId: "projects", path: "clients/acme/app", showHidden: true });

    const created = projectsDirectory({
      path: "clients/acme/app",
      parent: "clients/acme",
      containerPath: `${projectsRoot}/clients/acme/app`,
      hostPath: `${projectsRoot}/clients/acme/app`,
      entries: [],
    });
    expect(
      projectsFolderFooter({ purpose: { kind: "open" }, directory: created, projectPaths: [] }),
    ).toMatchObject({ action: "add", label: "Add “app” as project", disabled: false });
  });

  it("reopens the last folder used, or Projects itself", () => {
    expect(projectsFolderStartRequest("clients/acme")).toEqual({ path: "clients/acme" });
    expect(projectsFolderStartRequest(undefined)).toEqual({ path: "." });
    expect(projectsFolderStartRequest("  ")).toEqual({ path: "." });
  });
});
