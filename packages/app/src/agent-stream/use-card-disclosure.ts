import { CardColumnContext } from "./columns/card-column";
import { createContext, useCallback, useContext } from "react";
import { usePanelStore } from "@/stores/panel-store";
import {
  SUPPORTING_CARD_DEFAULTS,
  type SupportingCardKind,
  type SupportingCardUpdate,
} from "@/stores/panel-store/state";

export const CardDisclosureLayoutContext = createContext<"sidebar" | "inline" | null>(null);

/** Select by actual placement, so responsive moves restore the right preference immediately. */
export function useCardDisclosure(kind: SupportingCardKind) {
  const column = useContext(CardColumnContext);
  const inheritedLayout = useContext(CardDisclosureLayoutContext);
  const layout = inheritedLayout ?? (column ? "sidebar" : "inline");
  const expanded = usePanelStore(
    (state) =>
      (layout === "inline" ? state.inlineCardExpanded : state.supportingCardExpanded)[kind] ??
      SUPPORTING_CARD_DEFAULTS[kind],
  );
  const setExpanded = useCallback(
    (update: SupportingCardUpdate) => {
      usePanelStore.getState().setSupportingCardExpanded(kind, update, layout);
    },
    [kind, layout],
  );
  return [expanded, setExpanded] as const;
}
