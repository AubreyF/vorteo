import { createContext, useContext, useMemo } from "react";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export const StreamColumnWidthContext = createContext<number | undefined>(undefined);

/**
 * Width cap for anything laid out in the transcript column. A resized text column can be wider
 * than the theme's content width, so rows that only use `theme.contentMaxWidth` end up inset
 * from the messages around them.
 */
export function useStreamColumnWidthStyle() {
  const columnWidth = useContext(StreamColumnWidthContext);
  return useMemo(
    () => (columnWidth === undefined ? null : inlineUnistylesStyle({ maxWidth: columnWidth })),
    [columnWidth],
  );
}
