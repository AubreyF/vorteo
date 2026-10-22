import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { openDirectoryBrowser } from "@/add-project-flow/directory-browser";
import { toErrorMessage } from "@/utils/error-messages";

interface ProjectDirectoryBrowserProps {
  client: Pick<DaemonClient, "browseProjectDirectories">;
  onSelect(path: string): void;
}

export function ProjectDirectoryBrowser({ client, onSelect }: ProjectDirectoryBrowserProps) {
  const [model] = useState(() => openDirectoryBrowser(client));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  useEffect(() => {
    void model.browse({});
    return () => model.close();
  }, [model]);
  const directory = state.result?.directory;
  const ready = !state.loading && !state.error;
  const openPath = useCallback(() => {
    void model.openHostPath();
  }, [model]);
  const showRoots = useCallback(() => {
    void model.browse({});
  }, [model]);
  const refresh = useCallback(() => {
    void model.browse(state.request);
  }, [model, state.request]);
  const toggleHidden = useCallback(() => {
    void model.browse({ ...state.request, offset: 0, showHidden: !state.request.showHidden });
  }, [model, state.request]);
  const goUp = useCallback(() => {
    if (directory)
      void model.browse({
        rootId: directory.rootId,
        path: directory.parent ?? ".",
        showHidden: state.request.showHidden,
      });
  }, [model, directory, state.request.showHidden]);
  const select = useCallback(() => {
    if (directory) onSelect(directory.containerPath);
  }, [directory, onSelect]);
  const next = useCallback(() => {
    if (directory) void model.browse({ ...state.request, offset: directory.nextOffset ?? 0 });
  }, [model, directory, state.request]);
  const previous = useCallback(() => {
    void model.browse({ ...state.request, offset: Math.max(0, (state.request.offset ?? 0) - 100) });
  }, [model, state.request]);
  const rows = useMemo(() => {
    if (directory)
      return directory.entries.map((entry) => ({
        id: entry.path,
        label: entry.name,
        testID: `project-directory-child-${entry.name}`,
        select: () => {
          void model.browse({
            rootId: directory.rootId,
            path: entry.path,
            showHidden: state.request.showHidden,
          });
        },
      }));
    return (state.result?.roots ?? []).map((root) => ({
      id: root.id,
      label: root.hostPath ?? root.label,
      testID: `project-directory-root-${root.id}`,
      select: () => {
        void model.browse({ rootId: root.id });
      },
    }));
  }, [directory, model, state.result, state.request.showHidden]);
  return (
    <View style={styles.content} testID="project-directory-browser">
      <Text style={styles.text}>Choose a shared host folder or container storage.</Text>
      <EditingTextInput
        initialValue=""
        onChangeText={model.setInput}
        onSubmitEditing={openPath}
        placeholder="Host path, such as ~/Documents/Project"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID="project-directory-host-path"
      />
      <Button
        variant="outline"
        onPress={openPath}
        disabled={!state.input.trim() || state.loading}
        testID="project-directory-open-path"
      >
        Open host path
      </Button>
      <View style={styles.actions}>
        <Button variant="ghost" onPress={showRoots}>
          Shared folders
        </Button>
        <Button variant="ghost" onPress={refresh}>
          Refresh
        </Button>
        <Button variant="ghost" onPress={toggleHidden}>
          {state.request.showHidden ? "Hide hidden folders" : "Show hidden folders"}
        </Button>
      </View>
      {state.loading ? <Text style={styles.text}>Loading folders...</Text> : null}
      {state.error ? (
        <Text style={styles.error} testID="project-directory-error">
          {toErrorMessage(state.error)}
        </Text>
      ) : null}
      {ready && directory ? (
        <>
          <Text selectable style={styles.text}>
            {directory.hostPath ?? directory.containerPath}
          </Text>
          {directory.hostPath ? (
            <Text selectable style={styles.text}>
              Container path: {directory.containerPath}
            </Text>
          ) : null}
          {directory.parent !== null ? (
            <Button variant="ghost" onPress={goUp}>
              Up one folder
            </Button>
          ) : null}
          <Button onPress={select} testID="project-directory-select">
            Select this folder
          </Button>
        </>
      ) : null}
      {ready
        ? rows.map((row) => (
            <Button key={row.id} variant="ghost" testID={row.testID} onPress={row.select}>
              {row.label}
            </Button>
          ))
        : null}
      {ready && directory ? (
        <>
          {directory.nextOffset !== null ? (
            <Button variant="outline" onPress={next}>
              Next folders
            </Button>
          ) : null}
          {(state.request.offset ?? 0) > 0 ? (
            <Button variant="outline" onPress={previous}>
              Previous folders
            </Button>
          ) : null}
          {directory.entries.length === 0 ? <Text style={styles.text}>No subfolders</Text> : null}
        </>
      ) : null}
      <Text style={styles.text}>
        Share additional host folders using share-folder.sh in the installation directory on the
        host.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3], padding: theme.spacing[4] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
}));
