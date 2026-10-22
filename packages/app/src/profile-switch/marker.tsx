import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { ProfileSwitchItem } from "@/types/stream";
import { profileSwitchEndpointLabel } from "./label";

interface ProfileSwitchMarkerProps {
  item: ProfileSwitchItem;
  serverId: string;
}

/** Divider where a thread moved to another account and started a new native session. */
export const ProfileSwitchMarker = memo(function ProfileSwitchMarker({
  item,
  serverId,
}: ProfileSwitchMarkerProps) {
  const { t } = useTranslation();
  // Account labels come from the host-wide catalog the profile picker reads.
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const labels = {
    from: profileSwitchEndpointLabel(item.from, entries),
    to: profileSwitchEndpointLabel(item.to, entries),
  };
  const label =
    item.reason === "quota"
      ? t("message.profileSwitch.captionQuota", labels)
      : t("message.profileSwitch.caption", labels);
  return (
    <View style={styles.container} testID="profile-switch-marker">
      <View style={styles.marker}>
        <View style={styles.line} />
        <Button
          variant="ghost"
          size="md"
          leftIcon={expanded ? ChevronDown : ChevronRight}
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          onPress={toggle}
          style={styles.trigger}
          textStyle={styles.triggerText}
        >
          {label}
        </Button>
        <View style={styles.line} />
      </View>
      {expanded ? <ProfileSwitchDetail item={item} /> : null}
    </View>
  );
});

function ProfileSwitchDetail({ item }: { item: ProfileSwitchItem }) {
  const { t } = useTranslation();
  return (
    <View style={styles.detail} testID="profile-switch-detail">
      <Text style={styles.metadata}>{item.timestamp.toLocaleString()}</Text>
      {item.from.profileName ? (
        <Text style={styles.metadata}>
          {t("message.profileSwitch.fromProfile", { name: item.from.profileName })}
        </Text>
      ) : null}
      {item.to.profileName ? (
        <Text style={styles.metadata}>
          {t("message.profileSwitch.toProfile", { name: item.to.profileName })}
        </Text>
      ) : null}
      <Text style={styles.metadata}>
        {t("message.profileSwitch.carriedContext", {
          chars: item.carriedContextChars.toLocaleString(),
        })}
      </Text>
    </View>
  );
}

// Matches the compaction marker so both session boundaries read the same way.
const styles = StyleSheet.create((theme) => ({
  container: { paddingVertical: theme.spacing[3], paddingHorizontal: theme.spacing[4] },
  marker: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  line: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  trigger: { flexShrink: 1 },
  triggerText: { flexShrink: 1, color: theme.colors.foregroundMuted },
  detail: { gap: theme.spacing[2], paddingTop: theme.spacing[3] },
  metadata: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
