import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { ScrollView } from "react-native";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { CountBadge } from "@/components/ui/count-badge";
import { usePanelStore } from "@/stores/panel-store";
import { SUPPORTING_CARD_DEFAULTS } from "@/stores/panel-store/state";

/** Cards that span every thread and account, as opposed to the focused tab's right-hand cards. */
export type GlobalCardKind = "globalQuestions" | "globalQuota";
const GLOBAL_CARD_KINDS: readonly GlobalCardKind[] = ["globalQuestions", "globalQuota"];

/** Below this height, one card opens at a time so the workspace list keeps its room. */
const EXCLUSIVE_HEIGHT = 720;

interface GlobalCardLayout {
  exclusive: boolean;
  maxBodyHeight: number;
  /** Cards currently shown; a hidden card never closes a visible one. */
  shown: ReadonlySet<GlobalCardKind>;
  setShown: (kind: GlobalCardKind, shown: boolean) => void;
}
export const GlobalCardLayoutContext = createContext<GlobalCardLayout>({
  exclusive: false,
  maxBodyHeight: 240,
  shown: new Set(),
  setShown: () => {},
});

/** Each card body is capped so the cards never take more than about half of the sidebar. */
export function globalCardLayout(
  windowHeight: number,
): Pick<GlobalCardLayout, "exclusive" | "maxBodyHeight"> {
  const exclusive = windowHeight < EXCLUSIVE_HEIGHT;
  const share = exclusive ? 0.4 : 0.25;
  return { exclusive, maxBodyHeight: Math.max(120, Math.round(windowHeight * share)) };
}

/** The device remembers each card's state; small screens close the others when one opens. */
export function useGlobalCardDisclosure(kind: GlobalCardKind) {
  const { exclusive, shown, setShown } = useContext(GlobalCardLayoutContext);
  useLayoutEffect(() => {
    setShown(kind, true);
    return () => setShown(kind, false);
  }, [kind, setShown]);
  const expanded = usePanelStore((state) => {
    const open = (card: GlobalCardKind) =>
      state.supportingCardExpanded[card] ?? SUPPORTING_CARD_DEFAULTS[card];
    if (!open(kind)) return false;
    // Choices saved on a taller screen may leave several open; the first in order wins here.
    return (
      !exclusive ||
      GLOBAL_CARD_KINDS.slice(0, GLOBAL_CARD_KINDS.indexOf(kind)).every(
        (card) => !shown.has(card) || !open(card),
      )
    );
  });
  const toggle = useCallback(() => {
    const store = usePanelStore.getState();
    const next = !expanded;
    store.setSupportingCardExpanded(kind, next, "sidebar");
    if (next && exclusive) {
      for (const other of GLOBAL_CARD_KINDS) {
        if (other !== kind) store.setSupportingCardExpanded(other, false, "sidebar");
      }
    }
  }, [exclusive, expanded, kind]);
  return [expanded, toggle] as const;
}

/** A collapsible sidebar card whose body scrolls inside its height budget. */
export function GlobalCard({
  kind,
  title,
  icon,
  count,
  countLabel,
  testID,
  children,
}: {
  kind: GlobalCardKind;
  title: string;
  icon: ReactNode;
  count: number;
  countLabel: string;
  testID: string;
  children: ReactNode;
}) {
  const [expanded, toggle] = useGlobalCardDisclosure(kind);
  const { maxBodyHeight } = useContext(GlobalCardLayoutContext);
  const badge = useMemo(
    () => (
      <CountBadge
        count={count}
        label={String(count)}
        accessibilityLabel={countLabel}
        testID={`${testID}-count`}
      />
    ),
    [count, countLabel, testID],
  );
  const bodyStyle = useMemo(() => ({ maxHeight: maxBodyHeight }), [maxBodyHeight]);
  return (
    <TaskCard scrollBody={false} flushBody testID={testID} bodyVisible={expanded}>
      <TaskCardHeader>
        <CardDisclosure
          icon={icon}
          title={title}
          expanded={expanded}
          onPress={toggle}
          count={badge}
          testID={`${testID}-toggle`}
        />
      </TaskCardHeader>
      {expanded ? (
        <ScrollView
          style={bodyStyle}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          testID={`${testID}-body-scroll`}
        >
          {children}
        </ScrollView>
      ) : null}
    </TaskCard>
  );
}
