import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

import { useVortonUpdate } from "./use-update";

export function VortonUpdateCalloutSource() {
  const { t } = useTranslation();
  const update = useVortonUpdate(true);
  const callouts = useSidebarCallouts();
  const router = useRouter();
  const review = useCallback(() => router.push(buildSettingsSectionRoute("general")), [router]);
  useEffect(() => {
    if (update.isError || !update.data || !["available", "diverged"].includes(update.data.status))
      return;
    return callouts.show({
      id: "vorton-source-update",
      dismissalKey: `vorton-source-update:${update.data.latestCommit}`,
      title: t("settings.about.vortonUpdates.notice"),
      description: t("settings.about.vortonUpdates.available", {
        count: update.data.incomingCommits,
      }),
      priority: 10,
      actions: [
        { label: t("settings.about.vortonUpdates.review"), onPress: review, variant: "secondary" },
      ],
      testID: "vorton-update-notice",
    });
  }, [update.data, update.isError, callouts, review, t]);
  return null;
}
