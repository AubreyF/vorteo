import { useCallback, useRef, useState } from "react";
import { Text, type TextProps } from "react-native";
import { isWeb } from "@/constants/platform";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "./tooltip";

/** Preserve the text's layout and click behavior; reveal only genuinely clipped values. */
export function TruncatedText({
  tooltipLabel,
  tooltipDescription,
  children,
  ...props
}: TextProps & { tooltipLabel?: string; tooltipDescription?: string }) {
  const ref = useRef<Text>(null);
  const [open, setOpen] = useState(false);
  const label = tooltipLabel ?? (typeof children === "string" ? children : "");
  const changeOpen = useCallback((next: boolean) => {
    const node: unknown = ref.current;
    // Measure on entry, so resizing, font changes and multiline clamping stay accurate
    // without adding a ResizeObserver to every row.
    setOpen(
      next &&
        isWeb &&
        node instanceof HTMLElement &&
        (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1),
    );
  }, []);
  const text = (
    <Text {...props} ref={ref}>
      {children}
    </Text>
  );
  if (!isWeb || !label) return text;
  return (
    <Tooltip open={open} onOpenChange={changeOpen} delayDuration={250} enabledOnMobile={false}>
      <TooltipTrigger asChild>{text}</TooltipTrigger>
      <TooltipContent maxWidth={440}>
        <TooltipText label={label} description={tooltipDescription} />
      </TooltipContent>
    </Tooltip>
  );
}
