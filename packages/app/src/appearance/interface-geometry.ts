import { Dimensions, useWindowDimensions as useNativeWindowDimensions } from "react-native";
import { getInterfaceScale, useInterfaceZoom } from "./interface-zoom";

/** Layout coordinates exclude CSS zoom; browser pointer and bounding rect coordinates include it. */
export function interfaceRect<T extends { x: number; y: number; width: number; height: number }>(
  rect: T,
): T {
  const scale = getInterfaceScale();
  return {
    ...rect,
    x: rect.x / scale,
    y: rect.y / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}
export function getInterfaceWindow() {
  const window = Dimensions.get("window");
  const scale = getInterfaceScale();
  return { ...window, width: window.width / scale, height: window.height / scale };
}
export function useWindowDimensions() {
  const dimensions = useNativeWindowDimensions();
  const [zoom] = useInterfaceZoom();
  return {
    ...dimensions,
    width: (dimensions.width * 100) / zoom,
    height: (dimensions.height * 100) / zoom,
  };
}
