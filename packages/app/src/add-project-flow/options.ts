import {
  isCompleteGitRemote,
  parseGitHubRemoteUrl,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import { shortenPath } from "@/utils/shorten-path";
import type { AddProjectHost, GithubRepositoryChoice } from "./model";

export type AddProjectMethodId =
  | "open-folder"
  | "directory-search"
  | "browse"
  | "github"
  | "new-directory";

export interface AddProjectMethodOption {
  id: AddProjectMethodId;
  label: string;
  description: string;
  disabled?: boolean;
}

export interface AddProjectPathOption {
  id: string;
  path: string;
  displayPath: string;
  secondaryText: string | null;
  disabled: boolean;
}

export function filterAddProjectHosts(hosts: AddProjectHost[], query: string): AddProjectHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts;
  return hosts.filter(
    (host) =>
      host.label.toLowerCase().includes(normalized) ||
      host.serverId.toLowerCase().includes(normalized),
  );
}

export function buildAddProjectMethods(host: AddProjectHost): AddProjectMethodOption[] {
  if (!host.canAddProject) return [];
  if (host.projectsRoot !== null) return projectsFolderMethods(host, host.projectsRoot);
  const options: AddProjectMethodOption[] = [];
  // Hosts that can list folders get one browser for every destination. Older
  // hosts keep the search pages, which cannot confirm a parent exists.
  if (host.canBrowseFolders) {
    options.push({
      id: "open-folder",
      label: "Open a folder",
      description: `Browse folders on ${host.label}`,
    });
  } else {
    options.push({
      id: "directory-search",
      label: "Search for directory",
      description: `Find a directory on ${host.label}`,
    });
  }
  if (host.canBrowse) {
    options.push({
      id: "browse",
      label: "Choose in Finder",
      description: "Pick or create a folder with the system dialog",
    });
  }
  options.push({
    id: "new-directory",
    label: "New project folder",
    description: host.canCreateDirectory
      ? `Create an empty folder on ${host.label}`
      : "Update this host to create folders",
    disabled: !host.canCreateDirectory,
  });
  options.push({
    id: "github",
    label: "Clone from GitHub",
    description: githubMethodDescription(host),
    disabled: !host.canCloneGithubRepositories,
  });
  return options;
}

// Every new project lives in the Projects folder, so choosing and cloning are all there is.
function projectsFolderMethods(host: AddProjectHost, root: string): AddProjectMethodOption[] {
  return [
    {
      id: "open-folder",
      label: "Choose a folder",
      description: `Pick or create a folder in ${shortenPath(root)}`,
    },
    {
      id: "github",
      label: "Clone from GitHub",
      description: githubMethodDescription(host),
      disabled: !host.canCloneGithubRepositories,
    },
  ];
}

export function addProjectMethodEmptyText(host: AddProjectHost | null): string {
  return host?.canAddProject === false
    ? "Update the host to use Add Project."
    : "No matching options";
}

function githubMethodDescription(host: AddProjectHost): string {
  if (!host.canCloneGithubRepositories) {
    return "Update this host to clone GitHub repositories";
  }
  if (host.canSearchGithubRepositories) {
    return "Search projects available to your GitHub account";
  }
  return "Enter a GitHub URL or owner/repo";
}

export function pathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function buildManualGithubRepositoryChoices(query: string): GithubRepositoryChoice[] {
  const repo = query.trim();
  if (!repo) return [];

  if (isCompleteGitRemote(repo)) {
    const identity = parseGitHubRemoteUrl(repo);
    const location = parseGitRemoteLocation(repo);
    const remoteName = location ? pathBaseName(location.path).replace(/\.git$/u, "") : repo;
    return [
      {
        id: `manual:${repo}`,
        nameWithOwner: identity?.repo ?? remoteName,
        cloneUrl: repo,
        description: "Clone this repository URL",
        updatedAt: null,
      },
    ];
  }

  const shorthand = repo.match(/^([^\s/]+)\/([^\s/]+)$/u);
  if (!shorthand) return [];
  const nameWithOwner = `${shorthand[1]}/${shorthand[2]}`;
  return (["https", "ssh"] as const).map((cloneProtocol) => ({
    id: `manual:${cloneProtocol}:${nameWithOwner}`,
    nameWithOwner,
    cloneUrl: nameWithOwner,
    cloneProtocol,
    description: `Clone owner/repo via ${cloneProtocol.toUpperCase()}`,
    updatedAt: null,
  }));
}

export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

export function joinDirectoryPath(parent: string, name: string): string {
  const trimmedParent = parent.replace(/[\\/]+$/, "");
  const separator = trimmedParent.includes("\\") && !trimmedParent.includes("/") ? "\\" : "/";
  return `${trimmedParent}${separator}${name}`;
}

export interface ProjectsCloneDestination {
  // The folder the clone is created in: the Projects folder itself.
  parentPath: string;
  // Where the clone lands, as the daemon sees it.
  path: string;
  displayPath: string;
}

// With a Projects folder, a clone lands in <Projects>/<repository> unless the owner
// changes the location.
export function projectsCloneDestination(
  projectsRoot: string,
  repository: Pick<GithubRepositoryChoice, "nameWithOwner">,
): ProjectsCloneDestination {
  const path = joinDirectoryPath(projectsRoot, pathBaseName(repository.nameWithOwner));
  return { parentPath: projectsRoot, path, displayPath: shortenPath(path) };
}

export function buildSuggestedParentDirectories(projectPaths: string[]): string[] {
  const values = [
    ...projectPaths.flatMap((path) => {
      const parent = parentDirectory(path);
      return parent ? [parent] : [];
    }),
    "~/dev",
    "~/Developer",
    "~/src",
    "~/projects",
    "~/workspace",
    "~",
  ];
  return [...new Set(values)];
}

export function buildCloneLocationOptions(input: {
  parents: string[];
  repositoryName: string;
  existingPaths: string[];
}): AddProjectPathOption[] {
  const existing = new Set(input.existingPaths.map(pathIdentity));
  const seen = new Set<string>();
  return input.parents.flatMap((parent) => {
    const path = joinDirectoryPath(parent, input.repositoryName);
    const identity = pathIdentity(path);
    if (seen.has(identity)) return [];
    seen.add(identity);
    const pathExists = existing.has(identity);
    return [
      {
        id: parent,
        path: parent,
        displayPath: path,
        secondaryText: pathExists ? "Already exists" : `Parent directory: ${parent}`,
        disabled: pathExists,
      },
    ];
  });
}

function pathIdentity(path: string): string {
  const normalized = shortenPath(path.trim()).replace(/\\/g, "/").replace(/\/+$/u, "");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
