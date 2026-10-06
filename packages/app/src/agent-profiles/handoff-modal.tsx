import { createDestinationWorkspace } from "./internal/destination-workspaces";
import { generateMessageId } from "@/types/stream";
import { useHostFeature } from "@/runtime/host-features";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useCallback, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { toErrorMessage } from "@/utils/error-messages";

interface HandoffModalProps {
  title?: string;
  description?: string;
  warning?: string;
  confirmLabel?: string;
  name: string;
  initialContext: string;
  onClose: () => void;
  destinationServerId?: string;
  destinationProject?: NonNullable<WorkspaceDescriptorPayload["projectMembership"]>;
  destinationDirectory?: string;
  workspaceName?: string;
  draft?: boolean;
  onConfirm: (context: string, workspace?: WorkspaceDescriptorPayload) => Promise<void>;
}
interface FormState {
  context: string;
  pending: boolean;
  error: string | null;
}
type Action =
  | { type: "edit"; context: string }
  | { type: "submit" }
  | { type: "error"; error: string };
function reduce(state: FormState, action: Action): FormState {
  if (action.type === "edit") return { ...state, context: action.context, error: null };
  if (action.type === "submit") return { ...state, pending: true, error: null };
  return { ...state, pending: false, error: action.error };
}
export function ProfileHandoffModal({
  title,
  description,
  warning,
  confirmLabel = "Start successor",
  name,
  initialContext,
  onClose,
  onConfirm,
  destinationServerId,
  destinationProject,
  destinationDirectory,
  workspaceName,
  draft,
}: HandoffModalProps) {
  const [state, dispatch] = useReducer(reduce, {
    context: initialContext,
    pending: false,
    error: null,
  });
  const destinationClient = useHostRuntimeClient(destinationServerId ?? "");
  const connected = useHostRuntimeIsConnected(destinationServerId ?? "");
  const receipts = useHostFeature(destinationServerId, "workspaceRequestReceipts");
  const multiplicity = useHostFeature(destinationServerId, "workspaceMultiplicity");
  const membership = useHostFeature(destinationServerId, "workspaceProjectMembership");
  const canCreate = receipts && multiplicity && membership;
  const [destination, setDestination] = useState(() => ({
    directory: destinationDirectory ?? "",
    creationId: generateMessageId(),
  }));
  const { directory, creationId } = destination;
  const editDirectory = useCallback((nextDirectory: string) => {
    setDestination((current) =>
      current.directory === nextDirectory
        ? current
        : { directory: nextDirectory, creationId: generateMessageId() },
    );
  }, []);
  const contextReady = draft || Boolean(state.context.trim());
  const destinationReady =
    !destinationServerId ||
    Boolean(connected && destinationProject && directory.trim() && canCreate);
  const canSubmit = !state.pending && contextReady && destinationReady;
  const header = useMemo(() => ({ title: title ?? `Continue with ${name}` }), [title, name]);
  const edit = useCallback((context: string) => dispatch({ type: "edit", context }), []);
  const close = useCallback(() => {
    if (!state.pending) onClose();
  }, [state.pending, onClose]);
  const submit = useCallback(() => {
    if (!canSubmit) return;
    dispatch({ type: "submit" });
    void (async () => {
      let workspace: WorkspaceDescriptorPayload | undefined;
      if (destinationServerId) {
        if (!destinationClient) throw new Error("Reconnect to the destination environment");
        if (!destinationProject) throw new Error("Project not found.");
        workspace = await createDestinationWorkspace({
          client: destinationClient,
          project: destinationProject,
          directory: directory.trim(),
          title: workspaceName ?? "New workspace",
          idempotencyKey: creationId,
        });
      }
      await onConfirm(state.context, workspace);
    })().catch((error) => dispatch({ type: "error", error: toErrorMessage(error) }));
  }, [
    canSubmit,
    destinationClient,
    destinationServerId,
    destinationProject,
    directory,
    workspaceName,
    creationId,
    state.context,
    onConfirm,
  ]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="ghost" onPress={close} disabled={state.pending}>
          Cancel
        </Button>
        <Button onPress={submit} disabled={!canSubmit} testID="preset-handoff-confirm">
          {state.pending ? "Starting..." : confirmLabel}
        </Button>
      </View>
    ),
    [close, state.pending, submit, canSubmit, confirmLabel],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={640}
      footer={footer}
      testID="preset-handoff-modal"
    >
      <View style={styles.body}>
        <Text style={styles.text}>
          {description ??
            "Review and edit the handoff before starting a new task. The original stays unchanged. Stop its active workers first. The new chat uses the selected profile's permissions."}
        </Text>
        {warning ? (
          <Alert variant="warning" title="Incomplete handoff" description={warning} />
        ) : null}
        {destinationServerId ? (
          <View>
            <Text style={styles.text}>{destinationProject?.name}</Text>
            <Field label="Working directory">
              <FormTextInput
                initialValue={destinationDirectory}
                onChangeText={editDirectory}
                editable={!state.pending}
                testID="preset-destination-directory"
              />
            </Field>
          </View>
        ) : null}
        {!draft ? (
          <>
            <Text style={styles.text}>
              This partial record includes at most 30 recent text messages and excludes attachments
              and tool results. Add important decisions, changed files and test results here.
            </Text>
            <View style={styles.editor}>
              {/* Measure wrapped text so only the sheet body scrolls, including after deletions. */}
              <Text style={[styles.input, styles.measure]} aria-hidden accessible={false}>
                {state.context + "\n"}
              </Text>
              <AdaptiveTextInput
                initialValue={initialContext}
                onChangeText={edit}
                multiline
                scrollEnabled={false}
                maxLength={50_000}
                editable={!state.pending}
                style={[styles.input, styles.editorInput]}
                accessibilityLabel="Handoff context"
                testID="preset-handoff-context"
              />
            </View>
          </>
        ) : null}
        {state.error ? (
          <Text style={styles.text} accessibilityRole="alert">
            {state.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  editor: { minHeight: 220 },
  input: {
    padding: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    textAlignVertical: "top",
  },
  measure: { opacity: 0, pointerEvents: "none" },
  editorInput: { ...StyleSheet.absoluteFillObject, overflow: "hidden" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
