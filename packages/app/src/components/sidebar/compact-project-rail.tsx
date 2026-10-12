import { ProjectRailPreview } from "./project-rail-preview";
import { memo, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus, Settings } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useSidebarProjectStatusBucket,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";

interface CompactProjectRailProps {
  header: ReactNode;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projects: SidebarProjectEntry[];
  onSelectProject: (key: string) => void;
  onExpand: () => void;
  onAddProject: () => void;
  onSettings: () => void;
}

const ProjectRailItem = memo(function ProjectRailItem({
  project,
  workspaceEntries,
  onSelect,
}: {
  project: SidebarProjectEntry;
  workspaceEntries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  onSelect: (key: string) => void;
}) {
  const bucket = useSidebarProjectStatusBucket({ workspaces: project.workspaces, enabled: true });
  const initials =
    project.projectName
      .trim()
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase() || "?";
  return (
    <View style={styles.item}>
      <ProjectRailPreview
        workspaceEntries={workspaceEntries}
        project={project}
        initials={initials}
        onSelect={onSelect}
      />
      {bucket && bucket !== "done" ? (
        <View pointerEvents="none" style={[styles.dot, statusDotStyle(bucket)]} />
      ) : null}
    </View>
  );
});

export function CompactProjectRail({
  header,
  workspaceEntries,
  projects,
  onSelectProject,
  onAddProject,
  onSettings,
}: CompactProjectRailProps) {
  return (
    <View style={styles.rail} testID="compact-project-rail">
      {header}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.projects}>
        {projects.map((project) => (
          <ProjectRailItem
            workspaceEntries={workspaceEntries}
            key={project.viewKey}
            project={project}
            onSelect={onSelectProject}
          />
        ))}
      </ScrollView>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            accessibilityLabel="Add project"
            onPress={onAddProject}
            style={styles.button}
            leftIcon={Plus}
          />
        </TooltipTrigger>
        <TooltipContent side="right">
          <Text style={styles.label}>Add project</Text>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            accessibilityLabel="Settings"
            onPress={onSettings}
            style={styles.button}
            leftIcon={Settings}
          />
        </TooltipTrigger>
        <TooltipContent side="right">
          <Text style={styles.label}>Settings</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: { flex: 1, minHeight: 0, alignItems: "center", paddingBottom: 2, gap: 2 },
  header: { height: 48, justifyContent: "center" },
  scroll: { flex: 1, width: "100%" },
  projects: { alignItems: "center", gap: 2 },
  item: { position: "relative" },
  button: { width: 44, height: 44, paddingHorizontal: 0 },
  label: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.display,
    fontSize: theme.fontSize.base,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  dot: { position: "absolute", right: 3, top: 3, width: 7, height: 7, borderRadius: 4 },
  failed: { backgroundColor: theme.colors.statusDotDanger },
  running: { backgroundColor: theme.colors.statusDotRunning },
  attention: { backgroundColor: theme.colors.statusDotWarning },
}));

function statusDotStyle(bucket: string) {
  if (bucket === "failed") return styles.failed;
  if (bucket === "running") return styles.running;
  return styles.attention;
}
