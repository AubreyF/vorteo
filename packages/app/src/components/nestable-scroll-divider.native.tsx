import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeNestableScrollContainerContext } from "react-native-draggable-flatlist/src/context/nestableScrollContainerContext";

/** The native drag container owns onScroll; observe its existing shared offset. */
export function NestableScrollDivider({ onChange }: { onChange?: (scrolled: boolean) => void }) {
  const { outerScrollOffset } = useSafeNestableScrollContainerContext();
  useAnimatedReaction(
    () => outerScrollOffset.value > 0,
    (scrolled, previous) => {
      if (onChange && scrolled !== previous) scheduleOnRN(onChange, scrolled);
    },
    [onChange],
  );
  return null;
}
