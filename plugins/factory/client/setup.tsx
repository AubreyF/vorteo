import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { FactorySetupObservationState } from "./observation.js";

interface SetupProps {
  state: FactorySetupObservationState;
  theme: PluginHostProps["theme"];
  onRetry?: () => void;
  pending?: boolean;
}

const labels = {
  ready: "Setup ready",
  installed: "Installation observed",
  held: "Installation held",
  unavailable: "Setup unavailable",
};

export function FactorySetupStatus({ state, theme, onRetry, pending = false }: SetupProps) {
  const { colors } = theme;
  const styles = useMemo(
    () =>
      StyleSheet.create({
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
      }),
    [colors],
  );
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
        <Text style={styles.muted}>
          Installation and lifecycle actions are unavailable in this client.
        </Text>
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
