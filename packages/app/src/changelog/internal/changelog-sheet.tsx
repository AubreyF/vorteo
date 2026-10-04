import Constants from "expo-constants";
import { useVortonMode } from "@/vorton-mode";
import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ExternalLink, Gift } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { StatusBadge } from "@/components/ui/status-badge";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolveAppVersion } from "@/utils/app-version";
import { openExternalUrl } from "@/utils/open-external-url";
import { useChangelog, type ChangelogState } from "./changelog-source";
import { useRevealedReleases } from "./use-revealed-releases";
import {
  parseChangelog,
  formatChangelogDate,
  type ChangelogRelease,
  type ChangelogSection,
} from "./parse-changelog";

const customMarkdown: unknown = Constants.expoConfig?.extra?.vorteoChangelog;
const customReleases = parseChangelog(typeof customMarkdown === "string" ? customMarkdown : "");

const customState: ChangelogState = { status: "ready", releases: customReleases };

const WEBSITE_CHANGELOG_URL = "https://paseo.sh/changelog";

const ThemedGift = withUnistyles(Gift);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const sheetLeadingIcon = <ThemedGift size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
const websiteButtonStyle = (state: PressableStateCallbackType & { hovered?: boolean }) =>
  iconButtonChromeStyle({ size: "large", state });

interface ChangelogSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function ChangelogSheet({ visible, onClose }: ChangelogSheetProps) {
  const { t } = useTranslation();
  const vorteoMode = useVortonMode();
  const { state, reload } = useChangelog(visible);
  const custom = useRevealedReleases(visible, 1);
  const { count, showMore } = useRevealedReleases(visible && state.status === "ready");

  const handleOpenWebsite = useCallback(() => {
    void openExternalUrl(WEBSITE_CHANGELOG_URL);
  }, []);

  const header: SheetHeader = useMemo(
    () => ({
      title: t("changelog.title"),
      leading: sheetLeadingIcon,
      actions: (
        <Pressable
          onPress={handleOpenWebsite}
          hitSlop={8}
          style={websiteButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={t("changelog.openWebsite")}
          testID="changelog-open-website"
        >
          <ThemedExternalLink
            size={iconButtonChromeGlyphSize("large")}
            uniProps={mutedColorMapping}
          />
        </Pressable>
      ),
    }),
    [handleOpenWebsite, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={620}
      desktopHeight="85%"
      testID="changelog-sheet"
    >
      <View style={styles.releaseList}>
        {vorteoMode ? (
          <View style={styles.releaseList} testID="changelog-vorteo">
            <Text style={styles.sourceTitle}>Vorteo</Text>
            <ChangelogBody
              state={customState}
              shownReleases={custom.count}
              onShowMore={custom.showMore}
              onRetry={reload}
            />
          </View>
        ) : null}
        <View style={styles.releaseList} testID="changelog-paseo">
          {vorteoMode ? <Text style={styles.sourceTitle}>Paseo</Text> : null}
          <ChangelogBody
            state={state}
            shownReleases={count}
            onShowMore={showMore}
            onRetry={reload}
          />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const SNAP_POINTS = ["85%", "95%"];

interface ChangelogBodyProps {
  state: ChangelogState;
  shownReleases: number;
  onShowMore: () => void;
  onRetry: () => void;
}

function ChangelogBody({ state, shownReleases, onShowMore, onRetry }: ChangelogBodyProps) {
  const { t } = useTranslation();
  const appVersion = useMemo(() => resolveAppVersion()?.replace(/^v/i, "") ?? null, []);

  if (state.status === "loading") {
    return (
      <View style={styles.centered}>
        <ThemedLoadingSpinner size="large" uniProps={mutedColorMapping} />
      </View>
    );
  }

  if (state.status === "error") {
    return (
      <View style={styles.centered}>
        <Alert
          variant="error"
          title={t("changelog.error.title")}
          description={t("changelog.error.description")}
          testID="changelog-error"
        >
          <Button variant="outline" size="sm" onPress={onRetry} testID="changelog-retry">
            {t("common.actions.retry")}
          </Button>
        </Alert>
      </View>
    );
  }

  const visibleReleases = state.releases.slice(0, shownReleases);

  return (
    <View style={styles.releaseList}>
      {visibleReleases.map((release) => (
        <ReleaseView
          key={`${release.version}:${release.date}`}
          release={release}
          isCurrent={release.version === appVersion}
        />
      ))}
      {state.releases.length > visibleReleases.length ? (
        <Button
          variant="ghost"
          onPress={onShowMore}
          style={styles.showMore}
          testID="changelog-show-more"
        >
          {t("changelog.showMore")}
        </Button>
      ) : null}
    </View>
  );
}

interface ReleaseViewProps {
  release: ChangelogRelease;
  isCurrent: boolean;
}

const ReleaseView = memo(function ReleaseView({ release, isCurrent }: ReleaseViewProps) {
  const { t } = useTranslation();
  const date = formatChangelogDate(release.date);

  return (
    <View style={styles.release} testID={`changelog-release-${release.version}`}>
      <View style={styles.releaseHeading}>
        <Text style={styles.version}>{release.version}</Text>
        {isCurrent ? <StatusBadge label={t("changelog.installed")} /> : null}
        <View style={styles.headingSpacer} />
        {date ? <Text style={styles.date}>{date}</Text> : null}
      </View>
      {keyChangelogSections(release.sections).map(({ key, section }) => (
        <View key={key} style={styles.section}>
          {section.title ? <Text style={styles.sectionTitle}>{section.title}</Text> : null}
          {section.body ? <MarkdownRenderer text={section.body} compact /> : null}
        </View>
      ))}
    </View>
  );
});

/** A release can repeat a section title; the occurrence keeps the key stable. */
function keyChangelogSections(
  sections: readonly ChangelogSection[],
): { key: string; section: ChangelogSection }[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const title = section.title ?? "";
    const occurrence = seen.get(title) ?? 0;
    seen.set(title, occurrence + 1);
    return { key: `${title}:${occurrence}`, section };
  });
}

const styles = StyleSheet.create((theme) => ({
  sourceTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  centered: {
    flex: 1,
    minHeight: 160,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  releaseList: {
    gap: theme.spacing[8],
    paddingBottom: theme.spacing[4],
  },
  release: {
    gap: theme.spacing[4],
  },
  releaseHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headingSpacer: {
    flex: 1,
  },
  version: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  date: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  showMore: {
    alignSelf: "center",
  },
}));
