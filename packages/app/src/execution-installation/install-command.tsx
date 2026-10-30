import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

/**
 * The one command that creates an installation, upgrades one, or wraps a container-only
 * installation into the Host architecture. The address redirects to the latest tested release.
 */
export const VORTEO_INSTALL_COMMAND =
  "curl -fsSL https://github.com/terran-labs/vorteo/releases/latest/download/install.sh | bash";

/** The install command as selectable text with a copy button. */
export function InstallCommand({
  testID = "install-command",
  copy = copyToClipboard,
}: {
  testID?: string;
  copy?: (text: string) => Promise<unknown>;
}) {
  const [notice, setNotice] = useState<"copied" | "failed" | null>(null);
  const copyCommand = useCallback(async () => {
    try {
      await copy(VORTEO_INSTALL_COMMAND);
      setNotice("copied");
    } catch {
      setNotice("failed");
    }
  }, [copy]);
  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.command}>
        <Text selectable style={styles.code} testID={`${testID}-text`}>
          {VORTEO_INSTALL_COMMAND}
        </Text>
      </View>
      <View style={styles.footer}>
        <Button variant="outline" size="sm" onPress={copyCommand} testID={`${testID}-copy`}>
          {notice === "copied" ? "Copied" : "Copy command"}
        </Button>
        {notice === "failed" ? (
          <Text accessibilityRole="alert" style={styles.error}>
            Could not copy. Select the command above and copy it manually.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  command: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
