import { isIsolatedDemoPreview } from "./preview";

const SESSION_KEY = "vorteo:demo-active";
const GENERATION_KEY = "vorteo:demo-generation";
const DATABASES_KEY = "vorteo:demo-databases";

function readDemoSession(): boolean {
  if (typeof window === "undefined") return false;
  if (new URL(window.location.href).searchParams.get("demo") === "1") {
    window.sessionStorage.setItem(SESSION_KEY, "1");
  }
  return window.sessionStorage.getItem(SESSION_KEY) === "1";
}

// Changes take effect after a full navigation, before any host stores are constructed.
const active = readDemoSession();
const isolatedStorage = active || isIsolatedDemoPreview;
function readGeneration(): string {
  if (!isolatedStorage) return "inactive";
  const existing = window.sessionStorage.getItem(GENERATION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(GENERATION_KEY, created);
  return created;
}
const generation = readGeneration();
if (isolatedStorage) {
  const saved: unknown = JSON.parse(window.sessionStorage.getItem(DATABASES_KEY) ?? "[]");
  if (Array.isArray(saved)) {
    const retained: string[] = [];
    for (const name of saved) {
      if (typeof name !== "string" || !name.startsWith("vorteo-demo:")) continue;
      if (name.startsWith(`vorteo-demo:${generation}:`)) retained.push(name);
      else indexedDB.deleteDatabase(name);
    }
    window.sessionStorage.setItem(DATABASES_KEY, JSON.stringify(retained));
  }
}
export function isDemoSession(): boolean {
  return active;
}
export function demoStorageName(name: string): string {
  if (!isolatedStorage) return name;
  const scoped = `vorteo-demo:${generation}:${name}`;
  const names: unknown = JSON.parse(window.sessionStorage.getItem(DATABASES_KEY) ?? "[]");
  const known = Array.isArray(names)
    ? names.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!known.includes(scoped))
    window.sessionStorage.setItem(DATABASES_KEY, JSON.stringify([...known, scoped]));
  return scoped;
}

export function resetDemo(): void {
  window.sessionStorage.setItem(GENERATION_KEY, crypto.randomUUID());
  for (const key of Object.keys(window.sessionStorage)) {
    if (key.startsWith("vorteo:demo:")) window.sessionStorage.removeItem(key);
  }
  window.location.assign("/?demo=1");
}

export function enterDemo(): void {
  window.sessionStorage.setItem(SESSION_KEY, "1");
  window.location.assign("/?demo=1");
}

export function exitDemo(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
  window.location.assign("/welcome");
}
