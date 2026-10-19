import { useCallback, type ReactElement } from "react";
import { View, Pressable, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Factory, LockKeyhole, Repeat2, CirclePause } from "lucide-react-native";
import { router } from "expo-router";
import { useVortonTouch } from "@/vorton-touch";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipText } from "@/components/ui/tooltip";
import { useWorkspaceScheduleState } from "./scheduled";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import { FACTORY_MANAGED_EXPLANATION, useFactoryMembership } from "./factory-membership";

const Shield = withUnistyles(LockKeyhole);
const Repeat = withUnistyles(Repeat2);
const Paused = withUnistyles(CirclePause);
const FactoryIcon = withUnistyles(Factory);
const neutral = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const shield = <Shield size={16} uniProps={neutral} />;
const repeat = <Repeat size={16} uniProps={neutral} />;
const paused = <Paused size={16} uniProps={neutral} />;
function FactoryIndicator({ workspaceId }: { workspaceId: string }) {
  return (
    <IndicatorTooltip label={FACTORY_MANAGED_EXPLANATION}>
      <View
        tabIndex={0}
        style={styles.badgeSlot}
        accessible
        accessibilityLabel={FACTORY_MANAGED_EXPLANATION}
        testID={`workspace-factory-${workspaceId}`}
      >
        <FactoryIcon size={16} uniProps={neutral} />
      </View>
    </IndicatorTooltip>
  );
}

export function WorkspaceLifecycleIndicators({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const touch = useVortonTouch();
  const scheduled = useWorkspaceScheduleState(workspace.serverId, workspace.workspaceId);
  const membership = useFactoryMembership(workspace.serverId, workspace.workspaceId);
  const factory = Boolean(membership);
  const label = scheduled === "paused" ? "Paused" : "Scheduled";
  const openSchedules = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      router.push({
        pathname: "/schedules",
        params: {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
        },
      });
    },
    [workspace.serverId, workspace.workspaceId],
  );
  if (!scheduled && !workspace.protected && !factory) return null;
  return (
    <>
      {workspace.protected ? (
        <IndicatorTooltip label="Protected">
          <View
            style={styles.badgeSlot}
            accessible
            accessibilityLabel="Protected workspace"
            testID={`workspace-shield-${workspace.workspaceId}`}
            tabIndex={0}
          >
            {shield}
          </View>
        </IndicatorTooltip>
      ) : null}
      {factory ? <FactoryIndicator workspaceId={workspace.workspaceId} /> : null}
      {scheduled ? (
        <IndicatorTooltip label={label}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} workspace. Open schedules`}
            style={[styles.badgeSlot, touch && styles.touchTarget]}
            testID={`workspace-scheduled-${workspace.workspaceId}`}
            onPress={openSchedules}
          >
            {scheduled === "paused" ? paused : repeat}
          </Pressable>
        </IndicatorTooltip>
      ) : null}
    </>
  );
}
function IndicatorTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        <TooltipText label={label} />
      </TooltipContent>
    </Tooltip>
  );
}
const styles = StyleSheet.create({
  badgeSlot: {
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  // Keep the visual badge compact inside a full-height touch target.
  touchTarget: { minHeight: 44, justifyContent: "center" },
});
