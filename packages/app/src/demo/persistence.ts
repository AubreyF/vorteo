import type { DemoFilePersistence } from "./file-state";

export const demoFilePersistence: DemoFilePersistence | undefined = undefined;

export const demoChecklistPersistence:
  | import("./checklist-state").DemoChecklistPersistence
  | undefined = undefined;

export const demoConversationPersistence:
  | import("./conversation-state").DemoConversationPersistence
  | undefined = undefined;
