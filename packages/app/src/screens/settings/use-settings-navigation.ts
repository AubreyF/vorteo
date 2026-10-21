import { useCallback, useEffect, useMemo, useState } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from "react-native";
import { useRouter, type Href } from "expo-router";
import { scoreTextFields } from "@getpaseo/protocol/search/text-match";
import { isWeb } from "@/constants/platform";
import type { SettingsView } from "@/navigation/settings-navigation";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  getPane,
  getSection,
  resolveSettingsTarget,
  type SettingsSectionId,
} from "@/settings-catalog/catalog";
import { searchSettings } from "@/settings-catalog/search";
import type {
  ResolvedSettingsEntry,
  SettingsPageSection,
  SettingsScrollRequest,
  SettingsSearchControls,
} from "./settings-scroll-page";

/** Results the arrow keys can reach; matches the result list's length. */
const KEYBOARD_RESULTS = 8;

let requestNonce = 0;

function scrollRequest(
  section: SettingsSectionId,
  pane: string | null,
  entry: ResolvedSettingsEntry | null,
  animated: boolean,
): SettingsScrollRequest {
  requestNonce += 1;
  return { section, pane, entry, animated, nonce: requestNonce };
}

/** `/settings/<section>`, with `?setting=` to land on one row. */
export function settingsLink(section: SettingsSectionId, settingId?: string): Href {
  const path = buildSettingsSectionRoute(section);
  return (settingId ? `${path}?setting=${encodeURIComponent(settingId)}` : path) as Href;
}

/** Panes whose own title, or whose section's, matches the query. */
export function matchPanes(sections: readonly SettingsPageSection[], query: string): Set<string> {
  const matched = new Set<string>();
  if (!query.trim()) return matched;
  const options = { typoTolerant: true, subsequence: false } as const;
  for (const section of sections) {
    const meta = getSection(section.id);
    const sectionHit = scoreTextFields(query, [section.label, ...meta.keywords], options);
    for (const pane of section.panes) {
      if (sectionHit || scoreTextFields(query, [pane.label, ...(pane.keywords ?? [])], options)) {
        matched.add(pane.id);
      }
    }
  }
  return matched;
}

interface SettingsNavigationInput {
  view: SettingsView;
  installationRequested: boolean;
  settingId: string | null;
  isCompactLayout: boolean;
  hasInstallation: boolean;
  sections: readonly SettingsPageSection[];
  entries: readonly ResolvedSettingsEntry[];
}

/**
 * Search, the section in view, and scroll requests for the settings page.
 * Sidebar choices scroll the continuous page on desktop and navigate on
 * compact layouts or from drill-in pages.
 */
export function useSettingsNavigation({
  view,
  installationRequested,
  settingId,
  isCompactLayout,
  hasInstallation,
  sections,
  entries,
}: SettingsNavigationInput) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedResult, setSelectedResult] = useState(0);
  const results = useMemo(() => searchSettings(entries, query), [entries, query]);
  const matchedPanes = useMemo(() => matchPanes(sections, query), [sections, query]);

  const routeSection = view.kind === "section" ? view.section : null;
  const routeTarget = useMemo(() => {
    if (!routeSection) return null;
    // Restart approval links open the installation controls.
    if (installationRequested && hasInstallation) {
      return { section: "maintenance" as const, pane: "maintenance.installation" };
    }
    return resolveSettingsTarget(routeSection);
  }, [hasInstallation, installationRequested, routeSection]);
  const routeEntry = useMemo(
    () => (settingId ? (entries.find((entry) => entry.id === settingId) ?? null) : null),
    [entries, settingId],
  );
  const [request, setRequest] = useState<SettingsScrollRequest>(() =>
    scrollRequest(routeTarget?.section ?? "general", routeTarget?.pane ?? null, null, false),
  );
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    routeTarget?.section ?? "general",
  );
  const routeEntryId = routeEntry?.id ?? null;
  useEffect(() => {
    if (!routeTarget) return;
    setRequest(
      scrollRequest(
        routeEntry?.section ?? routeTarget.section,
        routeEntry?.pane ?? routeTarget.pane,
        routeEntry,
        false,
      ),
    );
    // A new entries array for the same entry must not repeat the jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeTarget, routeEntryId]);

  const handleActiveSectionChange = useCallback(
    (section: SettingsSectionId) => {
      setActiveSection(section);
      // Keep the address on the section being read, so a reload or a copied
      // link returns here, without adding a history entry per section.
      if (isWeb && view.kind === "section" && typeof window !== "undefined") {
        // An address that already opens this section keeps its precision, such
        // as /settings/connections landing on the Connections pane.
        const slug = window.location.pathname.split("/")[2] ?? "";
        if (resolveSettingsTarget(slug).section !== section) {
          window.history.replaceState(window.history.state, "", buildSettingsSectionRoute(section));
        }
      }
    },
    [view.kind],
  );

  const handleChangeQuery = useCallback((next: string) => {
    setQuery(next);
    setSelectedResult(0);
  }, []);

  const navigateTo = useCallback(
    (href: Href) => {
      if (isCompactLayout) router.push(href);
      else router.replace(href);
    },
    [isCompactLayout, router],
  );

  const handleSelectSection = useCallback(
    (section: SettingsSectionId) => {
      setQuery("");
      if (view.kind === "section" && !isCompactLayout) {
        setActiveSection(section);
        setRequest(scrollRequest(section, null, null, true));
        return;
      }
      navigateTo(settingsLink(section));
    },
    [isCompactLayout, navigateTo, view.kind],
  );

  const handleSelectResult = useCallback(
    (entry: ResolvedSettingsEntry) => {
      setQuery("");
      setSelectedResult(0);
      if (view.kind === "section") {
        setRequest(scrollRequest(entry.section, entry.pane, entry, false));
        return;
      }
      navigateTo(settingsLink(entry.section, entry.id));
    },
    [navigateTo, view.kind],
  );

  /** Scrolls to a pane from inside the page, such as an attention row's Review. */
  const openPane = useCallback((paneId: string) => {
    const pane = getPane(paneId);
    if (pane) setRequest(scrollRequest(pane.section, pane.id, null, true));
  }, []);

  const handleSearchKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      const last = Math.min(results.length, KEYBOARD_RESULTS) - 1;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault?.();
        setSelectedResult((index) =>
          key === "ArrowDown" ? Math.min(last, index + 1) : Math.max(0, index - 1),
        );
      } else if (key === "Escape") {
        setQuery("");
      }
    },
    [results.length],
  );

  const handleSearchSubmit = useCallback(() => {
    const result = results[selectedResult] ?? results[0];
    if (result) handleSelectResult(result.entry);
  }, [handleSelectResult, results, selectedResult]);

  const search = useMemo<SettingsSearchControls>(
    () => ({
      query,
      onChangeQuery: handleChangeQuery,
      onKeyPress: handleSearchKeyPress,
      onSubmit: handleSearchSubmit,
    }),
    [handleChangeQuery, handleSearchKeyPress, handleSearchSubmit, query],
  );

  return {
    query,
    search,
    results,
    matchedPanes,
    selectedResult,
    request,
    activeSection,
    handleActiveSectionChange,
    handleSelectSection,
    handleSelectResult,
    openPane,
  };
}
