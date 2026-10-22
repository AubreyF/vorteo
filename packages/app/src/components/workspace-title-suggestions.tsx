import { useCallback, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { RenamableWorkspace } from "./workspace-rename-modal";
import { toErrorMessage } from "@/utils/error-messages";

interface Props {
  workspace: RenamableWorkspace;
  onSelect: (title: string) => void;
  disabled: boolean;
}

const SuggestionSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

export function WorkspaceTitleSuggestions(props: Props) {
  // COMPAT(workspaceTitleSuggestions): added in v0.7.2, remove gate after 2027-03-10.
  const supported = useHostFeature(props.workspace.serverId, "workspaceTitleSuggestions");
  if (!supported) {
    return (
      <Alert
        variant="warning"
        tinted
        title="Title suggestions unavailable"
        description="Reconnect to refresh the host's capabilities. If suggestions remain unavailable, update the host and choose an available model in Metadata generation."
        testID="workspace-title-warning"
      />
    );
  }
  return <AvailableSuggestions {...props} />;
}

function AvailableSuggestions({ workspace, onSelect, disabled }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ["workspace-title-suggestions", workspace.serverId, workspace.workspaceId];
  const refreshRequested = useRef(false);
  const cached = queryClient.getQueryState(queryKey);
  const suggestions = useFetchQuery({
    dataShape: "value",
    enabled: !cached?.data || Date.now() - cached.dataUpdatedAt >= 30 * 60_000,
    queryKey,
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) throw new Error("Host disconnected. Reconnect and try again.");
      // Only the Regenerate button requests new alternatives.
      const regenerate = refreshRequested.current;
      refreshRequested.current = false;
      return client.suggestWorkspaceTitles(workspace.workspaceId, regenerate);
    },
    staleTimeMs: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refetch = suggestions.refetch;
  const regenerate = useCallback(() => {
    refreshRequested.current = true;
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  const showError = suggestions.isError && !suggestions.isFetching;
  const showTitles = !suggestions.isError && !suggestions.isFetching;
  return (
    <View style={styles.body} testID="workspace-title-suggestions">
      <View style={styles.header}>
        <Text style={styles.hint}>Suggested titles</Text>
        <Button
          variant="ghost"
          size="md"
          onPress={regenerate}
          disabled={disabled || suggestions.isFetching}
          testID="workspace-title-regenerate"
        >
          {suggestions.isError ? "Retry" : "Regenerate"}
        </Button>
      </View>
      <View style={styles.slots} testID="workspace-title-suggestion-slots">
        {suggestions.isFetching ? (
          <View
            style={styles.status}
            accessibilityLiveRegion="polite"
            accessibilityLabel="Generating title suggestions"
          >
            <SuggestionSpinner size="small" />
            <Text style={styles.hint}>Generating suggestions...</Text>
          </View>
        ) : null}
        {showError ? (
          <Alert
            variant="warning"
            tinted
            title="Could not generate title suggestions"
            description={toErrorMessage(suggestions.error)}
            testID="workspace-title-warning"
          />
        ) : null}
        {showTitles
          ? suggestions.data?.map((title) => (
              <SuggestedTitle key={title} title={title} disabled={disabled} onSelect={onSelect} />
            ))
          : null}
      </View>
    </View>
  );
}

function SuggestedTitle({
  title,
  disabled,
  onSelect,
}: Pick<Props, "disabled" | "onSelect"> & { title: string }) {
  const select = useCallback(() => onSelect(title), [onSelect, title]);
  return (
    <Button
      variant="ghost"
      size="sm"
      style={styles.suggestion}
      textStyle={styles.suggestionText}
      disabled={disabled}
      onPress={select}
      accessibilityLabel={title}
    >
      <Text numberOfLines={2}>{title}</Text>
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { marginVertical: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  // Reserve room for three titles, but allow long warnings to wrap at larger text sizes.
  slots: { minHeight: Math.max(32, theme.fontSize.base * 2 + 4) * 3 },
  status: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[2] },
  suggestion: {
    justifyContent: "flex-start",
    minHeight: 32,
    height: Math.max(32, theme.fontSize.base * 2 + 4),
    paddingVertical: 0,
  },
  suggestionText: {
    textAlign: "left",
    flex: 1,
    lineHeight: theme.fontSize.base,
  },
}));
