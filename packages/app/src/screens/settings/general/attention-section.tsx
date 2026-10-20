import { useCallback } from "react";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useRestartsAwaitingApproval } from "@/execution-installation/panel";
import {
  installationDefaultServerId,
  readExecutionInstallation,
} from "@/execution-installation/policy";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { useVortonUpdate } from "@/vorton-updates/use-update";

interface AttentionItem {
  id: string;
  label: string;
  hint: string;
  pane: string;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function useAttentionItems(): AttentionItem[] {
  const restarts = useRestartsAwaitingApproval();
  const update = useVortonUpdate();
  const hosts = useHosts();
  const serverId = installationDefaultServerId(readExecutionInstallation()) ?? hosts[0]?.serverId;
  const { entries } = useProvidersSnapshot(serverId ?? null);
  const items: AttentionItem[] = [];
  if (restarts > 0) {
    items.push({
      id: "restarts",
      label: `${pluralize(restarts, "restart request")} waiting for approval`,
      hint: "Review the reason and approve or cancel in Maintenance.",
      pane: "maintenance.installation",
    });
  }
  const status = update.data?.status;
  if (status === "available" || status === "diverged") {
    items.push({
      id: "update",
      label: "Vorteo update available",
      hint: `${pluralize(update.data?.incomingCommits ?? 0, "new commit")} on main.`,
      pane: "maintenance.updates",
    });
  }
  for (const entry of entries ?? []) {
    if (!entry.enabled || entry.status !== "error") continue;
    items.push({
      id: `account:${entry.provider}`,
      label: `${entry.label ?? entry.provider} needs attention`,
      hint: entry.error ?? "This account cannot start agents.",
      pane: "accounts.providers",
    });
  }
  return items;
}

function AttentionRow({
  item,
  onOpenPane,
}: {
  item: AttentionItem;
  onOpenPane: (pane: string) => void;
}) {
  const open = useCallback(() => onOpenPane(item.pane), [item.pane, onOpenPane]);
  return (
    <SettingsRow label={item.label} hint={item.hint} testID={`settings-attention-${item.id}`}>
      <Button variant="outline" size="sm" onPress={open}>
        Review
      </Button>
    </SettingsRow>
  );
}

/**
 * What needs the owner's action across Settings, at the top of General. Renders
 * nothing when all is well, so General leads with everyday defaults.
 */
export function AttentionSection({ onOpenPane }: { onOpenPane: (pane: string) => void }) {
  const items = useAttentionItems();
  if (items.length === 0) return null;
  return (
    <SettingsSection title="Needs attention" testID="settings-attention">
      <SettingsCard>
        {items.map((item) => (
          <AttentionRow key={item.id} item={item} onOpenPane={onOpenPane} />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
