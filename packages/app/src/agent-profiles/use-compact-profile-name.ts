import type { RefObject } from "react";
import { type View } from "react-native";
import { useWindowDimensions } from "@/appearance/interface-geometry";

export function useCompactProfileName(_ref: RefObject<View | null>, mobile: boolean) {
  return useWindowDimensions().width < 640 || mobile;
}
