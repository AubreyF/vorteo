import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type TextInputKeyPressEventData,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView as NativeScrollView,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScrollView } from "@/components/ui/scroll-view";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { SearchField } from "@/components/ui/search-field";
import { isWeb } from "@/constants/platform";
import type {
  SettingScope,
  SettingsPaneDefinition,
  SettingsSectionId,
} from "@/settings-catalog/catalog";
import type { SettingsSearchResult } from "@/settings-catalog/search";
import {
  findSettingRow,
  flashSettingRow,
  markSettingRows,
  rowOffsetWithin,
  settingsPaneDomId,
} from "@/settings-catalog/row-highlight";

export interface SettingsPageSection {
  id: SettingsSectionId;
  label: string;
  panes: SettingsPaneDefinition[];
}

export interface ResolvedSettingsEntry {
  id: string;
  pane: string;
  section: SettingsSectionId;
  label: string;
  hint?: string;
  keywords?: readonly string[];
  context: readonly string[];
  scope: SettingScope;
  /** Pane and section titles shown under a search result. */
  breadcrumb: string;
}

/** A request to bring a section, pane or row into view. A new nonce repeats it. */
export interface SettingsScrollRequest {
  section: SettingsSectionId;
  pane: string | null;
  entry: ResolvedSettingsEntry | null;
  animated: boolean;
  nonce: number;
}

interface SettingsScrollPageProps {
  sections: readonly SettingsPageSection[];
  renderPane: (paneId: string) => ReactNode;
  request: SettingsScrollRequest;
  onActiveSectionChange: (section: SettingsSectionId) => void;
  query: string;
  results: readonly SettingsSearchResult<ResolvedSettingsEntry>[];
  /** Panes that match the query by title even without a matching row. */
  matchedPanes: ReadonlySet<string>;
  selectedResult: number;
  onSelectResult: (entry: ResolvedSettingsEntry) => void;
  /** Shows the search field above the sections, for compact layouts. */
  search?: SettingsSearchControls;
  bottomInset?: number;
}

const SCOPE_LABELS: Record<SettingScope, string> = {
  device: "This device",
  installation: "All environments",
  environment: "Per environment",
};

/** Where the active section changes, measured from the top of the scroll view. */
const SPY_OFFSET = 32;
/** Space kept above a section, pane or row after a jump. */
const JUMP_INSET = 16;
/** A programmatic scroll is over once no scroll event arrives for this long. */
const SCROLL_SETTLE_MS = 150;
const MAX_RESULTS_SHOWN = 8;
/** How long a jump target stays pinned while panes above it load. */
const PIN_MS = 3000;

