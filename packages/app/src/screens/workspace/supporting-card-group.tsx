import { PanePortal } from "@/panels/pane-context";
import { cardGridGroupStyle } from "@/agent-stream/card-grid";
import { useSidebarSpacing } from "@/styles/sidebar-spacing";
import { StyleSheet } from "react-native-unistyles";
import { VORTON_HEADER_HEIGHT } from "@/constants/layout";
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { PortalHost } from "@gorhom/portal";
import { RetainedPanel } from "@/components/retained-panel";
import { CardColumn } from "@/agent-stream/columns/card-column";

/** Keep workspace panels at one React location when the focused conversation changes. */
export function SupportingCardGroup({
  visible,
  inline = false,
  supportingVisible,
  hostName,
  style,
  children,
  renderHeader,
  resizeHandle,
}: {
  visible: boolean;
  inline?: boolean;
  supportingVisible: boolean;
  hostName: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  renderHeader?: () => ReactNode;
  resizeHandle?: ReactNode;
}) {
  const { headerHeight } = useSidebarSpacing();
  const supportingHost = `${hostName}${inline ? ":inline-cards" : ""}:supporting`;
  return (
    <>
      <PanePortal key={supportingHost} hostName={supportingHost}>
        <RetainedPanel active={supportingVisible} style={cardGridGroupStyle}>
          {children}
        </RetainedPanel>
      </PanePortal>
      <RetainedPanel active={visible} style={style} testID="workspace-supporting-cards">
        {renderHeader ? (
          <View
            style={[styles.header, { height: headerHeight }]}
            testID="workspace-supporting-toolbar"
          >
            {renderHeader()}
          </View>
        ) : null}
        <View style={styles.body}>
          <CardColumn>
            <PortalHost name={hostName} />
            <PortalHost name={`${hostName}:supporting`} />
            <PortalHost name={`${hostName}:queue`} />
          </CardColumn>
          {resizeHandle}
        </View>
      </RetainedPanel>
    </>
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
