import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { profileDetails } from "./profile-details";

export function ProfileDetailsView({
  serverId,
  profile,
  compact = false,
}: {
  serverId: string | null;
  profile: AgentProfile;
  compact?: boolean;
}) {
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const allSections = profileDetails(
    profile,
    entries?.find((entry) => entry.provider === profile.provider),
  );
  const sections = compact
    ? allSections.filter((section) => {
        if (section.title === "Saved profile permissions") return true;
        if (section.title === "Features")
          return Object.keys(profile.featureValues ?? {}).length > 0;
        if (section.title === "When to use") return Boolean(profile.notes?.trim());
        return false;
      })
    : allSections;
  return (
    <View testID="profile-customization-details" style={styles.sections}>
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.label}>{section.title}</Text>
          <View style={compact && styles.content}>
            {compact && section.title === "Saved profile permissions" ? (
              <>
                <Text style={[styles.text, styles.permissionName]} selectable>
                  {section.text.split("\n")[0]}
                </Text>
                <Text style={styles.description} selectable>
                  {section.text.split("\n").slice(1).join("\n")}
                </Text>
              </>
            ) : (
              <Text style={styles.text} selectable>
                {section.text}
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  sections: { gap: theme.spacing[4] },
  section: { gap: theme.spacing[2] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  content: { paddingHorizontal: theme.spacing[3], gap: theme.spacing[1] },
  permissionName: { fontWeight: theme.fontWeight.medium },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.ceil(theme.fontSize.sm * 1.5),
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.5),
  },
}));
