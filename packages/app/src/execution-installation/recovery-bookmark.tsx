import React, { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { InstallationRecoveryAccessStatus } from "@getpaseo/protocol/installation-enrollment";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { isWeb } from "@/constants/platform";
import { useVortonTouch } from "@/vorton-touch";

interface RecoveryBookmarkProps {
  status: InstallationRecoveryAccessStatus | null;
  error: string | null;
  refreshing: boolean;
  onRefresh(): void;
  open?: (url: string) => Promise<unknown>;
  copy?: (url: string) => Promise<boolean>;
}
type BookmarkAction =
  | { status: "idle" }
  | { status: "pending"; action: "open" | "copy" }
  | { status: "success" | "error"; message: string };

async function copyBookmark(url: string): Promise<boolean> {
  if (isWeb) {
    await navigator.clipboard.writeText(url);
    return true;
  }
  const clipboard = await import("expo-clipboard");
  return clipboard.setStringAsync(url);
}

export function RecoveryBookmark({
  status,
  error,
  refreshing,
  onRefresh,
  open = Linking.openURL,
  copy = copyBookmark,
}: RecoveryBookmarkProps) {
  const touch = useVortonTouch();
  const generation = useRef(0);
  const [now, setNow] = useState(Date.now);
  const [action, setAction] = useState<BookmarkAction>({ status: "idle" });
  useEffect(() => {
    generation.current++;
    setNow(Date.now());
    setAction({ status: "idle" });
    if (status?.status !== "verified") return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(status.validUntil) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [status, error]);
  const url = error ? null : currentRecoveryBookmark(status, now);
  const run = useCallback(
    async (kind: "open" | "copy") => {
      const current = currentRecoveryBookmark(status, Date.now());
      if (!url || !current || action.status === "pending") return;
      const epoch = generation.current;
      setAction({ status: "pending", action: kind });
      try {
        if (kind === "open") await open(current);
        else if (!(await copy(current))) throw new Error("Clipboard refused");
        let message = "Recovery address copied. Save it as a browser bookmark.";
        if (kind === "open") message = "Recovery page opened. Bookmark it in your browser.";
        if (generation.current === epoch) setAction({ status: "success", message });
      } catch {
        let message = "Unable to copy. Select the address below and copy it manually.";
        if (kind === "open")
          message = "Unable to open recovery. Copy the address and open it in your browser.";
        if (generation.current === epoch) setAction({ status: "error", message });
      }
    },
    [url, status, action.status, open, copy],
  );
  const openRecovery = useCallback(() => void run("open"), [run]);
  const copyRecovery = useCallback(() => void run("copy"), [run]);
  // Older coordinators have no discovery endpoint. Do not invent an address.
  if (!status && !error && !refreshing) return null;
  return (
    <View style={styles.section} testID="installation-recovery-bookmark">
      <Text style={settingsStyles.rowTitle}>Independent recovery</Text>
      <Text style={settingsStyles.rowHint}>
        Bookmark the recovery page once this installation verifies its address. A verified page uses
        your installation owner password to review compatible coordinator rollback when the main
        interface is unavailable, even if basic health is green. Tailscale and this machine must
        remain available.
      </Text>
      {url ? (
        <Text selectable style={settingsStyles.rowHint}>
          {url}
        </Text>
      ) : (
        <Text style={settingsStyles.rowHint}>
          The installed recovery page and private route have not been verified. Refresh after setup
          to check the bookmark.
        </Text>
      )}
      {error ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {error}
        </Text>
      ) : null}
      {action.status === "success" || action.status === "error" ? (
        <Text
          accessibilityRole={action.status === "error" ? "alert" : "text"}
          style={settingsStyles.rowHint}
        >
          {action.message}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {url ? (
          <>
            <Button
              variant="outline"
              size={touch ? "md" : "sm"}
              disabled={action.status === "pending"}
              onPress={openRecovery}
            >
              Open recovery
            </Button>
            <Button
              variant="outline"
              size={touch ? "md" : "sm"}
              disabled={action.status === "pending"}
              onPress={copyRecovery}
            >
              Copy address
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size={touch ? "md" : "sm"}
          loading={refreshing}
          disabled={refreshing}
          onPress={onRefresh}
        >
          Refresh recovery address
        </Button>
      </View>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: { padding: theme.spacing[4], gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

function currentRecoveryBookmark(
  status: InstallationRecoveryAccessStatus | null,
  now: number,
): string | null {
  if (status?.status !== "verified") return null;
  const checkedAt = Date.parse(status.checkedAt);
  const validUntil = Date.parse(status.validUntil);
  const bounded = validUntil > checkedAt && validUntil <= checkedAt + 30_000;
  if (!bounded || now < checkedAt || now >= validUntil) return null;
  return status.url;
}
