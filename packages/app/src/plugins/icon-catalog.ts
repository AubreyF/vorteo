import { useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { createIconCatalog, type CustomIconState } from "./icon-catalog-state";
const catalog = createIconCatalog(() => import("lucide-react-native"));
const unavailable: CustomIconState = { phase: "unavailable", attempts: 0 };
export function customIconState(): CustomIconState {
  return isWeb ? catalog.state() : unavailable;
}
export function useCustomIconState(): CustomIconState {
  return useSyncExternalStore(catalog.subscribe, customIconState, customIconState);
}
export function loadedCustomIcon(name: string): LucideIcon | null {
  const module = catalog.value();
  const value: unknown = module ? Reflect.get(module, name) : null;
  return typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
    ? (value as LucideIcon)
    : null;
}
export function loadCustomIcons(): Promise<void> {
  return isWeb ? catalog.load() : Promise.resolve();
}
