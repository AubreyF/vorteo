import { useVortonTouch } from "@/vorton-touch";
import { LIST_ROW_ACTION_SIZE, LIST_ROW_TOUCH_ACTION_SIZE } from "@/styles/list-row-metrics";

const desktop = {
  width: LIST_ROW_ACTION_SIZE,
  height: LIST_ROW_ACTION_SIZE,
  minWidth: LIST_ROW_ACTION_SIZE,
  minHeight: LIST_ROW_ACTION_SIZE,
};
const touchAction = {
  width: LIST_ROW_TOUCH_ACTION_SIZE,
  height: LIST_ROW_TOUCH_ACTION_SIZE,
  minWidth: LIST_ROW_TOUCH_ACTION_SIZE,
  minHeight: LIST_ROW_TOUCH_ACTION_SIZE,
};

export function useSidebarActionSize() {
  const touch = useVortonTouch();

  return touch ? touchAction : desktop;
}
