import { View } from "react-native";
import { SettingsCard, SettingsCollapsibleRow, SettingsRow } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { usageCopy } from "./copy";
import type { UsageDisplay } from "./display";

import type { UsageDisplayAs } from "./preferences";

const DISPLAY_AS_OPTIONS: SegmentedControlOption<UsageDisplayAs>[] = [
  { value: "used", label: usageCopy.displayUsed, testID: "usage-display-used" },
  { value: "remaining", label: usageCopy.displayRemaining, testID: "usage-display-remaining" },
];

export function UsageOptions({ display }: { display: UsageDisplay }) {
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsCollapsibleRow label={usageCopy.options} testID="usage-options">
          <SettingsRow label={usageCopy.displayAs}>
            <SegmentedControl
              options={DISPLAY_AS_OPTIONS}
              value={display.displayAs}
              onValueChange={display.setDisplayAs}
              size="sm"
              testID="usage-display-as"
            />
          </SettingsRow>
        </SettingsCollapsibleRow>
      </SettingsCard>
    </View>
  );
}
