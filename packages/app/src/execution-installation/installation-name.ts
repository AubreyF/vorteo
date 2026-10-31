import { useSyncExternalStore } from "react";
import { readExecutionInstallation } from "./policy";

export const DEFAULT_INSTALLATION_NAME = "Vorteo";

// The coordinator serves the name in the page descriptor; a save updates this copy
// so every surface changes at once without a reload.
let saved: string | null | undefined;
const listeners = new Set<() => void>();

function current(): string {
  if (saved !== undefined) return saved ?? DEFAULT_INSTALLATION_NAME;
  return readExecutionInstallation()?.name ?? DEFAULT_INSTALLATION_NAME;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The owner's name for this installation, or "Vorteo" outside an installation. */
export function useInstallationName(): string {
  return useSyncExternalStore(subscribe, current, current);
}

export async function saveInstallationName(name: string): Promise<string> {
  const response = await fetch("/api/installation/owner/name", {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || null }),
  });
  if (response.status === 401)
    throw new Error("Unlock Installation controls in Maintenance settings to rename it.");
  if (response.status === 400) throw new Error("Use a name of 40 characters or fewer.");
  if (!response.ok) throw new Error("Unable to save the installation name.");
  const body = (await response.json()) as { name: string | null };
  saved = body.name;
  if (typeof document !== "undefined") document.title = current();
  for (const listener of listeners) listener();
  return current();
}
