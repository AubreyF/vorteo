import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { DemoSession } from "./session";
import { createDemoTransport } from "./transport";
import { DEMO_SERVER_ID } from "./scenario";

import {
  demoFilePersistence,
  demoChecklistPersistence,
  demoConversationPersistence,
} from "./persistence";

const session = new DemoSession(
  demoFilePersistence,
  demoChecklistPersistence,
  demoConversationPersistence,
);

export function createDemoClient(serverId: string, clientId: string): DaemonClient {
  if (serverId !== DEMO_SERVER_ID)
    throw new Error("Real host connections are disabled in the demo.");
  return new DaemonClient({
    url: "ws://demo.invalid/ws",
    clientId,
    expectedServerId: DEMO_SERVER_ID,
    transportFactory: () => createDemoTransport(session),
    providerSnapshots: "wire",
    reconnect: { enabled: false },
  });
}
