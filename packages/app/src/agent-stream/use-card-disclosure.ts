import { useCallback } from "react";
import { usePanelStore } from "@/stores/panel-store";
import {
  SUPPORTING_CARD_DEFAULTS,
  type SupportingCardKind,
  type SupportingCardUpdate,
} from "@/stores/panel-store/state";

/** Every workspace reads the same device-local preference before rendering. */
export function useCardDisclosure(kind: SupportingCardKind) {
  const expanded = usePanelStore(
    (state) => state.supportingCardExpanded[kind] ?? SUPPORTING_CARD_DEFAULTS[kind],
  );
  const setExpanded = useCallback(
    (update: SupportingCardUpdate) => {
      usePanelStore.getState().setSupportingCardExpanded(kind, update);
    },
    [kind],
  );
  return [expanded, setExpanded] as const;
}
