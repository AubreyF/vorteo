/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { StreamColumnWidthContext, useStreamColumnWidthStyle } from "./column-width";

function withColumnWidth(width: number | undefined) {
  return function ColumnWidthProvider({ children }: { children: ReactNode }) {
    return (
      <StreamColumnWidthContext.Provider value={width}>
        {children}
      </StreamColumnWidthContext.Provider>
    );
  };
}

it("leaves the theme width alone when the text column is not resized", () => {
  const { result } = renderHook(useStreamColumnWidthStyle, { wrapper: withColumnWidth(undefined) });
  expect(result.current).toBeNull();
});

it("caps transcript rows at a resized text column, even past the theme width", () => {
  const { result } = renderHook(useStreamColumnWidthStyle, { wrapper: withColumnWidth(1180) });
  expect(result.current).toMatchObject({ maxWidth: 1180 });
});
