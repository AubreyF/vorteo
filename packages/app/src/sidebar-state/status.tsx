import { useQueryClient } from "@tanstack/react-query";
import { SidebarCallout } from "@/components/sidebar-callout";
import { useSidebarSyncStatus } from "./use-sidebar-sync";

export function SidebarSyncNotice() {
  const status = useSidebarSyncStatus((state) => state.status);
  const error = useSidebarSyncStatus((state) => state.error);
  const queries = useQueryClient();
  if (status !== "pending" && status !== "syncing") return null;
  if (status === "syncing")
    return <SidebarCallout title="Syncing sidebar…" testID="sidebar-sync-pending" />;
  return (
    <SidebarCallout
      title="Sidebar sync paused"
      description={error}
      variant="error"
      testID="sidebar-sync-error"
      actions={[
        {
          label: "Retry",
          onPress: () => {
            void queries.invalidateQueries({ queryKey: ["sidebar-state"] });
          },
        },
      ]}
    />
  );
}
