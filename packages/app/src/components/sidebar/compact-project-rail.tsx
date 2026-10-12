import { memo, useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PanelLeftOpen, Plus, Settings } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useSidebarProjectStatusBucket,
  type SidebarProjectEntry,
} from "@/hooks/use-sidebar-workspaces-list";

interface CompactProjectRailProps {
  projects: SidebarProjectEntry[];
  onSelectProject: (key: string) => void;
  onExpand: () => void;
  onAddProject: () => void;
  onSettings: () => void;
}

const ProjectRailItem = memo(function ProjectRailItem({
  project,
  onSelect,
}: {
  project: SidebarProjectEntry;
  onSelect: (key: string) => void;
}) {
  const bucket = useSidebarProjectStatusBucket({ workspaces: project.workspaces, enabled: true });
  const select = useCallback(() => onSelect(project.viewKey), [onSelect, project.viewKey]);
  const initials =
    project.projectName
      .trim()
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .slice(0, 2)
      .join("")
      .toLocaleUpperCase() || "?";
  const label = `${project.projectName}, ${project.workspaces.length} workspaces${bucket ? ", " + bucket.replaceAll("_", " ") : ""}`;
  return (
    <View style={styles.item}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" accessibilityLabel={label} onPress={select} style={styles.button}>
            {initials}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <Text style={styles.label}>{project.projectName}</Text>
          <Text style={styles.description}>{project.workspaces.length} workspaces</Text>
        </TooltipContent>
      </Tooltip>
      {bucket && bucket !== "done" ? (
        <View pointerEvents="none" style={[styles.dot, statusDotStyle(bucket)]} />
      ) : null}
    </View>
  );
});

export function CompactProjectRail({
  projects,
  onSelectProject,
  onExpand,
  onAddProject,
  onSettings,
}: CompactProjectRailProps) {
  return (
    <View style={styles.rail} testID="compact-project-rail">
      <View style={styles.header}>
        <Button
          variant="ghost"
          accessibilityLabel="Expand sidebar"
          onPress={onExpand}
          style={styles.button}
          leftIcon={PanelLeftOpen}
        />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.projects}>
        {projects.map((project) => (
          <ProjectRailItem key={project.viewKey} project={project} onSelect={onSelectProject} />
        ))}
      </ScrollView>
      <Button
        variant="ghost"
        accessibilityLabel="Add project"
        onPress={onAddProject}
        style={styles.button}
        leftIcon={Plus}
      />
      <Button
        variant="ghost"
        accessibilityLabel="Settings"
        onPress={onSettings}
        style={styles.button}
        leftIcon={Settings}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: { flex: 1, minHeight: 0, alignItems: "center", paddingBottom: 8, gap: 6 },
  header: { height: 48, justifyContent: "center" },
  scroll: { flex: 1, width: "100%" },
  projects: { alignItems: "center", gap: 6 },
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
