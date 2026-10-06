import { forwardRef, useCallback, useRef } from "react";
import { ScrollView as NativeScrollView, type ScrollViewProps } from "react-native";

export { FlatList } from "react-native";

/** RN Web puts its x/y scrollTo method on the DOM node. Browser libraries use top/left. */
export function installBrowserScrollOptions(node: HTMLElement): () => void {
  const original = node.scrollTo;
  const scrollTo: HTMLElement["scrollTo"] = (options?: ScrollToOptions | number, y?: number) => {
    if (
      typeof options === "object" &&
      options !== null &&
      ("top" in options || "left" in options || "behavior" in options)
    ) {
      Reflect.apply(node.ownerDocument.defaultView!.Element.prototype.scrollTo, node, [options]);
      return;
    }
    Reflect.apply(original, node, [options, y]);
  };
  node.scrollTo = scrollTo;
  return () => {
    if (node.scrollTo === scrollTo) node.scrollTo = original;
  };
}

// Keep native gesture dependencies out of the browser module.
export const ScrollView = forwardRef<NativeScrollView, ScrollViewProps>(
  function ScrollView(props, ref) {
    const restore = useRef<(() => void) | null>(null);
    const setRef = useCallback(
      (instance: NativeScrollView | null) => {
        restore.current?.();
        restore.current = null;
        if (instance) {
          const node = instance.getScrollableNode() as HTMLElement;
          restore.current = installBrowserScrollOptions(node);
        }
        if (typeof ref === "function") ref(instance);
        else if (ref) ref.current = instance;
      },
      [ref],
    );
    return <NativeScrollView {...props} ref={setRef} />;
  },
);
