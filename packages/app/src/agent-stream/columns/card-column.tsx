import { CardGrid, cardGridExpandedStyle } from "../card-grid";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { CARD_GAP, allocateGridCardHeights, type CardGridDemand } from "./geometry";
import { useRetainedPanelActive } from "@/components/retained-panel";

interface CardColumnLayout {
  heights: ReadonlyMap<string, number>;
  measure: (id: string, height: number | null, row?: number) => void;
}
export const CardColumnContext = createContext<CardColumnLayout | null>(null);

export function CardColumn({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [height, setHeight] = useState(0);
  const [demands, setDemands] = useState<ReadonlyMap<string, CardGridDemand>>(new Map());
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height > 0) setHeight(event.nativeEvent.layout.height);
  }, []);
  const measure = useCallback((id: string, demand: number | null, row?: number) => {
    setDemands((previous) => {
      const before = previous.get(id);
      if ((before?.height === demand && before?.row === row) || (demand === null && !before))
        return previous;
      const next = new Map(previous);
      if (demand === null) next.delete(id);
      else next.set(id, { height: demand, row });
      return next;
    });
  }, []);
  const value = useMemo(() => {
    const heights = allocateGridCardHeights(height, demands);
    return { heights, measure };
  }, [height, demands, measure]);
  return (
    <View
      style={columnStyle}
      onLayout={onLayout}
      testID={active ? "thread-cards-stack" : undefined}
    >
      <CardColumnContext.Provider value={value}>
        <CardGrid style={gridColumnStyle} testID={active ? "agent-history-task-cards" : undefined}>
          {children}
        </CardGrid>
      </CardColumnContext.Provider>
    </View>
  );
}
const gridColumnStyle = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
const columnStyle = { flex: 1, minHeight: 0, gap: CARD_GAP, overflow: "hidden" } as const;

/** Include non-card content in the same height budget as the surrounding cards. */
export function CardColumnAccessory({ children }: { children: ReactNode }) {
  const column = useContext(CardColumnContext);
  const active = useRetainedPanelActive();
  const id = useId();
  const [height, setHeight] = useState(0);
  const measure = column?.measure;
  useLayoutEffect(() => {
    measure?.(id, active && height > 0 ? height : null);
  }, [measure, id, active, height]);
  useLayoutEffect(() => () => measure?.(id, null), [measure, id]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height: measured } = event.nativeEvent.layout;
    if (width > 0) setHeight(measured);
  }, []);
  return (
    <View style={[accessoryStyle, cardGridExpandedStyle]} onLayout={onLayout}>
      {children}
    </View>
  );
}
const accessoryStyle = { flexShrink: 0 } as const;
