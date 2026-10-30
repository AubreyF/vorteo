import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, Folder } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

export type SidebarDisclosure = "expand" | "collapse" | null;

// Matches the workspace title's line box, so the slot centers on the title like the workspace
// status slot does.
const LEADING_SLOT_HEIGHT = 20;

const ThemedFolder = withUnistyles(Folder);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The leading slot every sidebar container row shares: projects, folders, Standing and Factory.
 * It shows the row's icon at rest and swaps in the disclosure arrow while `revealChevron` is
 * true, which is pointer hover only: touch layouts keep the icon, and tapping the row still
 * folds it. A row without an icon keeps its arrow visible.
 */
export function SidebarLeadingSlot({
  chevron,
  revealChevron,
  children,
  testID,
}: {
  chevron: SidebarDisclosure;
  revealChevron: boolean;
  children: ReactNode;
  testID?: string;
}) {
  const hasIcon = children !== null && children !== undefined && children !== false;
  const showChevron = chevron !== null && (revealChevron || !hasIcon);
  return (
    <View style={styles.slot} testID={testID}>
      {showChevron ? <SidebarDisclosureChevron chevron={chevron} /> : children}
    </View>
  );
}

function SidebarDisclosureChevron({ chevron }: { chevron: "expand" | "collapse" }) {
  if (chevron === "collapse") {
    return <ChevronDown size={14} color="#9ca3af" />;
  }
  return <ChevronRight size={14} color="#9ca3af" />;
}

/** The folder glyph for folders, Standing and Factory: the workspace kind icon's size. */
export function SidebarFolderIcon() {
  return <ThemedFolder size={14} uniProps={mutedColorMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  slot: {
    width: theme.iconSize.md,
    height: LEADING_SLOT_HEIGHT,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));
