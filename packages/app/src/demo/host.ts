import type { HostProfile } from "@/types/host-connection";
import { DEMO_SERVER_ID, DEMO_TIMESTAMP } from "./scenario";

export const DEMO_HOST: HostProfile = {
  serverId: DEMO_SERVER_ID,
  label: "Demo",
  appearance: { color: "none", badgeDisplay: "name" },
  lifecycle: {},
  connections: [
    { id: "demo-connection", type: "directTcp", endpoint: "demo.invalid:1", useTls: false },
  ],
  preferredConnectionId: "demo-connection",
  createdAt: DEMO_TIMESTAMP,
  updatedAt: DEMO_TIMESTAMP,
};
