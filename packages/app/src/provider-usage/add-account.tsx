import { createSharedAccountDefinition } from "@/execution-installation/account-creation";
import { requestInstallationSettings } from "@/execution-installation/settings";
import { readExecutionInstallation } from "@/execution-installation/policy";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { refreshAndApplyProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { daemonConfigQueryKey } from "@/data/daemon-config";

import { ProviderLoginPanel } from "./login-panel";
import { openAccountForm, suggestedAccountName, type CreatedCodexAccount } from "./account-form";

interface AddAccountProps {
  serverId: string;
  provider: "codex" | "claude";
  onCreated?: (account: CreatedCodexAccount) => void;
}
type AccountButtonProps = Omit<AddAccountProps, "provider"> & {
  catalog?: boolean;
  style?: StyleProp<ViewStyle>;
};
export function AddCodexAccountButton(props: AccountButtonProps) {
  return <AddAccountButton {...props} provider="codex" />;
}
export function AddClaudeAccountButton(props: AccountButtonProps) {
  return <AddAccountButton {...props} provider="claude" />;
}

function AddAccountButton({
  catalog = false,
  style,
  ...props
}: AddAccountProps & { catalog?: boolean; style?: StyleProp<ViewStyle> }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Button
        variant={catalog ? "default" : "outline"}
        size={catalog ? "sm" : "md"}
        style={style}
        onPress={show}
        testID={`add-${props.provider}-account`}
      >
        {catalog ? "Add" : `Add ${props.provider === "claude" ? "Claude" : "Codex"} account`}
      </Button>
      {open ? <AccountSheet key={props.serverId} {...props} onClose={close} /> : null}
    </>
  );
}

function AccountSheet({ onClose, ...props }: AddAccountProps & { onClose: () => void }) {
  const { config } = useDaemonConfig(props.serverId);
  const header = useMemo(
    () => ({ title: `Add ${props.provider === "claude" ? "Claude" : "Codex"} account` }),
    [props.provider],
  );
  const supported = useHostFeature(
    props.serverId,
    props.provider === "claude" ? "claudeAccountCreation" : "codexAccountCreation",
  );
  const permissions = useSessionStore(
    (state) => state.sessions[props.serverId]?.serverInfo?.permissions,
  );
  const canManage = permissions?.includes("daemon.manage") !== false;
  const renderSheet = useCallback(
    (body: ReactNode, footer: ReactNode) => (
      <AdaptiveModalSheet
        visible
        header={header}
        onClose={onClose}
        desktopMaxWidth={520}
        testID={`add-${props.provider}-account-dialog`}
        footer={footer}
      >
        <View style={styles.body}>{body}</View>
      </AdaptiveModalSheet>
    ),
    [header, onClose, props.provider],
  );
  let message: string | null = null;
  if (!supported) message = "Update this host to add accounts here.";
  else if (!canManage)
    message = "This connection needs permission to manage the host before it can add an account.";
  if (!message && config) {
    return (
      <AccountForm
        {...props}
        initialName={suggestedAccountName(config.providers, props.provider)}
        onClose={onClose}
        renderSheet={renderSheet}
      />
    );
  }
  return renderSheet(<Text style={styles.text}>{message ?? "Loading accounts..."}</Text>, null);
}

function useAccountForm({
  serverId,
  onCreated,
  initialName,
  provider,
}: AddAccountProps & { initialName: string }) {
  const client = useHostRuntimeClient(serverId);
  const cache = useQueryClient();
  const live = useRef({ client, onCreated });
  live.current = { client, onCreated };
  const [model] = useState(() =>
    openAccountForm(globalThis.crypto.randomUUID(), {
      initialName,
      async create(creationId, name) {
        const current = live.current.client;
        if (!current) throw new Error("Reconnect to the host and try again.");
        const installation = readExecutionInstallation();
        if (installation?.environments.some((environment) => environment.serverId === serverId)) {
          const shared = await createSharedAccountDefinition(
            {
              creationId,
              name,
              provider,
              serverIds: installation.environments.map((environment) => environment.serverId),
            },
            { read: () => requestInstallationSettings(), save: requestInstallationSettings },
          );
          name = shared.name;
          await cache.invalidateQueries({
            queryKey: ["installation-settings", installation.installationId],
          });
        }
        const account =
          provider === "claude"
            ? await current.createClaudeAccount(creationId, name)
            : await current.createCodexAccount(creationId, name);
        await cache.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
        await refreshAndApplyProvidersSnapshot({
          client: current,
          queryClient: cache,
          serverId,
          cwd: null,
          providers: [account.providerId],
        });
        return account;
      },
      created(account) {
        live.current.onCreated?.(account);
      },
    }),
  );
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState, model.getState) };
}

function AccountForm({
  onClose,
  renderSheet,
  ...props
}: AddAccountProps & {
  onClose: () => void;
  initialName: string;
  renderSheet: (body: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const { model, state } = useAccountForm(props);
  const connected = useHostRuntimeIsConnected(props.serverId);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  if (state.phase === "created")
    return renderSheet(
      <>
        <Text style={styles.text}>{state.account.name} added.</Text>
        {readExecutionInstallation() ? (
          <Text style={styles.text}>
            {props.provider === "claude"
              ? "Sign in once below. This Claude connection is shared by Host and Dev, unless you exclude an environment."
              : "Shared across environments. Sign in below for this environment; other environments show their own sign-in status."}
          </Text>
        ) : null}
        <ProviderLoginPanel
          serverId={props.serverId}
          providerId={state.account.providerId}
          name={state.account.name}
          provider={props.provider}
        />
      </>,
      <Button variant="outline" onPress={onClose} testID={`${props.provider}-account-done`}>
        Done
      </Button>,
    );
  const creating = state.phase === "creating";
  return renderSheet(
    <>
      <Field label="Account name">
        <FormTextInput
          initialValue={state.name}
          onChangeText={model.setName}
          editable={!creating}
          size={size}
          accessibilityLabel="Account name"
          testID={`${props.provider}-account-name`}
        />
      </Field>
      {state.error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {state.error}
        </Text>
      ) : null}
      {!connected ? (
        <Text style={styles.error}>Reconnect to the host to add this account.</Text>
      ) : null}
    </>,
    <Button
      onPress={model.submit}
      disabled={creating || !connected}
      loading={creating}
      testID={`${props.provider}-account-create`}
    >
      Create account
    </Button>,
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
