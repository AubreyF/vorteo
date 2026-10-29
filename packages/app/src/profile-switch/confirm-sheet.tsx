import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ActionFooter } from "@/components/ui/action-footer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";

interface ProfileSwitchSheetProps {
  profileName: string;
  /** Resolves once the daemon accepts the switch; the owner then closes the sheet. */
  onSwitch: () => Promise<void>;
  onNewTask?: () => void;
  onClose: () => void;
}

type SwitchState = { status: "idle" } | { status: "pending" } | { status: "failed"; error: string };

/** Confirms moving the current thread to another account instead of starting a successor task. */
export function ProfileSwitchSheet({
  profileName,
  onSwitch,
  onNewTask,
  onClose,
}: ProfileSwitchSheetProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<SwitchState>({ status: "idle" });
  const pending = state.status === "pending";
  const header = useMemo(
    () => ({ title: t("message.profileSwitch.confirm.title", { name: profileName }) }),
    [t, profileName],
  );
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);
  const startNewTask = useCallback(() => {
    if (!pending) onNewTask?.();
  }, [pending, onNewTask]);
  const submit = useCallback(() => {
    if (pending) return;
    setState({ status: "pending" });
    onSwitch().catch((error: unknown) =>
      setState({ status: "failed", error: toErrorMessage(error) }),
    );
  }, [pending, onSwitch]);
  const footer = useMemo(
    () => (
      <ActionFooter style={styles.actions}>
        <Button variant="ghost" onPress={close} disabled={pending}>
          {t("common.actions.cancel")}
        </Button>
        {onNewTask ? (
          <Button
            variant="outline"
            onPress={startNewTask}
            disabled={pending}
            testID="profile-switch-new-task"
          >
            {t("message.profileSwitch.confirm.newTask")}
          </Button>
        ) : null}
        <Button onPress={submit} loading={pending} testID="profile-switch-confirm">
          {pending
            ? t("message.profileSwitch.confirm.switching")
            : t("message.profileSwitch.confirm.switch")}
        </Button>
      </ActionFooter>
    ),
    [close, startNewTask, submit, pending, t, onNewTask],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={560}
      footer={footer}
      testID="profile-switch-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.text}>{t("message.profileSwitch.confirm.warning")}</Text>
        {state.status === "failed" ? (
          <Alert variant="error" description={state.error} testID="profile-switch-error" />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
