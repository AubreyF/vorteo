import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { FactorySetupObservationState } from "./observation.js";
import type { FactoryInstallationState } from "./installation.js";

interface SetupProps {
  state: FactorySetupObservationState;
  theme: PluginHostProps["theme"];
  onRetry?: () => void;
  pending?: boolean;
  installation?: FactoryInstallationState;
  onInstall?: () => void;
}

const labels = {
  ready: "Setup ready",
  installed: "Installation observed",
  held: "Installation held",
  unavailable: "Setup unavailable",
};

function installationMessage(installation: FactoryInstallationState): string {
  switch (installation.kind) {
    case "idle":
      return "";
    case "checking":
      return "Verifying fresh native setup...";
    case "dispatching":
      return "Installation pending. Do not repeat this request.";
    case "applied":
      return "Installation verified by the selected runtime.";
    case "refused":
    case "uncertain":
      return installation.reason;
  }
}

function installationActionLabel(installation?: FactoryInstallationState): string {
  switch (installation?.kind) {
    case "checking":
    case "dispatching":
      return "Installing Factory...";
    case "uncertain":
      return "Installation held for reconciliation";
    case "applied":
      return "Factory installed";
    default:
      return "Install Factory";
  }
}

function createSetupStyles(colors: PluginHostProps["theme"]["colors"]) {
  return StyleSheet.create({
    root: { gap: 8 },
    heading: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
    card: {
      padding: 14,
      gap: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
    },
    text: { color: colors.foreground, fontSize: 14 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    warning: { color: colors.statusWarning, fontSize: 13, lineHeight: 19 },
    error: { color: colors.statusDanger, fontSize: 13, lineHeight: 19 },
    retry: { minHeight: 44, justifyContent: "center" },
    link: { color: colors.accent, fontSize: 13 },
  });
}

function InstallationControls({
  state,
  installation,
  onInstall,
  pending,
  styles,
}: Pick<SetupProps, "state" | "installation" | "onInstall" | "pending"> & {
  styles: ReturnType<typeof createSetupStyles>;
}) {
  const installing = installation?.kind === "checking" || installation?.kind === "dispatching";
  const blocked =
    installing || installation?.kind === "uncertain" || installation?.kind === "applied";
  const installable =
    state.kind === "observed" &&
    !state.retained &&
    state.setup.state === "ready" &&
    state.setup.operations.install &&
    onInstall;
  return (
    <>
      {installation && installation.kind !== "idle" ? (
        <View style={styles.root}>
          <Text selectable style={styles.muted}>
            Operation {installation.operationId}
          </Text>
          <Text style={installation.kind === "uncertain" ? styles.warning : styles.muted}>
            {installationMessage(installation)}
          </Text>
        </View>
      ) : null}
      {installable ? (
        <Pressable
          accessibilityRole="button"
          onPress={onInstall}
          disabled={blocked || pending}
          style={styles.retry}
        >
          <Text style={blocked ? styles.muted : styles.link}>
            {installationActionLabel(installation)}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.muted}>Installation is unavailable for this setup.</Text>
      )}
    </>
  );
}

export function FactorySetupStatus({
  state,
  theme,
  onRetry,
  pending = false,
  installation,
  onInstall,
}: SetupProps) {
  const { colors } = theme;
  const styles = useMemo(() => createSetupStyles(colors), [colors]);
  let detail: ReactNode;
  if (state.kind === "observed") {
    const { setup, retained } = state;
    const observed =
      setup.observedAt === null
        ? "Setup observation time unavailable"
        : `Observed ${setup.observedAt}`;
    detail = (
      <>
        {retained ? (
          <Text style={styles.warning}>
            Setup observation unavailable. Showing the last descriptor from this host and project.
            Current installation could not be verified.
          </Text>
        ) : null}
        <Text style={styles.text}>{labels[setup.state]}</Text>
        {setup.reason ? <Text style={styles.muted}>{setup.reason}</Text> : null}
        {setup.installationId ? (
          <Text style={styles.muted}>Installation ...{setup.installationId.slice(-8)}</Text>
        ) : null}
        <Text style={styles.muted}>{observed}</Text>
      </>
    );
  } else if (state.kind === "identity_mismatch") {
    detail = (
      <Text style={styles.error}>Setup identity does not match the selected host and project.</Text>
    );
  } else if (state.kind === "identity_unavailable") {
    detail = <Text style={styles.muted}>Waiting for the selected workspace project identity.</Text>;
  } else if (state.kind === "loading") {
    detail = <Text style={styles.muted}>Reading native Factory setup...</Text>;
  } else {
    detail = (
      <Text style={styles.muted}>
        Setup observation unavailable. The selected runtime could not provide a setup descriptor.
      </Text>
    );
  }
  const retained = state.kind === "observed" && state.retained;
  const retryable = state.kind === "unavailable" || retained;
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>Factory setup</Text>
      <View style={styles.card}>
        {detail}
        <InstallationControls
          state={state}
          installation={installation}
          onInstall={onInstall}
          pending={pending}
          styles={styles}
        />
        {retryable && onRetry ? (
          <Pressable
            accessibilityRole="button"
            onPress={onRetry}
            disabled={pending}
            style={styles.retry}
          >
            <Text style={styles.link}>
              {pending ? "Retrying setup..." : "Retry setup observation"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
