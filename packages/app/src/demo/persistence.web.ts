import type { DemoFilePersistence } from "./file-state";
import { isDemoSession } from "./mode";

// Tab-local demo storage, cleared by Reset's existing vorteo:demo: namespace cleanup.
const KEY = "vorteo:demo:files:v1";
export const demoFilePersistence: DemoFilePersistence = {
  load() {
    if (typeof window === "undefined" || !isDemoSession()) return null;
    return JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");
  },
  save(snapshot) {
    if (typeof window === "undefined" || !isDemoSession()) return;
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  },
};

export const demoChecklistPersistence: import("./checklist-state").DemoChecklistPersistence = {
  load() {
    if (typeof window === "undefined" || !isDemoSession()) return null;
    return JSON.parse(window.sessionStorage.getItem("vorteo:demo:checklists:v1") ?? "null");
  },
  save(snapshot) {
    if (typeof window === "undefined" || !isDemoSession()) return;
    window.sessionStorage.setItem("vorteo:demo:checklists:v1", JSON.stringify(snapshot));
  },
};

export const demoConversationPersistence: import("./conversation-state").DemoConversationPersistence =
  {
    load() {
      if (typeof window === "undefined" || !isDemoSession()) return null;
      return JSON.parse(window.sessionStorage.getItem("vorteo:demo:conversations:v1") ?? "null");
    },
    save(snapshot) {
      if (typeof window === "undefined" || !isDemoSession()) return;
      window.sessionStorage.setItem("vorteo:demo:conversations:v1", JSON.stringify(snapshot));
    },
  };
