import type { ProviderCliUpdate } from "@getpaseo/protocol/messages";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { useVortonMode } from "@/vorton-mode";

export function CliUpdateWarning({ update }: { update: ProviderCliUpdate | undefined }) {
  const vortonMode = useVortonMode();
  if (!vortonMode || !update) return null;
  return (
    <Alert variant="warning" title={`${update.cli} update needed`} testID="provider-cli-update">
      <View style={styles.content}>
        <Text style={styles.text}>
          This environment has {update.cli} {update.installedVersion}. These models need a newer
          CLI:
        </Text>
        {update.affectedModels.map((model) => (
          <Text key={model.id} style={styles.text}>
            {model.label}: {model.minimumVersion} or later
          </Text>
        ))}
        <Text selectable style={styles.text}>
          {update.instructions}
        </Text>
      </View>
    </Alert>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { flex: 1, minWidth: 0, gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
