import { useCallback } from "react";
import { Pressable, Text, type GestureResponderEvent } from "react-native";
import { Globe, ExternalLink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";

import { resolveWorkspaceScriptLink } from "@/utils/workspace-script-links";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedGlobe = withUnistyles(Globe);
const ThemedExternalLink = withUnistyles(ExternalLink);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
function rowStyle({ hovered }: { hovered?: boolean }) {
  return [styles.row, hovered && styles.hovered];
}

export function WorkspacePreviewRows({ scripts }: { scripts: WorkspaceScriptPayload[] }) {
  return (
    <>
      {scripts.map((script) => (
        <WorkspacePreviewRow key={script.scriptName} script={script} />
      ))}
    </>
  );
}

function WorkspacePreviewRow({ script }: { script: WorkspaceScriptPayload }) {
  const target = resolveWorkspaceScriptLink({ script, activeConnection: null }).targets.find(
    (link) => link.kind === "public",
  );
  const url = target?.url;
  const onPress = useCallback(
    (event: GestureResponderEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (url) void openExternalUrl(url);
    },
    [url],
  );
  const webLinkProps = isWeb
    ? { href: url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } }
    : {};
  if (!target) return null;
  return (
    <Pressable
      {...webLinkProps}
      testID={`hover-card-preview-${script.scriptName}`}
      accessibilityRole="link"
      accessibilityLabel={`${script.scriptName}: ${target.url}`}
      onPress={onPress}
      style={rowStyle}
    >
      <ThemedGlobe
        size={12}
        uniProps={script.health === "unhealthy" ? dangerColorMapping : successColorMapping}
      />
      <Text style={styles.text} numberOfLines={1}>
        {script.scriptName}: {target.label}
      </Text>
      <ThemedExternalLink size={12} uniProps={foregroundMutedColorMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  hovered: { backgroundColor: theme.colors.surface2 },
  text: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));
