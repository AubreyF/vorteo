import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Notification } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { requestProfilePicker } from "./picker-request";

const LEGACY_QUOTA_MESSAGE =
  "Account usage limit reached. Open the preset picker to reset utilization, then send your next message here. You can also choose another preset to continue in a new task.";

interface QuotaNoticeProps {
  serverId: string;
  agentId: string;
}

/** Replaces a provider's quota exhaustion error with a recovery path. */
export function QuotaNotice({ serverId, agentId }: QuotaNoticeProps) {
  const { t } = useTranslation();
  const canSwitch = useHostFeature(serverId, "agentProfileSwitch");
  const openPicker = useCallback(
    () => requestProfilePicker({ serverId, agentId }),
    [serverId, agentId],
  );
  const action = useMemo(
    () => (
      <Button variant="outline" size="md" onPress={openPicker} testID="quota-switch-account">
        {t("message.profileSwitch.quota.action")}
      </Button>
    ),
    [openPicker, t],
  );
  if (!canSwitch) return <Notification level="warning" message={LEGACY_QUOTA_MESSAGE} />;
  return (
    <Notification
      level="warning"
      message={t("message.profileSwitch.quota.message")}
      action={action}
    />
  );
}
