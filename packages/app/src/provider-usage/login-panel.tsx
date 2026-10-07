import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useProviderLogin } from "./use-provider-login";
import type { ProviderLoginState } from "@getpaseo/protocol/provider-login";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";

export function ProviderLoginPanel({
  serverId,
  providerId,
  name,
  provider = "codex",
}: {
  serverId: string | null;
  providerId: string;
  name: string;
  provider?: "codex" | "claude";
}) {
  const supported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerAccountLogin === true,
  );
  const claudeSupported = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.claudeAccountCreation === true,
  );
  const permissions = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.permissions,
  );
  const canManage = permissions?.includes("daemon.manage") !== false;
  if (!supported || (provider === "claude" && !claudeSupported))
    return <Text style={styles.text}>Update this host to connect accounts here.</Text>;
  if (!canManage)
    return (
      <Text style={styles.text}>
        This connection needs permission to manage the host before it can connect an account.
      </Text>
    );
  return (
    <LoginPanelContent
      serverId={serverId}
      providerId={providerId}
      name={name}
      provider={provider}
    />
  );
}

function LoginPanelContent({
  serverId,
  providerId,
  name,
  provider = "codex",
}: {
  serverId: string | null;
  providerId: string;
  name: string;
  provider?: "codex" | "claude";
}) {
  const login = useProviderLogin(serverId, providerId);
  const { state, connected } = login;
  const showRefresh = login.readFailed || login.actionFailed;
  return (
    <View style={styles.body} testID="provider-login-panel">
      <Text style={styles.text}>
        Sign in to the {provider === "claude" ? "Claude" : "ChatGPT"} account you want to use for{" "}
        {name}. Other account configurations and running tasks stay in place.
      </Text>
      {!connected ? (
        <Text style={styles.warning}>
          Host connection lost. The sign-in attempt stays on the host; reconnect to see its result.
        </Text>
      ) : null}
      {showRefresh ? (
        <>
          <Text style={styles.warning}>
            The request could not be confirmed. Refresh status to check whether it reached the host,
            then retry.
          </Text>
          <Button
            variant="outline"
            onPress={login.refresh}
            disabled={!connected || login.refreshing}
          >
            Refresh status
          </Button>
        </>
      ) : null}
      {state ? (
        <LoginProgress state={state} login={login} />
      ) : (
        <Text style={styles.text}>Loading sign-in status…</Text>
      )}
      <LoginAction login={login} />
      {state?.status !== "succeeded" ? (
        <Text style={styles.muted}>
          You can close this panel while signing in. Reopen the account connection panel to resume.
          A code lasts up to 15 minutes.
        </Text>
      ) : null}
    </View>
  );
}

function LoginAction({ login }: { login: ReturnType<typeof useProviderLogin> }) {
  const { state, connected, busy } = login;
  if (state?.status === "succeeded") return null;
  const active =
    state?.status === "starting" || state?.status === "waiting" || state?.status === "verifying";
  const canStart = Boolean(state && !login.readFailed);
  const retry = state?.status === "failed" || state?.status === "cancelled";
  return active ? (
    <Button
      variant="outline"
      onPress={login.cancel}
      disabled={busy || !connected}
      loading={login.actionPending}
    >
      Cancel sign-in
    </Button>
  ) : (
    <Button
      onPress={login.start}
      disabled={busy || !connected || !canStart}
      loading={login.actionPending}
    >
      {retry ? "Try sign-in again" : "Start sign-in"}
    </Button>
  );
}

function LoginProgress({
  state,
  login,
}: {
  state: ProviderLoginState;
  login: ReturnType<typeof useProviderLogin>;
}) {
  if (state.status === "waiting" && state.inputRequired)
    return <BrowserCodeChallenge key={state.attemptId} state={state} login={login} />;
  if (state.status === "waiting")
    return <DeviceCodeChallenge key={state.attemptId} state={state} />;
  let message = "Start sign-in to request a one-time code.";
  if (state.status === "starting") message = "Requesting your sign-in code…";
  if (state.status === "verifying") message = "Sign-in received. Checking the account…";
  if (state.status === "cancelled")
    message = "Sign-in cancelled. Your saved account credentials were not removed.";
  if (state.status === "failed") message = state.message;
  if (state.status === "succeeded")
    message = state.accountLabel
      ? `Signed in as ${state.accountLabel}. Your account credentials are saved. You can close this panel and use this account.`
      : "Sign-in completed. Your account credentials are saved. You can close this panel and use this account.";
  return (
    <Text accessibilityLiveRegion="polite" style={styles.text}>
      {message}
    </Text>
  );
}

