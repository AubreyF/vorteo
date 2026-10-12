import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { CARD_GAP, allocateCardHeights } from "./geometry";
import { useRetainedPanelActive } from "@/components/retained-panel";

interface CardColumnLayout {
  heights: ReadonlyMap<string, number>;
  measure: (id: string, height: number | null) => void;
}
export const CardColumnContext = createContext<CardColumnLayout | null>(null);

export function CardColumn({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [height, setHeight] = useState(0);
  const [demands, setDemands] = useState<ReadonlyMap<string, number>>(new Map());
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    if (event.nativeEvent.layout.height > 0) setHeight(event.nativeEvent.layout.height);
  }, []);
  const measure = useCallback((id: string, demand: number | null) => {
    setDemands((previous) => {
      if (previous.get(id) === demand || (demand === null && !previous.has(id))) return previous;
      const next = new Map(previous);
      if (demand === null) next.delete(id);
      else next.set(id, demand);
      return next;
    });
  }, []);
  const value = useMemo(() => {
    const allocations = allocateCardHeights(height, [...demands.values()]);
    const heights = new Map([...demands.keys()].map((id, index) => [id, allocations[index]]));
    return { heights, measure };
  }, [height, demands, measure]);
  return (
    <View
      style={columnStyle}
      onLayout={onLayout}
      testID={active ? "thread-cards-stack" : undefined}
    >
      <CardColumnContext.Provider value={value}>
        <View style={columnStyle} testID={active ? "agent-history-task-cards" : undefined}>
          {children}
        </View>
      </CardColumnContext.Provider>
    </View>
  );
}
const columnStyle = { flex: 1, minHeight: 0, gap: CARD_GAP, overflow: "hidden" } as const;