export interface SettingsSearchControls {
  query: string;
  onChangeQuery: (query: string) => void;
  onKeyPress: (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void;
  onSubmit: () => void;
}

export function SettingsSearchBox({ search }: { search: SettingsSearchControls }) {
  return (
    <SearchField
      value={search.query}
      onChangeText={search.onChangeQuery}
      onKeyPress={search.onKeyPress}
      onSubmitEditing={search.onSubmit}
      placeholder="Search settings"
      clearAccessibilityLabel="Clear settings search"
      testID="settings-search-input"
      clearTestID="settings-search-clear"
    />
  );
}

function resultsSummary(count: number, anyVisible: boolean, query: string): string {
  if (count > 0) return `${count} matching ${count === 1 ? "setting" : "settings"}`;
  if (anyVisible) return "No matching settings. Matching sections are shown below.";
  return `No settings match “${query.trim()}”`;
}

function sectionDomId(section: SettingsSectionId): string {
  return `settings-page-section-${section}`;
}

interface Box {
  y: number;
  height: number;
}

/**
 * Every settings section in one scrolling column. The sidebar follows the
 * section in view, jumps scroll instead of navigating, and sections below the
 * target mount progressively so the first one appears without waiting on all.
 *
 * Section heights change as their data loads. The page keeps the reader's
 * place by tracking the top of the section they are reading and scrolling by
 * however far it moves, so panes above resolving their data (even several at
 * once) never shove the content under the cursor.
 */
export function SettingsScrollPage({
  sections,
  renderPane,
  request,
  onActiveSectionChange,
  query,
  results,
  matchedPanes,
  selectedResult,
  onSelectResult,
  search,
  bottomInset = 0,
}: SettingsScrollPageProps) {
  const scrollRef = useRef<NativeScrollView>(null);
  const scrollY = useRef(0);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const sectionBoxes = useRef(new Map<SettingsSectionId, Box>());
  const paneBoxes = useRef(new Map<string, Box>());
  const programmatic = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SettingsScrollRequest | null>(request);
  const activeSection = useRef<SettingsSectionId | null>(null);
  const pinned = useRef<{ request: SettingsScrollRequest; until: number } | null>(null);
  /** The section the reader is in and where its top sat when last measured. */
  const anchor = useRef<{ section: SettingsSectionId; y: number } | null>(null);
  /** Where the page last scrolled itself, to tell its own scrolls from the reader's. */
  const ownScrollY = useRef<number | null>(null);
  const [viewport, setViewport] = useState(0);
  const searching = query.trim().length > 0;

  const targetIndex = Math.max(
    0,
    sections.findIndex((section) => section.id === request.section),
  );
  // Sections up to the target mount at once so its position is real; the rest
  // follow one per frame.
  const [mountedCount, setMountedCount] = useState(() =>
    Math.min(sections.length, targetIndex + 2),
  );
  const visibleMounted = searching ? sections.length : mountedCount;

  useEffect(() => {
    if (mountedCount >= sections.length) return;
    const handle = setTimeout(() => setMountedCount((count) => count + 1), 16);
    return () => clearTimeout(handle);
  }, [mountedCount, sections.length]);

  useEffect(() => {
    if (targetIndex + 1 > mountedCount) setMountedCount(targetIndex + 2);
  }, [mountedCount, targetIndex]);

  // Browsers anchor scroll position themselves; turn that off so it does not
  // stack with the page's own compensation.
  useEffect(() => {
    if (!isWeb) return;
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (node) node.style.overflowAnchor = "none";
  }, []);

  const markProgrammatic = useCallback(() => {
    programmatic.current = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      programmatic.current = false;
    }, SCROLL_SETTLE_MS);
  }, []);

  const scrollTo = useCallback(
    (y: number, animated: boolean) => {
      markProgrammatic();
      ownScrollY.current = animated ? null : Math.max(0, y);
      scrollRef.current?.scrollTo({ y: Math.max(0, y), animated });
    },
    [markProgrammatic],
  );

  const reportActive = useCallback(
    (section: SettingsSectionId) => {
      if (activeSection.current === section) return;
      activeSection.current = section;
      onActiveSectionChange(section);
    },
    [onActiveSectionChange],
  );

  /**
   * Where a request's target sits in the scroll content, or null until it has
   * rendered. Web measures the DOM, which stays correct after a search hides
   * and restores sections; native uses the recorded layout boxes.
   */
  const targetOffset = useCallback(
    (target: SettingsScrollRequest): { y: number; row: HTMLElement | null } | null => {
      if (isWeb) {
        const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
        const element = document.getElementById(
          target.pane ? settingsPaneDomId(target.pane) : sectionDomId(target.section),
        );
        if (!node || !element || element.offsetHeight === 0) return null;
        const row = target.entry ? findSettingRow(target.entry.pane, target.entry.label) : null;
        const inset = row ? JUMP_INSET * 4 : JUMP_INSET;
        return { y: rowOffsetWithin(row ?? element, node) - inset, row };
      }
      const sectionBox = sectionBoxes.current.get(target.section);
      if (!sectionBox) return null;
      const paneBox = target.pane ? paneBoxes.current.get(target.pane) : undefined;
      if (target.pane && !paneBox) return null;
      return { y: sectionBox.y + (paneBox?.y ?? 0) - JUMP_INSET, row: null };
    },
    [],
  );

  /**
   * A section's top within the scroll content. Web reads the DOM because its
   * layout events miss position-only moves; native uses the recorded boxes.
   */
  const sectionTop = useCallback((section: SettingsSectionId): number | undefined => {
    if (isWeb) {
      const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
      const element = document.getElementById(sectionDomId(section));
      if (node && element) return rowOffsetWithin(element, node);
    }
    return sectionBoxes.current.get(section)?.y;
  }, []);

  const recordAnchor = useCallback(
    (section: SettingsSectionId | null) => {
      if (!section) return;
      const y = sectionTop(section);
      anchor.current = y === undefined ? null : { section, y };
    },
    [sectionTop],
  );

  /** Brings the pending request into view once its target has rendered. */
  const resolvePending = useCallback(() => {
    const next = pending.current;
    if (!next) return;
    const offset = targetOffset(next);
    if (!offset) return;
    pending.current = null;
    pinned.current = { request: next, until: Date.now() + PIN_MS };
    reportActive(next.section);
    scrollTo(offset.y, next.animated);
    recordAnchor(next.section);
    if (offset.row) flashSettingRow(offset.row);
  }, [recordAnchor, reportActive, scrollTo, targetOffset]);

  /**
   * Panes above a fresh jump target are often still loading. Until they settle
   * or the reader scrolls, keep the target where the jump put it.
   */
  const holdPinnedTarget = useCallback((): boolean => {
    const pin = pinned.current;
    if (!pin) return false;
    if (Date.now() > pin.until) {
      pinned.current = null;
      return false;
    }
    const offset = targetOffset(pin.request);
    if (offset && Math.abs(offset.y - scrollY.current) > 1) {
      scrollY.current = offset.y;
      scrollTo(offset.y, false);
    }
    // Keep the anchor current so compensation after the pin starts from here.
    recordAnchor(pin.request.section);
    return true;
  }, [recordAnchor, scrollTo, targetOffset]);

  useEffect(() => {
    pending.current = request;
    resolvePending();
  }, [request, resolvePending]);

  const updateActive = useCallback(() => {
    if (programmatic.current || searching) return;
    const top = scrollY.current + SPY_OFFSET;
    const atEnd = scrollY.current + viewportHeight.current >= contentHeight.current - 2;
    const node = isWeb
      ? (scrollRef.current?.getScrollableNode() as HTMLElement | undefined)
      : undefined;
    let current: SettingsSectionId | null = null;
    for (const section of sections) {
      let y = sectionBoxes.current.get(section.id)?.y;
      // Web layout events miss position-only moves, so read the DOM.
      const element = node ? document.getElementById(sectionDomId(section.id)) : null;
      if (node && element) y = rowOffsetWithin(element, node);
      if (y === undefined) continue;
      if (atEnd || y <= top) current = section.id;
    }
    if (current) reportActive(current);
  }, [reportActive, searching, sections]);

  const releaseToReader = useCallback(() => {
    pinned.current = null;
    ownScrollY.current = null;
    programmatic.current = false;
  }, []);

  // Scroll gestures and keyboard navigation hand control back to the reader.
  // A desktop control press keeps a fresh jump pinned while panes settle.
  useEffect(() => {
    if (!isWeb) return;
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    if (!node) return;
    const releaseOnPointerDown = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, a, input, textarea, select, [role='button']")
      )
        return;
      releaseToReader();
    };
    const events = ["wheel", "touchstart", "keydown"] as const;
    for (const name of events) node.addEventListener(name, releaseToReader, { passive: true });
    node.addEventListener("pointerdown", releaseOnPointerDown, { passive: true });
    return () => {
      for (const name of events) node.removeEventListener(name, releaseToReader);
      node.removeEventListener("pointerdown", releaseOnPointerDown);
    };
  }, [releaseToReader]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      scrollY.current = y;
      // An instant jump lands exactly where the page put it; any other
      // position means the reader, keyboard focus or a script moved the page.
      const own = ownScrollY.current;
      // Focus or late layout can move a fresh web jump without a reader gesture.
      // Let smooth scrolling run, then keep its target until it settles or the reader takes over.
      if (isWeb && (own !== null || !programmatic.current) && holdPinnedTarget()) return;
      // A jump past the current end of the content lands short while sections
      // below are still mounting. That is the page, not the reader, so keep the
      // target pinned and let layout finish the jump.
      const clamped =
        own !== null && y < own && y + viewportHeight.current >= contentHeight.current - 2;
      if (own !== null && Math.abs(y - own) > 2 && !clamped) releaseToReader();
      else if (programmatic.current) markProgrammatic();
      else pinned.current = null;
      updateActive();
      recordAnchor(activeSection.current);
    },
    [holdPinnedTarget, markProgrammatic, recordAnchor, releaseToReader, updateActive],
  );

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    viewportHeight.current = event.nativeEvent.layout.height;
    setViewport(event.nativeEvent.layout.height);
  }, []);

  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    contentHeight.current = height;
  }, []);

  /**
   * Something above the reader grew or shrank, so the top of the section they
   * are reading moved: scroll by the same amount so the visible content stays
   * put. Several sections can change in one layout pass; measuring the
   * reader's section covers all of them at once.
   */
  const handleSectionLayout = useCallback(
    (id: SettingsSectionId, box: Box) => {
      sectionBoxes.current.set(id, box);
      if (holdPinnedTarget()) {
        resolvePending();
        return;
      }
      const current = anchor.current;
      if (current && !pending.current && !searching) {
        const y = sectionTop(current.section);
        if (y !== undefined && y !== current.y) {
          anchor.current = { section: current.section, y };
          scrollY.current += y - current.y;
          scrollTo(scrollY.current, false);
        }
      }
      resolvePending();
    },
    [holdPinnedTarget, resolvePending, scrollTo, searching, sectionTop],
  );

  const handlePaneLayout = useCallback(
    (id: string, box: Box) => {
      paneBoxes.current.set(id, box);
      holdPinnedTarget();
      resolvePending();
    },
    [holdPinnedTarget, resolvePending],
  );

  // Tint matching rows while a search is active, after the panes render.
  const matchKey = results.map((result) => result.entry.id).join("|");
  useLayoutEffect(() => {
    if (!searching || !isWeb) return;
    const matches = results.map((result) => result.entry);
    let cleanup = () => {};
    const handle = setTimeout(() => {
      cleanup = markSettingRows(matches);
    }, 0);
    return () => {
      clearTimeout(handle);
      cleanup();
    };
    // matchKey stands in for results, which is a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, searching]);

  const resultPanes = useMemo(() => new Set(results.map((result) => result.entry.pane)), [results]);
  const paneVisible = useCallback(
    (pane: SettingsPaneDefinition) =>
      !searching || resultPanes.has(pane.id) || matchedPanes.has(pane.id),
    [matchedPanes, resultPanes, searching],
  );

  const lastSection = sections.at(-1);
  const lastBox = lastSection ? sectionBoxes.current.get(lastSection.id) : undefined;
  // Room for the last section's heading to reach the top when it is chosen.
  const trailingSpace = searching
    ? JUMP_INSET * 4
    : Math.max(JUMP_INSET * 4, viewport - (lastBox?.height ?? 0) - JUMP_INSET);
  const contentStyle = useMemo(
    () => ({ paddingBottom: trailingSpace + bottomInset }),
    [bottomInset, trailingSpace],
  );

  const shownResults = results.slice(0, MAX_RESULTS_SHOWN);
  const anyVisible = sections.some((section) => section.panes.some(paneVisible));

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={contentStyle}
      onScroll={handleScroll}
      scrollEventThrottle={16}
      onLayout={handleViewportLayout}
      onContentSizeChange={handleContentSizeChange}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      testID="settings-scroll-page"
    >
      {search ? (
        <View style={[styles.column, styles.compactSearch]}>
          <SettingsSearchBox search={search} />
        </View>
      ) : null}
      {searching ? (
        <View style={styles.column} testID="settings-search-results">
          <Text style={styles.resultsTitle}>
            {resultsSummary(results.length, anyVisible, query)}
          </Text>
          {shownResults.length ? (
            <View style={styles.resultsCard}>
              {shownResults.map((result, index) => (
                <SearchResultRow
                  key={result.entry.id}
                  result={result}
                  selected={index === selectedResult}
                  bordered={index > 0}
                  onSelect={onSelectResult}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {sections.slice(0, visibleMounted).map((section) => {
        const panes = section.panes.filter(paneVisible);
        const hidden = searching && panes.length === 0;
        return (
          <SectionBlock
            key={section.id}
            section={section}
            hidden={hidden}
            panes={section.panes}
            paneVisible={paneVisible}
            renderPane={renderPane}
            onSectionLayout={handleSectionLayout}
            onPaneLayout={handlePaneLayout}
          />
        );
      })}
    </ScrollView>
  );
}

function SectionBlock({
  section,
  hidden,
  panes,
  paneVisible,
  renderPane,
  onSectionLayout,
  onPaneLayout,
}: {
  section: SettingsPageSection;
  hidden: boolean;
  panes: readonly SettingsPaneDefinition[];
  paneVisible: (pane: SettingsPaneDefinition) => boolean;
  renderPane: (paneId: string) => ReactNode;
  onSectionLayout: (id: SettingsSectionId, box: Box) => void;
  onPaneLayout: (id: string, box: Box) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      onSectionLayout(section.id, { y, height });
    },
    [onSectionLayout, section.id],
  );
  // Hidden sections stay mounted so their state survives a search.
  const style = useMemo(() => [styles.column, styles.section, hidden && styles.hidden], [hidden]);
  return (
    <View
      style={style}
      onLayout={handleLayout}
      testID={`settings-page-section-${section.id}`}
      nativeID={sectionDomId(section.id)}
    >
      <Text
        style={styles.sectionTitle}
        accessibilityRole="header"
        testID={`settings-section-title-${section.id}`}
      >
        {section.label}
      </Text>
      {panes.map((pane) => (
        <PaneBlock
          key={pane.id}
          pane={pane}
          hidden={!paneVisible(pane)}
          renderPane={renderPane}
          onPaneLayout={onPaneLayout}
        />
      ))}
    </View>
  );
}

function PaneBlock({
  pane,
  hidden,
  renderPane,
  onPaneLayout,
}: {
  pane: SettingsPaneDefinition;
  hidden: boolean;
  renderPane: (paneId: string) => ReactNode;
  onPaneLayout: (id: string, box: Box) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      onPaneLayout(pane.id, { y, height });
    },
    [onPaneLayout, pane.id],
  );
  return (
    <View
      nativeID={settingsPaneDomId(pane.id)}
      onLayout={handleLayout}
      style={hidden ? styles.hidden : undefined}
      testID={`settings-pane-${pane.id}`}
    >
      {renderPane(pane.id)}
    </View>
  );
}

function SearchResultRow({
  result,
  selected,
  bordered,
  onSelect,
}: {
  result: SettingsSearchResult<ResolvedSettingsEntry>;
  selected: boolean;
  bordered: boolean;
  onSelect: (entry: ResolvedSettingsEntry) => void;
}) {
  const handlePress = useCallback(() => onSelect(result.entry), [onSelect, result.entry]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.resultRow,
      bordered && styles.resultBorder,
      (selected || hovered || pressed) && styles.resultActive,
    ],
    [bordered, selected],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityHint={`Opens ${result.entry.breadcrumb}`}
      onPress={handlePress}
      style={rowStyle}
      testID={`settings-search-result-${result.entry.id}`}
    >
      <View style={styles.resultText}>
        <HighlightedText
          text={result.entry.label}
          ranges={result.labelRanges}
          style={styles.resultLabel}
          numberOfLines={1}
        />
        <Text style={styles.resultMeta} numberOfLines={1}>
          {result.entry.breadcrumb}
        </Text>
      </View>
      <Text style={styles.resultScope}>{SCOPE_LABELS[result.entry.scope]}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
  },
  section: {
    paddingTop: theme.spacing[6],
  },
  hidden: {
    display: "none",
  },
  compactSearch: {
    flexDirection: "row",
    paddingTop: theme.spacing[3],
  },
  sectionTitle: {
    // Line up with the pane titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    marginBottom: theme.spacing[4],
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  resultsTitle: {
    marginTop: theme.spacing[6],
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  resultsCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 44,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  resultBorder: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  resultActive: {
    backgroundColor: theme.colors.surface2,
  },
  resultText: {
    flex: 1,
    minWidth: 0,
  },
  resultLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  resultMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  resultScope: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
