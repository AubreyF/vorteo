import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { router } from "expo-router";
import type {
  ProjectDirectoryBrowsePayload,
  WorkspaceProjectDescriptorPayload,
} from "@getpaseo/protocol/messages";
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  CornerDownRight,
  Eye,
  EyeOff,
  Folder,
  FolderCheck,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Plus,
  Search,
  Server,
} from "lucide-react-native";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  applyAvailableAddProjectHosts,
  backAddProjectPage,
  browseAddProjectFolder,
  chooseAddProjectHost,
  currentAddProjectPage,
  moveAddProjectSelection,
  openAddProjectFlow,
  openDirectorySearchPage,
  openFolderBrowserPage,
  openGithubLocationPage,
  openGithubSearchPage,
  openNewDirectoryNamePage,
  openNewDirectoryParentPage,
  setAddProjectActiveIndex,
  setAddProjectPageInput,
  setNewDirectoryName,
  updateCurrentAddProjectPage,
  type AddProjectFlowState,
  type AddProjectHost,
  type AddProjectPage,
  type FolderBrowserPagePurpose,
  type GithubRepositoryChoice,
} from "@/add-project-flow/model";
import {
  buildFolderBrowserRows,
  createFolderErrorText,
  folderBrowserEmptyText,
  folderBrowserPlaceholder,
  folderBrowserSearchQuery,
  folderLocationLabel,
  isTopLevelRequest,
  parentRequest,
  validateFolderName,
  type FolderBrowseRequest,
  type FolderBrowserPurpose,
  type FolderBrowserRow,
} from "@/add-project-flow/folder-browser";
import {
  buildAddProjectMethods,
  addProjectMethodEmptyText,
  buildCloneLocationOptions,
  buildManualGithubRepositoryChoices,
  buildSuggestedParentDirectories,
  filterAddProjectHosts,
  joinDirectoryPath,
  pathBaseName,
  type AddProjectMethodId,
} from "@/add-project-flow/options";
import {
  buildProjectPickerOptions,
  type ProjectPickerOption,
} from "@/components/project-picker-options";
import { Shortcut } from "@/components/ui/shortcut";
import { useKeyboardShortcutsAvailable } from "@/keyboard/availability";
import { getIsElectronRuntime } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { pickDirectory } from "@/desktop/pick-directory";
import { useFetchQuery } from "@/data/query";
import { getOpenProjectFailureReason, registerProjectDescriptor } from "@/hooks/open-project";
import { useIsLocalDaemon, useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useCloneGithubProject, useOpenProject } from "@/hooks/use-open-project";
import {
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import {
  useHosts,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import type { AddProjectFlowRequest } from "@/stores/add-project-flow-store";
import type { Theme } from "@/styles/theme";
import { shortenPath } from "@/utils/shorten-path";
import { buildNewWorkspaceRoute, buildSettingsAddHostRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";

interface AddProjectFlowProps {
  request: AddProjectFlowRequest;
  onClose: () => void;
}

interface FlowRowOption {
  id: string;
  title: string;
  subtitle: string | null;
  icon: ComponentType<{ size?: number; color?: string }>;
  disabled?: boolean;
  testID: string;
  select: () => void;
}

interface FlowIconProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  size?: number;
  color?: string;
}

function FlowIcon({ icon: Icon, size, color }: FlowIconProps) {
  return <Icon size={size} color={color} />;
}

const MutedFlowIcon = withUnistyles(FlowIcon, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const lastCloneParentByHost = new Map<string, string>();
// The folder browser reopens where the owner last opened, created or cloned.
const lastFolderRequestByHost = new Map<string, FolderBrowseRequest>();
const EMPTY_PATHS: string[] = [];
const NAVIGATION_HINT_KEYS = ["Up", "Down"];
const SELECT_HINT_KEYS = ["Enter"];
const ESCAPE_HINT_KEYS = ["Esc"];
const OPEN_FOLDER_HINT_KEYS = ["Right"];
const UP_FOLDER_HINT_KEYS = ["Backspace"];

function FlowBackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      style={styles.backButton}
      accessibilityRole="button"
      accessibilityLabel="Back"
      testID="add-project-flow-back"
    >
      {({ hovered, pressed }) => (
        <ThemedArrowLeft
          size={18}
          uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
        />
      )}
    </Pressable>
  );
}

interface LocationButtonProps {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}

function LocationButton({ icon, label, disabled, onPress, testID }: LocationButtonProps) {
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  const buttonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.locationButton,
      (hovered || pressed) && !disabled && styles.rowActive,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={buttonStyle}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      testID={testID}
    >
      <MutedFlowIcon icon={icon} size={16} />
    </Pressable>
  );
}

function methodIcon(method: AddProjectMethodId): FlowRowOption["icon"] {
  if (method === "github") return GitHubIcon;
  if (method === "browse" || method === "open-folder") return FolderOpen;
  if (method === "new-directory") return FolderPlus;
  return Search;
}

function directoryOptionSubtitle(option: ProjectPickerOption, shortPath: string): string | null {
  if (option.kind === "path") return "Open this path";
  if (shortPath === option.path) return null;
  return option.path;
}

function progressText(page: AddProjectPage): string {
  if (page.kind === "github-location") return "Cloning project...";
  if (page.kind === "new-directory-name") return "Creating directory...";
  if (page.kind === "folder-browser" && page.purpose.kind === "clone") return "Cloning project...";
  if (page.kind === "folder-browser" && page.purpose.kind === "create") return "Creating folder...";
  return "Adding project...";
}

