import { createContext, useContext } from "react";
import type { SettingsFocus } from "@/navigation/settings-navigation";

/**
 * The item a deep link asked for, read by the pane that owns it so the item
 * opens in place: Accounts & profiles expands the provider and Environments
 * selects the environment's tab.
 */
export const SettingsFocusContext = createContext<SettingsFocus | null>(null);

export function useSettingsFocus(): SettingsFocus | null {
  return useContext(SettingsFocusContext);
}

/** The DOM id of a provider's row, where a provider deep link scrolls. */
export function providerRowAnchorId(providerType: string): string {
  return `settings-provider-${providerType}`;
}