function BrowserCodeChallenge({
  state,
  login,
}: {
  state: Extract<ProviderLoginState, { status: "waiting" }>;
  login: ReturnType<typeof useProviderLogin>;
}) {
  const [code, setCode] = useState("");
  const input = useRef<EditingTextInputHandle>(null);
  const { submitCode } = login;
  const [notice, setNotice] = useState<string | null>(null);
  const open = useCallback(async () => {
    try {
      await openExternalUrl(state.verificationUrl);
    } catch {
      setNotice("Could not open the browser. Copy the sign-in link below.");
    }
  }, [state.verificationUrl]);
  const submit = useCallback(async () => {
    try {
      await submitCode(code.trim());
      setCode("");
      input.current?.reset();
      setNotice("Code submitted. Waiting for Claude to confirm sign-in.");
    } catch {
      setNotice("Could not confirm code submission. Refresh status before trying again.");
    }
  }, [submitCode, code]);
  return (
    <View style={styles.body} testID="claude-browser-login">
      <Text style={styles.text}>
        Open Claude sign-in in your browser. If Claude gives you a code, paste it here to finish
        connecting this account.
      </Text>
      <Button onPress={open}>Open Claude sign-in</Button>
      <Text selectable style={styles.muted}>
        {state.verificationUrl}
      </Text>
      <Field label="Sign-in code">
        <FormTextInput
          ref={input}
          initialValue=""
          onChangeText={setCode}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Sign-in code"
          testID="claude-login-code"
        />
      </Field>
      <Button
        onPress={submit}
        disabled={!code.trim() || login.busy || !login.connected}
        loading={login.actionPending}
      >
        Complete sign-in
      </Button>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function DeviceCodeChallenge({
  state,
}: {
  state: Extract<ProviderLoginState, { status: "waiting" }>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<"copy" | "open" | null>(null);
  const copy = useCallback(async () => {
    setPending("copy");
    try {
      await copyToClipboard(state.userCode);
      setNotice("Code copied.");
    } catch {
      setNotice("Could not copy the code. Select the code above and copy it manually.");
    } finally {
      setPending(null);
    }
  }, [state.userCode]);
  const open = useCallback(async () => {
    setPending("open");
    try {
      await openExternalUrl(state.verificationUrl);
      setNotice(
        "Complete sign-in in the browser, then return here. If the page did not open, use the URL shown above.",
      );
    } catch {
      setNotice("Could not open the sign-in page. Open the URL shown above in your browser.");
    } finally {
      setPending(null);
    }
  }, [state.verificationUrl]);
  return (
    <View style={styles.body}>
      <Text style={styles.text}>1. Copy this one-time code.</Text>
      <Text style={styles.muted}>Expires by {new Date(state.expiresAt).toLocaleTimeString()}</Text>
      <Text selectable style={styles.code} testID="provider-login-code">
        {state.userCode}
      </Text>
      <Button
        variant="outline"
        onPress={copy}
        disabled={pending !== null}
        loading={pending === "copy"}
      >
        Copy code
      </Button>
      <Text style={styles.text}>
        2. Open the sign-in page, enter the code, and sign in to the intended account.
      </Text>
      <Text selectable style={styles.muted}>
        {state.verificationUrl}
      </Text>
      <Button onPress={open} disabled={pending !== null} loading={pending === "open"}>
        Open sign-in page
      </Button>
      <Text style={styles.text}>
        3. Return here. This panel will confirm when sign-in completes.
      </Text>
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  warning: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
}));