function folderBrowserPurpose(purpose: FolderBrowserPagePurpose): FolderBrowserPurpose {
  return purpose.kind === "clone"
    ? { kind: "clone", repositoryName: pathBaseName(purpose.repository.nameWithOwner) }
    : purpose;
}

function folderRowIcon(row: FolderBrowserRow, purpose: FolderBrowserPagePurpose) {
  switch (row.kind) {
    case "location":
      return row.id.startsWith("root:") ? HardDrive : Folder;
    case "folder":
      return Folder;
    case "use-current":
      return purpose.kind === "clone" ? GitHubIcon : FolderCheck;
    case "create":
      return FolderPlus;
    case "go-to":
      return CornerDownRight;
    case "page":
      return ChevronRight;
    case "open-path":
      return purpose.kind === "open" ? FolderCheck : Folder;
    case "create-at-path":
      return FolderPlus;
    case "clone-at-path":
      return GitHubIcon;
    case "search-result":
      return Folder;
  }
}

function folderRowTestId(row: FolderBrowserRow): string {
  switch (row.kind) {
    case "use-current":
      return "add-project-flow-use-folder";
    case "create":
      return "add-project-flow-create-folder";
    case "go-to":
      return "add-project-flow-go-to";
    case "page":
      return `add-project-flow-${row.id.replace(":", "-")}`;
    case "folder":
      return `add-project-flow-folder-${encodeURIComponent(row.title)}`;
    case "location":
      return `add-project-flow-location-${encodeURIComponent(row.id)}`;
    case "open-path":
      return pathTestId(row.path);
    case "create-at-path":
      return "add-project-flow-create-at-path";
    case "clone-at-path":
      return "add-project-flow-clone-at-path";
    case "search-result":
      return `add-project-flow-search-${encodeURIComponent(row.id)}`;
  }
}

// Right Arrow only moves into a location; it never opens, creates or clones.
function folderRowEntersFolder(rowId: string): boolean {
  return /^(root|recent|folder|search):/u.test(rowId);
}

// The current folder's own name leads; its full path follows on a muted line,
// where truncation cannot hide where the owner is.
function locationName(title: string): string {
  const trimmed = title.replace(/[\\/]+$/u, "") || title;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 || index === trimmed.length - 1 ? trimmed : trimmed.slice(index + 1);
}

function folderRowSubtitle(row: FolderBrowserRow): string | null {
  if (
    row.kind === "location" ||
    row.kind === "use-current" ||
    row.kind === "create" ||
    row.kind === "create-at-path" ||
    row.kind === "clone-at-path"
  ) {
    return row.subtitle;
  }
  return null;
}

function emptyText(page: AddProjectPage, host: AddProjectHost | null): string {
  if (page.kind === "host") return "No connected hosts";
  if (page.kind === "github-search") return "Enter a GitHub URL or owner/repo";
  if (page.kind === "method") return addProjectMethodEmptyText(host);
  return "No matching options";
}

interface QueryErrorInput {
  searchesDirectories: boolean;
  directoryFailed: boolean;
  githubFailed: boolean;
  githubAvailable: boolean | null;
  githubError: string | null;
}

function queryErrorText(input: QueryErrorInput): string | null {
  if (input.searchesDirectories && input.directoryFailed) return "Unable to search directories";
  if (input.githubFailed) return "Unable to search GitHub repositories";
  if (input.githubError) return toErrorMessage(input.githubError);
  if (input.githubAvailable === false) return input.githubError ?? "GitHub search is unavailable";
  return null;
}

function pageHostId(page: AddProjectPage): string | null {
  return page.kind === "host" ? null : page.hostId;
}

function pageTitle(page: AddProjectPage): string {
  switch (page.kind) {
    case "host":
      return "Choose host";
    case "method":
      return "Add project";
    case "directory-search":
      return "Search for directory";
    case "github-search":
      return "Clone from GitHub";
    case "github-location":
      return "Choose destination";
    case "new-directory-parent":
      return "Choose parent directory";
    case "new-directory-name":
      return "Name directory";
    case "folder-browser":
      if (page.purpose.kind === "open") return "Open a folder";
      if (page.purpose.kind === "create") return "New project folder";
      return `Clone ${page.purpose.repository.nameWithOwner}`;
  }
}

type AddProjectInputPage = Exclude<AddProjectPage, { kind: "method" }>;

function pagePlaceholder(page: AddProjectInputPage): string {
  switch (page.kind) {
    case "host":
      return "Search hosts...";
    case "directory-search":
      return "Search directories or enter a path...";
    case "github-search":
      return "Search or enter a GitHub repository...";
    case "github-location":
    case "new-directory-parent":
      return "Search parent directories or enter a path...";
    case "new-directory-name":
      return "Directory name";
    case "folder-browser":
      return folderBrowserPlaceholder(
        folderBrowserPurpose(page.purpose),
        isTopLevelRequest(page.request),
      );
  }
}

function pageInput(page: AddProjectInputPage): string {
  return page.kind === "new-directory-name" ? page.name : page.query;
}

function pathTestId(path: string): string {
  return `add-project-flow-path-${encodeURIComponent(path)}`;
}

