import { useVortonTouch } from "@/vorton-touch";
import {
  LIST_ROW_HEIGHT,
  LIST_ROW_SPACING,
  LIST_ROW_TOUCH_HEIGHT,
} from "@/styles/list-row-metrics";

const desktopRow = {
  minHeight: LIST_ROW_HEIGHT,
  paddingTop: 0,
  paddingBottom: 0,
  paddingRight: 8,
  marginBottom: LIST_ROW_SPACING,
};
const touchRow = { ...desktopRow, minHeight: LIST_ROW_TOUCH_HEIGHT };

export function useSidebarRowDensity() {
  const touch = useVortonTouch();

  return touch ? touchRow : desktopRow;
}
