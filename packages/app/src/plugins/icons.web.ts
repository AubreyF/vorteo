import { createElement, memo, useEffect, type ComponentProps, type ReactElement } from "react";
import {
  Settings,
  SquareTerminal,
  Terminal,
  Server,
  Bot,
  Folder,
  FolderOpen,
  File,
  FileText,
  GitBranch,
  GitPullRequest,
  Search,
  Bell,
  Image,
  Link,
  Paperclip,
  Clipboard,
  Code,
  Blocks,
  Palette,
  MessageSquare,
  Sparkles,
  Layers,
  BookOpen,
  Globe,
  Calendar,
  Monitor,
  Puzzle,
  Wrench,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import type { PluginIconProps } from "@getpaseo/plugin/client";
import { iconNameGroups } from "./icon-names.generated";
import { loadedCustomIcon, loadCustomIcons, useCustomIconState } from "./icon-catalog";
import { useDataSaver } from "@/network-preferences";

const common: Record<string, LucideIcon> = {
  Settings,
  SquareTerminal,
  Terminal,
  Server,
  Bot,
  Folder,
  FolderOpen,
  File,
  FileText,
  GitBranch,
  GitPullRequest,
  Search,
  Bell,
  Image,
  Link,
  Paperclip,
  Clipboard,
  Code,
  Blocks,
  Palette,
  MessageSquare,
  Sparkles,
  Layers,
  BookOpen,
  Globe,
  Calendar,
  Monitor,
  Puzzle,
  Wrench,
};
const canonicalNames = new Map<string, string>();
const commonByCanonical = new Map<string, LucideIcon>();
for (const group of iconNameGroups) {
  const names = group.split(",");
  for (const name of names) {
    canonicalNames.set(name, names[0]);
    if (common[name]) commonByCanonical.set(names[0], common[name]);
  }
}
const components = new Map<string, LucideIcon>();
function findPluginIcon(name: string): LucideIcon | null {
  const canonical = canonicalNames.get(name);
  if (!canonical) return null;
  const immediate = commonByCanonical.get(canonical);
  if (immediate) return immediate;
  const cached = components.get(canonical);
  if (cached) return cached;
  const OptionalIcon: LucideIcon = memo((props: ComponentProps<LucideIcon>) => {
    const dataSaver = useDataSaver();
    const status = useCustomIconState();
    useEffect(() => {
      if (!dataSaver && status.phase === "idle") void loadCustomIcons().catch(() => undefined);
    }, [dataSaver, status.phase]);
    const icon = loadedCustomIcon(canonical);
    let fallbackLabel: string | undefined;
    if (!icon) {
      fallbackLabel =
        status.phase === "failed"
          ? "Optional icon unavailable"
          : "Optional icon deferred; action label remains available";
    }
    return createElement(icon ?? Puzzle, {
      ...props,
      accessibilityLabel: props.accessibilityLabel ?? fallbackLabel,
    });
  });
  OptionalIcon.displayName = `Optional${canonical}`;
  components.set(canonical, OptionalIcon);
  return OptionalIcon;
}
export function resolvePluginIcon(name: string): LucideIcon {
  const icon = findPluginIcon(name);
  if (!icon) throw new Error(`Unknown Lucide icon: ${name}`);
  return icon;
}
export function Icon({ name, size, color }: PluginIconProps): ReactElement | null {
  const icon = findPluginIcon(name);
  return icon ? createElement(icon, { size, color }) : null;
}
