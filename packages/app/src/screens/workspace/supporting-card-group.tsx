import { StyleSheet } from "react-native-unistyles";
import { VORTON_HEADER_HEIGHT } from "@/constants/layout";
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { PortalHost } from "@gorhom/portal";
import { RetainedPanel } from "@/components/retained-panel";
import { CardColumn } from "@/agent-stream/columns/card-column";
import { CARD_GAP } from "@/agent-stream/columns/geometry";

/** Keep workspace panels at one React location when the focused conversation changes. */
export function SupportingCardGroup({
  visible,
  supportingVisible,
  hostName,
  style,
  children,
  renderHeader,
  resizeHandle,
}: {
  visible: boolean;
  supportingVisible: boolean;
  hostName: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  renderHeader?: () => ReactNode;
  resizeHandle?: ReactNode;
}) {
  return (
    <RetainedPanel active={visible} style={style} testID="workspace-supporting-cards">
      {renderHeader ? (
        <View style={styles.header} testID="workspace-supporting-toolbar">
          {renderHeader()}
        </View>
      ) : null}
      <View style={styles.body}>
        <CardColumn>
          <PortalHost name={hostName} />
          <RetainedPanel active={supportingVisible} style={supportingStyle}>
            {children}
          </RetainedPanel>
          <PortalHost name={`${hostName}:queue`} />
        </CardColumn>
      </View>
      {resizeHandle}
    </RetainedPanel>
  );
}

const styles = StyleSheet.create({
  header: {
    height: VORTON_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 0,
    flexShrink: 0,
  },
  body: { flex: 1, minHeight: 0 },
});

const supportingStyle = {
  flexGrow: 0,
  flexShrink: 0,
  flexBasis: "auto",
  gap: CARD_GAP,
} as const;
