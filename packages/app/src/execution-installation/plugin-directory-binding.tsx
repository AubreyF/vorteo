import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { openPluginInstallForm } from "@/screens/settings/plugin-install-form-model";
import { settingsStyles } from "@/styles/settings";

interface BindingDraft {
  id: string;
  expectedPath: string | null;
  enabled: boolean;
}

function useDirectoryForm(path: string | null) {
  const [model] = useState(() => {
    const form = openPluginInstallForm();
    form.setSource(path ?? "");
    return form;
  });
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

function DirectoryBindingForm({
  client,
  draft,
  onSaved,
  onClose,
}: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  draft: BindingDraft;
  onSaved(): void;
  onClose(): void;
}) {
  const { model, state } = useDirectoryForm(draft.expectedPath);
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const mutation = useMutation({
    mutationFn: () => client.bindDirectoryPlugin({ ...draft, path: model.getSubmission().source }),
    onSuccess: onSaved,
  });
  const submit = useCallback(() => mutation.mutate(), [mutation]);
  const error = bindingError(mutation.error);
  const header = useMemo(() => ({ title: `Directory for ${draft.id}` }), [draft.id]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      testID="plugin-directory-binding-form"
    >
      <View style={styles.form}>
        <Field label="Directory">
          <FormTextInput
            initialValue={state.source}
            onChangeText={model.setSource}
            editable={!mutation.isPending}
            size={size}
            accessibilityLabel="Plugin directory"
            testID="plugin-directory-binding-path"
          />
        </Field>
        {error ? <Alert variant="error" description={error} /> : null}
        <Button
          variant="default"
          size={size}
          disabled={!state.canSubmit || mutation.isPending}
          onPress={submit}
          testID="plugin-directory-binding-save"
        >
          {mutation.isPending ? "Saving..." : "Save directory"}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

export function PluginDirectoryBinding({
  serverId,
  pluginId,
  enabled,
}: {
  serverId: string;
  pluginId: string;
  enabled: boolean;
}) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginDirectoryBindings");
  const compact = useIsCompactFormFactor();
  const [draft, setDraft] = useState<BindingDraft | null>(null);
  const plugins = useFetchQuery({
    queryKey: ["plugins", serverId],
    queryFn: async () => {
      if (!client) throw new Error("Environment is disconnected");
      return client.listPlugins();
    },
    enabled: Boolean(client && connected && supported),
    dataShape: "list",
    staleTimeMs: 1000,
    refetchInterval: 5000,
  });
  const local = plugins.data?.find((plugin) => plugin.id === pluginId);
  const open = useCallback(() => {
    setDraft({
      id: pluginId,
      expectedPath: local?.path ?? null,
      enabled,
    });
  }, [enabled, local, pluginId]);
  const close = useCallback(() => setDraft(null), []);
  const saved = useCallback(() => {
    void plugins.refetch();
    setDraft((current) => (current === draft ? null : current));
  }, [plugins, draft]);
  if (!connected)
    return (
      <Text style={settingsStyles.rowHint}>
        Connect this environment to edit its plugin directory
      </Text>
    );
  if (!supported)
    return (
      <Text style={settingsStyles.rowHint}>
        Update this environment to edit its plugin directory
      </Text>
    );
  if (plugins.error) return <Alert variant="error" description={plugins.error.message} />;
  if (plugins.isPending)
    return <Text style={settingsStyles.rowHint}>Loading plugin directory...</Text>;
  return (
    <View>
      <SettingsRow
        label={`Directory for ${pluginId}`}
        hint={local?.path ?? "Not configured"}
        testID={`plugin-directory-binding-${serverId}-${pluginId}`}
      >
        <Button variant="outline" size={compact ? "md" : "sm"} onPress={open}>
          Edit directory
        </Button>
      </SettingsRow>
      {draft && client ? (
        <DirectoryBindingForm client={client} draft={draft} onSaved={saved} onClose={close} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({ form: { gap: theme.spacing[4] } }));

function bindingError(error: Error | null): string | undefined {
  if (!error) return undefined;
  if ("userMessage" in error && typeof error.userMessage === "string")
    return error.userMessage.replace(/^Request failed: /, "");
  return error.message;
}
