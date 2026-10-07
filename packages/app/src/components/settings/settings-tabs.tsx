import { useCallback, useMemo } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

interface SettingsTabOption {
  value: string;
  label: string;
  testID?: string;
}

interface SettingsTabsProps {
  options: SettingsTabOption[];
  value: string;
  onValueChange: (value: string) => void;
  testID?: string;
}

export function SettingsTabs({ options, value, onValueChange, testID }: SettingsTabsProps) {
  return (
    <View style={styles.tabBar} testID={testID ? `${testID}-bar` : undefined}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.tabs} accessibilityRole="tablist" testID={testID}>
          {options.map((option) => (
            <SettingsTab
              key={option.value}
              value={option.value}
              label={option.label}
              selected={option.value === value}
              onSelect={onValueChange}
              testID={option.testID}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function SettingsTab({
  value,
  label,
  selected,
  onSelect,
  testID,
}: {
  value: string;
  label: string;
  selected: boolean;
  onSelect: (value: string) => void;
  testID?: string;
}) {
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      onPress={select}
      accessibilityRole="tab"
      aria-selected={selected}
      accessibilityState={accessibilityState}
      testID={testID}
      style={styles.tab}
    >
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabBar: {
    alignSelf: "stretch",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabs: { flexDirection: "row", gap: theme.spacing[2] },
  tab: {
    minHeight: 44,
    flexShrink: 0,
    borderTopLeftRadius: theme.borderRadius.lg,
    borderTopRightRadius: theme.borderRadius.lg,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
}));