function FlowRow({ option, active }: { option: FlowRowOption; active: boolean }) {
  const accessibilityState = useMemo(
    () => ({ disabled: option.disabled === true, selected: active }),
    [active, option.disabled],
  );
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (active || hovered || pressed) && styles.rowActive,
      option.disabled && styles.disabled,
    ],
    [active, option.disabled],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      disabled={option.disabled}
      onPress={option.select}
      style={rowStyle}
      testID={option.testID}
    >
      <View style={styles.iconSlot}>
        <MutedFlowIcon icon={option.icon} size={16} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {option.title}
        </Text>
        {option.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {option.subtitle}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function FlowHint({ keys, action }: { keys: string[]; action: string }) {
  const shortcutsAvailable = useKeyboardShortcutsAvailable();
  if (!shortcutsAvailable) return null;

  return (
    <View style={styles.footerHint}>
      <Shortcut keys={keys} textStyle={styles.footerKeyText} />
      <Text style={styles.footerAction}>{action}</Text>
    </View>
  );
}

function setPageStatus(
  state: AddProjectFlowState,
  kind: AddProjectPage["kind"],
  input: { isSubmitting?: boolean; error?: string | null },
): AddProjectFlowState {
  return updateCurrentAddProjectPage(state, (page) =>
    page.kind === kind ? { ...page, ...input } : page,
  );
}

// The product flow is intentionally one cohesive page-stack state machine.
// eslint-disable-next-line complexity
export function AddProjectFlow({ request, onClose }: AddProjectFlowProps) {
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(hostIds);
  const projectAddByHost = useHostFeatureMap(hostIds, "projectAdd");
  // COMPAT(stableProjectIdentity): added in v0.1.109, remove gate after 2027-01-15.
  const stableProjectIdentityByHost = useHostFeatureMap(hostIds, "stableProjectIdentity");
  // COMPAT(projectGithubClone): added in v0.1.108, remove gate after 2027-01-15.
  const githubCloneByHost = useHostFeatureMap(hostIds, "projectGithubClone");
  // COMPAT(workspaceGithubRepositorySearch): added in v0.1.108, remove gate after 2027-01-15.
  const githubSearchByHost = useHostFeatureMap(hostIds, "workspaceGithubRepositorySearch");
  // COMPAT(projectCreateDirectory): added in v0.1.108, remove gate after 2027-01-15.
  const createDirectoryByHost = useHostFeatureMap(hostIds, "projectCreateDirectory");
  const browseFoldersByHost = useHostFeatureMap(hostIds, "projectDirectoryBrowsing");
  const localServerId = useLocalDaemonServerId();
  const availableHosts = useMemo<AddProjectHost[]>(
    () =>
      hosts.flatMap((host) => {
        if (connectionStatuses.get(host.serverId) !== "online") return [];
        const canAddProject =
          projectAddByHost.get(host.serverId) === true &&
          stableProjectIdentityByHost.get(host.serverId) === true;
        return [
          {
            serverId: host.serverId,
            label: host.label,
            canAddProject,
            canBrowse: canAddProject && getIsElectronRuntime() && localServerId === host.serverId,
            canBrowseFolders: canAddProject && browseFoldersByHost.get(host.serverId) === true,
            canCloneGithubRepositories: githubCloneByHost.get(host.serverId) === true,
            canSearchGithubRepositories: githubSearchByHost.get(host.serverId) === true,
            canCreateDirectory: createDirectoryByHost.get(host.serverId) === true,
          },
        ];
      }),
    [
      browseFoldersByHost,
      connectionStatuses,
      createDirectoryByHost,
      githubCloneByHost,
      githubSearchByHost,
      hosts,
      localServerId,
      projectAddByHost,
      stableProjectIdentityByHost,
    ],
  );
  const [state, setState] = useState(() =>
    openAddProjectFlow({
      hosts: availableHosts,
      ...(request.preferredHostId ? { preferredHostId: request.preferredHostId } : {}),
    }),
  );
  const page = currentAddProjectPage(state);
  const hostId = pageHostId(page);
  const host = hostId ? state.hosts.find((candidate) => candidate.serverId === hostId) : null;
  const client = useHostRuntimeClient(hostId ?? "");
  const isLocalDaemon = useIsLocalDaemon(hostId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(hostId);
  const openProject = useOpenProject(hostId);
  const cloneGithubProject = useCloneGithubProject(hostId);
  const upsertProject = useCallback(
    (
      targetServerId: string,
      project: Parameters<ReturnType<typeof getHostRuntimeStore>["acceptProjectSnapshot"]>[1],
    ) => {
      getHostRuntimeStore().acceptProjectSnapshot(targetServerId, project);
    },
    [],
  );
  const setHasHydratedWorkspaces = useSessionStore((store) => store.setHasHydratedWorkspaces);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const submissionInFlightRef = useRef(false);
  const browseInFlightRef = useRef(false);
  // Inside a folder the browser filters loaded children locally; only its
  // top-level list runs the daemon's directory search.
  let query = "";
  if (page.kind === "folder-browser") query = folderBrowserSearchQuery(page.request, page.query);
  else if (page.kind !== "new-directory-name" && page.kind !== "method") query = page.query;
  const pageInputValueRef = useRef(page.kind === "method" ? "" : pageInput(page));
  pageInputValueRef.current = page.kind === "method" ? "" : pageInput(page);
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    setState((current) =>
      applyAvailableAddProjectHosts(current, availableHosts, request.preferredHostId),
    );
  }, [availableHosts, request.preferredHostId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Entering another folder clears the filter, so the input follows the location too.
  const folderLocationKey = page.kind === "folder-browser" ? JSON.stringify(page.request) : "";
  useEffect(() => {
    inputRef.current?.replaceText(pageInputValueRef.current);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [page.kind, folderLocationKey]);

  const searchesDirectories =
    page.kind === "directory-search" ||
    page.kind === "github-location" ||
    page.kind === "new-directory-parent" ||
    (page.kind === "folder-browser" && query !== "");
  const directoryQuery = useFetchQuery({
    queryKey: ["add-project-flow-directories", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) return { query: debouncedQuery, paths: [] as string[] };
      const payload = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      if (payload.error) throw new Error(payload.error);
      return {
        query: debouncedQuery,
        paths:
          payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: Boolean(client && searchesDirectories),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });
  const githubQuery = useFetchQuery({
    queryKey: ["add-project-flow-github", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.searchGithubRepositories({ query: debouncedQuery, limit: 30 });
      return { query: debouncedQuery, payload };
    },
    enabled: Boolean(client && page.kind === "github-search" && host?.canSearchGithubRepositories),
    dataShape: "value",
    retry: false,
    staleTimeMs: 15_000,
  });

  const folderRequest = page.kind === "folder-browser" ? page.request : null;
  const folderQuery = useFetchQuery({
    queryKey: ["add-project-flow-folders", hostId, folderRequest],
    queryFn: async () => {
      if (!client || !folderRequest) throw new Error("Host is unavailable");
      return client.browseProjectDirectories(folderRequest);
    },
    enabled: Boolean(client && folderRequest),
    dataShape: "value",
    retry: false,
    staleTimeMs: 5_000,
  });
  // Keep the previous listing on screen while the next folder loads.
  const [settledFolder, setSettledFolder] = useState<{
    hostId: string;
    payload: ProjectDirectoryBrowsePayload;
  } | null>(null);
  useEffect(() => {
    if (hostId && folderQuery.data) setSettledFolder({ hostId, payload: folderQuery.data });
  }, [folderQuery.data, hostId]);
  const folderPayload = folderRequest
    ? (folderQuery.data ?? (settledFolder?.hostId === hostId ? settledFolder.payload : null))
    : null;
  const folderDirectory = folderPayload?.directory ?? null;
  const folderLoading = folderRequest !== null && folderQuery.isFetching;

  const handleBack = useCallback(() => {
    setState((current) => {
      const previous = backAddProjectPage(current);
      if (previous) return previous;
      onClose();
      return current;
    });
  }, [onClose]);

  const openNewWorkspaceForProject = useCallback(
    (serverId: string, project: WorkspaceProjectDescriptorPayload) => {
      onClose();
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          projectId: project.projectId,
          sourceDirectory: project.projectRootPath,
          displayName: project.projectDisplayName,
        }),
      );
    },
    [onClose],
  );

  const openAddedProject = useCallback(
    async (path: string, sourceKind: "directory-search" | "method" | "folder-browser") => {
      if (!hostId || submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, sourceKind, { isSubmitting: true, error: null }),
      );
      try {
        const result = await openProject(path);
        if (result.ok) {
          if (sourceKind === "folder-browser" && folderDirectory) {
            lastFolderRequestByHost.set(hostId, parentRequest(folderDirectory) ?? {});
          }
          openNewWorkspaceForProject(hostId, result.project);
          return;
        }
        const reason = getOpenProjectFailureReason(result);
        const fallback =
          reason === "directory_not_found" ? "Directory not found" : "Unable to add project";
        const message = result.error ? toErrorMessage(result.error) : fallback;
        setState((current) =>
          setPageStatus(current, sourceKind, { isSubmitting: false, error: message }),
        );
      } catch {
        setState((current) =>
          setPageStatus(current, sourceKind, {
            isSubmitting: false,
            error: "Unable to add project",
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [folderDirectory, hostId, openNewWorkspaceForProject, openProject],
  );

  const browse = useCallback(async () => {
    if (!hostId || !isLocalDaemon || browseInFlightRef.current) return;
    browseInFlightRef.current = true;
    try {
      const path = await pickDirectory();
      if (path) await openAddedProject(path, "method");
    } catch {
      setState((current) =>
        setPageStatus(current, "method", { error: "Unable to browse for a directory" }),
      );
    } finally {
      browseInFlightRef.current = false;
    }
  }, [hostId, isLocalDaemon, openAddedProject]);

  const selectMethod = useCallback(
    (method: AddProjectMethodId) => {
      if (!hostId) return;
      const lastFolder = lastFolderRequestByHost.get(hostId) ?? {};
      if (method === "open-folder") {
        setState((current) => openFolderBrowserPage(current, hostId, { kind: "open" }, lastFolder));
      } else if (method === "new-directory" && host?.canBrowseFolders) {
        setState((current) =>
          openFolderBrowserPage(current, hostId, { kind: "create" }, lastFolder),
        );
      } else if (method === "directory-search") {
        setState((current) => openDirectorySearchPage(current, hostId));
      } else if (method === "browse") {
        void browse();
      } else if (method === "github") {
        setState((current) => openGithubSearchPage(current, hostId));
      } else {
        setState((current) => openNewDirectoryParentPage(current, hostId));
      }
    },
    [browse, host?.canBrowseFolders, hostId],
  );

  const directoryPaths = useMemo(
    () => (directoryQuery.data?.query === query ? directoryQuery.data.paths : EMPTY_PATHS),
    [directoryQuery.data, query],
  );
  const pathOptions = useMemo(
    () =>
      buildProjectPickerOptions({
        recommendedPaths,
        serverPaths: directoryPaths,
        query,
      }),
    [directoryPaths, query, recommendedPaths],
  );
  const cloneRepository = useCallback(
    async (input: {
      hostId: string;
      repository: GithubRepositoryChoice;
      parentPath: string;
      statusKind: "github-location" | "folder-browser";
      rememberFolder?: FolderBrowseRequest;
    }) => {
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, input.statusKind, { isSubmitting: true, error: null }),
      );
      try {
        const result = await cloneGithubProject(
          input.repository.cloneUrl,
          input.parentPath,
          input.repository.cloneProtocol,
        );
        if (result.ok) {
          lastCloneParentByHost.set(input.hostId, input.parentPath);
          if (input.rememberFolder) lastFolderRequestByHost.set(input.hostId, input.rememberFolder);
          openNewWorkspaceForProject(input.hostId, result.project);
          return;
        }
        setState((current) =>
          setPageStatus(current, input.statusKind, {
            isSubmitting: false,
            error: result.error ? toErrorMessage(result.error) : "Unable to clone repository",
          }),
        );
      } catch (error) {
        setState((current) =>
          setPageStatus(current, input.statusKind, {
            isSubmitting: false,
            error: error instanceof Error ? toErrorMessage(error) : "Unable to clone repository",
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [cloneGithubProject, openNewWorkspaceForProject],
  );
  const createFolder = useCallback(
    async (input: {
      hostId: string;
      parentPath: string;
      name: string;
      statusKind: "new-directory-name" | "folder-browser";
      rememberFolder?: FolderBrowseRequest;
    }) => {
      if (!client) return;
      const name = input.name.trim();
      const invalid = validateFolderName(name);
      if (invalid) {
        setState((current) => setPageStatus(current, input.statusKind, { error: invalid }));
        return;
      }
      if (submissionInFlightRef.current) return;
      submissionInFlightRef.current = true;
      setState((current) =>
        setPageStatus(current, input.statusKind, { isSubmitting: true, error: null }),
      );
      try {
        const payload = await client.createProjectDirectory({
          parentPath: input.parentPath,
          name,
        });
        if (payload.error || !payload.project) {
          // Browsed locations hide container paths, so their errors do too.
          const error =
            input.statusKind === "folder-browser"
              ? createFolderErrorText({ errorCode: payload.errorCode, error: payload.error, name })
              : (payload.error ?? "Unable to create directory");
          setState((current) =>
            setPageStatus(current, input.statusKind, { isSubmitting: false, error }),
          );
          return;
        }
        if (input.rememberFolder) lastFolderRequestByHost.set(input.hostId, input.rememberFolder);
        registerProjectDescriptor({
          serverId: input.hostId,
          project: payload.project,
          upsertProject,
          setHasHydratedWorkspaces,
        });
        openNewWorkspaceForProject(input.hostId, payload.project);
      } catch {
        setState((current) =>
          setPageStatus(current, input.statusKind, {
            isSubmitting: false,
            error: "Unable to create folder",
          }),
        );
      } finally {
        submissionInFlightRef.current = false;
      }
    },
    [client, openNewWorkspaceForProject, setHasHydratedWorkspaces, upsertProject],
  );
  const navigateFolder = useCallback(
    (target: FolderBrowseRequest) => {
      if (page.kind !== "folder-browser") return;
      const showHidden = page.request.showHidden;
      setState((current) =>
        browseAddProjectFolder(current, showHidden ? { ...target, showHidden } : target),
      );
    },
    [page],
  );
  const goUpFolder = useCallback(() => {
    if (page.kind !== "folder-browser" || !folderDirectory) return;
    navigateFolder(parentRequest(folderDirectory) ?? {});
  }, [folderDirectory, navigateFolder, page.kind]);
  const toggleHiddenFolders = useCallback(() => {
    setState((current) =>
      updateCurrentAddProjectPage(current, (currentPage) =>
        currentPage.kind === "folder-browser"
          ? {
              ...currentPage,
              activeIndex: 0,
              request: {
                ...currentPage.request,
                offset: 0,
                showHidden: !currentPage.request.showHidden,
              },
            }
          : currentPage,
      ),
    );
  }, []);
  const selectFolderRow = useCallback(
    (row: FolderBrowserRow) => {
      if (page.kind !== "folder-browser") return;
      if (row.kind === "open-path") {
        void openAddedProject(row.path, "folder-browser");
        return;
      }
      if (row.kind === "create-at-path") {
        void createFolder({
          hostId: page.hostId,
          parentPath: row.parentPath,
          name: row.name,
          statusKind: "folder-browser",
        });
        return;
      }
      if (row.kind === "clone-at-path") {
        if (page.purpose.kind !== "clone") return;
        void cloneRepository({
          hostId: page.hostId,
          repository: page.purpose.repository,
          parentPath: row.parentPath,
          statusKind: "folder-browser",
        });
        return;
      }
      if (
        row.kind === "location" ||
        row.kind === "folder" ||
        row.kind === "go-to" ||
        row.kind === "page" ||
        row.kind === "search-result"
      ) {
        navigateFolder(row.target);
        return;
      }
      if (!folderDirectory) return;
      const here: FolderBrowseRequest = {
        rootId: folderDirectory.rootId,
        path: folderDirectory.path,
      };
      if (row.kind === "create") {
        void createFolder({
          hostId: page.hostId,
          parentPath: folderDirectory.containerPath,
          name: row.name,
          statusKind: "folder-browser",
          rememberFolder: here,
        });
        return;
      }
      if (page.purpose.kind === "clone") {
        void cloneRepository({
          hostId: page.hostId,
          repository: page.purpose.repository,
          parentPath: folderDirectory.containerPath,
          statusKind: "folder-browser",
          rememberFolder: here,
        });
        return;
      }
      void openAddedProject(folderDirectory.containerPath, "folder-browser");
    },
    [cloneRepository, createFolder, folderDirectory, navigateFolder, openAddedProject, page],
  );
  const rows = useMemo<FlowRowOption[]>(() => {
    if (page.kind === "host") {
      const choices = filterAddProjectHosts(state.hosts, page.query).map<FlowRowOption>(
        (choice) => ({
          id: choice.serverId,
          title: choice.label,
          subtitle: choice.serverId,
          icon: Server,
          testID: `add-project-flow-host-${choice.serverId}`,
          select: () => setState((current) => chooseAddProjectHost(current, choice.serverId)),
        }),
      );
      if (state.hosts.length === 0) {
        choices.push({
          id: "add-host",
          title: "Add host",
          subtitle: "No connected hosts",
          icon: Plus,
          testID: "add-project-flow-add-host",
          select: () => {
            onClose();
            router.push(buildSettingsAddHostRoute(Date.now()));
          },
        });
      }
      return choices;
    }
    if (page.kind === "method") {
      if (!host) return [];
      return buildAddProjectMethods(host).map((method) => ({
        id: method.id,
        title: method.label,
        subtitle: method.description,
        icon: methodIcon(method.id),
        disabled: method.disabled,
        testID: `add-project-flow-method-${method.id}`,
        select: () => selectMethod(method.id),
      }));
    }
    if (page.kind === "directory-search") {
      return pathOptions.map((option) => {
        const shortPath = shortenPath(option.path);
        return {
          id: option.path,
          title: shortPath,
          subtitle: directoryOptionSubtitle(option, shortPath),
          icon: Folder,
          testID: pathTestId(option.path),
          select: () => void openAddedProject(option.path, "directory-search"),
        };
      });
    }
    if (page.kind === "github-search") {
      const search = githubQuery.data?.query === page.query ? githubQuery.data.payload : null;
      const repositories = search?.repositories ?? [];
      const normalizedQuery = page.query.trim().toLowerCase();
      const hasExactSearchResult = repositories.some(
        (repository) =>
          repository.nameWithOwner.toLowerCase() === normalizedQuery ||
          repository.cloneUrl.toLowerCase() === normalizedQuery,
      );
      const manualRepositories = hasExactSearchResult
        ? []
        : buildManualGithubRepositoryChoices(page.query);
      const repositoryChoices: GithubRepositoryChoice[] = [...manualRepositories, ...repositories];
      return repositoryChoices.map((repository) => ({
        id: repository.id,
        title: repository.cloneProtocol
          ? `${repository.nameWithOwner} via ${repository.cloneProtocol.toUpperCase()}`
          : repository.nameWithOwner,
        subtitle: repository.description,
        icon: GitHubIcon,
        testID: `add-project-flow-repository-${repository.id}`,
        select: () =>
          setState((current) =>
            host?.canBrowseFolders
              ? openFolderBrowserPage(
                  current,
                  page.hostId,
                  { kind: "clone", repository },
                  lastFolderRequestByHost.get(page.hostId) ?? {},
                )
              : openGithubLocationPage(current, page.hostId, repository),
          ),
      }));
    }
    if (page.kind === "github-location") {
      const repositoryName = pathBaseName(page.repository.nameWithOwner);
      const lastParent = lastCloneParentByHost.get(page.hostId);
      const parents = buildSuggestedParentDirectories(recommendedPaths);
      const orderedParents = lastParent
        ? [lastParent, ...parents.filter((parent) => parent !== lastParent)]
        : parents;
      const filteredParents = buildProjectPickerOptions({
        recommendedPaths: orderedParents,
        serverPaths: directoryPaths,
        query: page.query,
      }).map((option) => option.path);
      return buildCloneLocationOptions({
        parents: filteredParents,
        repositoryName,
        existingPaths: [...recommendedPaths, ...directoryPaths],
      }).map((option) => ({
        id: option.id,
        title: shortenPath(option.displayPath),
        subtitle: option.secondaryText,
        icon: HardDrive,
        disabled: option.disabled,
        testID: pathTestId(option.displayPath),
        select: () =>
          void cloneRepository({
            hostId: page.hostId,
            repository: page.repository,
            parentPath: option.path,
            statusKind: "github-location",
          }),
      }));
    }
    if (page.kind === "new-directory-parent") {
      return pathOptions.map((option) => ({
        id: option.path,
        title: shortenPath(option.path),
        subtitle: option.kind === "path" ? "Use this parent" : option.path,
        icon: Folder,
        testID: pathTestId(option.path),
        select: () =>
          setState((current) => openNewDirectoryNamePage(current, page.hostId, option.path)),
      }));
    }
    if (page.kind === "folder-browser") {
      return buildFolderBrowserRows({
        purpose: folderBrowserPurpose(page.purpose),
        payload: folderPayload,
        request: page.request,
        filter: page.query,
        recentProjectPaths: recommendedPaths,
        searchResults: directoryPaths,
      }).map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: folderRowSubtitle(row),
        icon: folderRowIcon(row, page.purpose),
        disabled: row.kind === "use-current" && row.disabled,
        testID: folderRowTestId(row),
        select: () => selectFolderRow(row),
      }));
    }
    return [];
  }, [
    cloneRepository,
    directoryPaths,
    folderPayload,
    githubQuery.data,
    host,
    onClose,
    openAddedProject,
    page,
    pathOptions,
    recommendedPaths,
    selectFolderRow,
    selectMethod,
    state.hosts,
  ]);

  const activeIndex = rows.length === 0 ? 0 : Math.min(page.activeIndex, rows.length - 1);
  const createDirectory = useCallback(() => {
    if (page.kind !== "new-directory-name") return;
    void createFolder({
      hostId: page.hostId,
      parentPath: page.parentPath,
      name: page.name,
      statusKind: "new-directory-name",
    });
  }, [createFolder, page]);

  const submitActive = useCallback(() => {
    if (page.kind === "new-directory-name") {
      createDirectory();
      return;
    }
    // Rows may still describe the previous folder until the next one loads.
    if (folderLoading) return;
    const option = rows[activeIndex];
    if (option && !option.disabled) option.select();
  }, [activeIndex, createDirectory, folderLoading, page.kind, rows]);

  const handleKey = useCallback(
    (key: string): boolean => {
      if (key === "Escape") {
        handleBack();
        return true;
      }
      if (page.kind === "folder-browser" && !page.query) {
        // With an empty filter, Backspace and Left go up and Right enters a folder.
        if (key === "Backspace" || key === "ArrowLeft") {
          goUpFolder();
          return true;
        }
        if (key === "ArrowRight") {
          const option = rows[activeIndex];
          if (option && folderRowEntersFolder(option.id)) option.select();
          return true;
        }
      }
      if (key === "Enter") {
        submitActive();
        return true;
      }
      if (key !== "ArrowDown" && key !== "ArrowUp") return false;
      const next = moveAddProjectSelection(
        activeIndex,
        rows.map((row) => row.disabled !== true),
        key === "ArrowDown" ? "next" : "previous",
      );
      setState((current) => setAddProjectActiveIndex(current, next));
      return true;
    },
    [activeIndex, goUpFolder, handleBack, page, rows, submitActive],
  );

  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!handleKey(event.key)) return false;
      event.preventDefault();
      return true;
    },
    [handleKey],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  const handleNativeKeyPress = useCallback(
    ({ nativeEvent: { key } }: { nativeEvent: { key: string } }) => {
      if (
        key === "ArrowDown" ||
        key === "ArrowUp" ||
        key === "Escape" ||
        key === "Backspace" ||
        key === "ArrowLeft" ||
        key === "ArrowRight"
      ) {
        handleKey(key);
      }
    },
    [handleKey],
  );

  const handleInputChange = useCallback((value: string) => {
    setState((current) =>
      currentAddProjectPage(current).kind === "new-directory-name"
        ? setNewDirectoryName(current, value)
        : setAddProjectPageInput(current, value),
    );
  }, []);
  const isSubmitting = "isSubmitting" in page && page.isSubmitting;
  const currentGithubSearch =
    page.kind === "github-search" && githubQuery.data?.query === page.query
      ? githubQuery.data.payload
      : null;
  const loading =
    (searchesDirectories && (query !== debouncedQuery || directoryQuery.isFetching)) ||
    (folderLoading && !folderPayload) ||
    (page.kind === "github-search" &&
      host?.canSearchGithubRepositories === true &&
      (query !== debouncedQuery || githubQuery.isFetching));
  let folderError: string | null = null;
  if (folderQuery.isError) folderError = "Unable to list folders";
  else if (!folderLoading) folderError = folderPayload?.error ?? null;
  const queryError =
    folderError ??
    queryErrorText({
      searchesDirectories,
      directoryFailed: directoryQuery.isError,
      githubFailed: page.kind === "github-search" && githubQuery.isError,
      githubAvailable: currentGithubSearch?.available ?? null,
      githubError: currentGithubSearch?.error ?? null,
    });
  const folderLocation =
    page.kind === "folder-browser" && folderDirectory && folderPayload
      ? folderLocationLabel(folderPayload.roots, folderDirectory)
      : null;
  // A container without shared folders cannot reach the owner's computer at all.
  const showShareHint =
    page.kind === "folder-browser" &&
    !folderDirectory &&
    folderPayload !== null &&
    folderPayload.roots.length > 0 &&
    folderPayload.roots.every((root) => root.hostPath === null);
  const preview =
    page.kind === "new-directory-name" && page.name.trim()
      ? joinDirectoryPath(page.parentPath, page.name.trim())
      : null;

  const modal = (
    <Modal visible transparent animationType="fade" onRequestClose={isWeb ? undefined : handleBack}>
      <View style={styles.overlay} testID="add-project-flow">
        <Pressable style={styles.backdrop} onPress={onClose} testID="add-project-flow-backdrop" />
        <View
          ref={setWebOverlayScope}
          style={styles.panel}
          testID={`add-project-flow-page-${page.kind}`}
          accessibilityLabel={`Add project: ${page.kind}`}
        >
          <View style={styles.header}>
            <View style={styles.titleRow}>
              {state.pages.length > 1 ? <FlowBackButton onPress={handleBack} /> : null}
              <View style={styles.titleGroup} testID="add-project-flow-title">
                <Text style={styles.title} numberOfLines={1}>
                  {pageTitle(page)}
                </Text>
                {host ? (
                  <Text style={styles.hostContext} numberOfLines={1}>
                    {host.label}
                  </Text>
                ) : null}
              </View>
            </View>
            {page.kind === "method" && isNative ? (
              // Native hardware-keyboard events need a focused responder even without a visible field.
              <TextInput
                ref={inputRef}
                onKeyPress={handleNativeKeyPress}
                onSubmitEditing={submitActive}
                showSoftInputOnFocus={false}
                caretHidden
                contextMenuHidden
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                pointerEvents="none"
                style={styles.keyboardCapture}
                testID="add-project-flow-keyboard-capture"
              />
            ) : null}
            {page.kind !== "method" ? (
              <ThemedTextInput
                ref={inputRef}
                initialValue={pageInput(page)}
                onChangeText={handleInputChange}
                onKeyPress={isWeb ? undefined : handleNativeKeyPress}
                onSubmitEditing={isWeb ? undefined : submitActive}
                placeholder={pagePlaceholder(page)}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSubmitting}
                returnKeyType="go"
                testID="add-project-flow-input"
              />
            ) : null}
            {page.kind === "folder-browser" ? (
              <View style={styles.locationBar} testID="add-project-flow-location">
                <LocationButton
                  icon={ArrowUp}
                  label="Up one folder"
                  disabled={!folderDirectory || isSubmitting}
                  onPress={goUpFolder}
                  testID="add-project-flow-up"
                />
                <View style={styles.locationText} testID="add-project-flow-location-title">
                  <Text style={styles.locationTitle} numberOfLines={1}>
                    {folderLocation ? locationName(folderLocation.title) : "Locations"}
                  </Text>
                  {folderLocation ? (
                    <Text style={styles.locationDetail} numberOfLines={1}>
                      {folderLocation.detail
                        ? `${folderLocation.detail} · ${folderLocation.title}`
                        : folderLocation.title}
                    </Text>
                  ) : null}
                </View>
                <LocationButton
                  icon={page.request.showHidden ? EyeOff : Eye}
                  label={page.request.showHidden ? "Hide hidden folders" : "Show hidden folders"}
                  disabled={!folderDirectory || isSubmitting}
                  onPress={toggleHiddenFolders}
                  testID="add-project-flow-toggle-hidden"
                />
              </View>
            ) : null}
          </View>
          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            testID="add-project-flow-results"
          >
            {preview ? (
              <Text style={styles.preview} testID="add-project-flow-path-preview">
                {shortenPath(preview)}
              </Text>
            ) : null}
            {isSubmitting ? (
              <Text style={styles.stateText} testID="add-project-flow-progress">
                {progressText(page)}
              </Text>
            ) : null}
            {!isSubmitting && page.error ? (
              <Text style={styles.errorText} testID="add-project-flow-error">
                {page.error}
              </Text>
            ) : null}
            {!isSubmitting && queryError ? (
              <Text style={styles.errorText} testID="add-project-flow-query-error">
                {queryError}
              </Text>
            ) : null}
            {!isSubmitting && loading ? (
              <Text style={styles.stateText} testID="add-project-flow-loading">
                Loading...
              </Text>
            ) : null}
            {/* Typed paths and matching recommendations do not depend on directory search. */}
            {!isSubmitting
              ? rows.map((option, index) => (
                  <FlowRow key={option.id} option={option} active={index === activeIndex} />
                ))
              : null}
            {!isSubmitting &&
            !loading &&
            !queryError &&
            rows.length === 0 &&
            page.kind !== "new-directory-name" ? (
              <Text style={styles.stateText} testID="add-project-flow-empty">
                {page.kind === "folder-browser"
                  ? folderBrowserEmptyText({
                      purpose: folderBrowserPurpose(page.purpose),
                      directory: folderDirectory,
                      filter: page.query,
                    })
                  : emptyText(page, host ?? null)}
              </Text>
            ) : null}
            {showShareHint ? (
              <Text style={styles.hintText} testID="add-project-flow-share-hint">
                To use folders from your computer, share them with share-folder.sh in the
                installation directory on the host.
              </Text>
            ) : null}
          </ScrollView>
          <View style={styles.footer} testID="add-project-flow-footer">
            <FlowHint keys={NAVIGATION_HINT_KEYS} action="Navigate" />
            {page.kind === "folder-browser" ? (
              <FlowHint keys={OPEN_FOLDER_HINT_KEYS} action="Open folder" />
            ) : null}
            {page.kind === "folder-browser" ? (
              <FlowHint keys={UP_FOLDER_HINT_KEYS} action="Up" />
            ) : null}
            <FlowHint keys={SELECT_HINT_KEYS} action="Select" />
            <FlowHint keys={ESCAPE_HINT_KEYS} action={state.pages.length > 1 ? "Back" : "Close"} />
          </View>
        </View>
      </View>
    </Modal>
  );

  return createElement(OverlayLayerProvider, { layer: isWeb ? modalLayer : 0 }, modal);
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  titleRow: {
    minHeight: theme.iconSize.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backButton: {
    width: 18,
    height: theme.iconSize.lg,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  title: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hostContext: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  keyboardCapture: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
  results: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  resultsContent: { paddingVertical: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowActive: { backgroundColor: theme.colors.surface1 },
  disabled: { opacity: theme.opacity[50] },
  iconSlot: { width: 18, alignItems: "center" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  rowSubtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, marginTop: 2 },
  locationBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  locationButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  locationText: {
    flex: 1,
    minWidth: 0,
  },
  locationTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  locationDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  preview: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  footer: {
    flexShrink: 0,
    flexDirection: "row",
    gap: theme.spacing[4],
    alignItems: "center",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  footerKeyText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  footerAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
