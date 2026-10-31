import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { InstallCommand } from "@/execution-installation/install-command";
import { settingsStyles } from "@/styles/settings";

/**
 * Shown instead of the update task on a container-only installation. A container cannot
 * install its own Host, so the owner runs the installer on the computer that runs Docker.
 */
export function LegacyInstallationCard({ copy }: { copy?: (text: string) => Promise<unknown> }) {
  return (
    <View style={styles.card} testID="vorton-legacy-installation">
      <Text style={settingsStyles.rowTitle}>Add a Host to update this installation</Text>
      <Text style={settingsStyles.rowHint}>
        This installation predates Host environments, so it cannot update itself from here. Run this
        command on the computer that runs Docker:
      </Text>
      <InstallCommand testID="vorton-legacy-install-command" copy={copy} />
      <Text style={settingsStyles.rowHint}>
        It keeps this Dev environment, its agents and files, and adds the Host that installs future
        updates from this page.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));
