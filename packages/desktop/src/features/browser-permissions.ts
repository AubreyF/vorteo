import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type BrowserPermission = "camera" | "microphone" | "location" | "notifications";
export interface PermissionSite {
  origin: string;
  topOrigin: string;
}
export interface PermissionChoice {
  allow: boolean;
  remember: boolean;
}

export function permissionOrigin(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    ? url.origin
    : null;
}

export function requestedPermissions(
  permission: string,
  mediaTypes?: readonly string[],
): BrowserPermission[] {
  if (permission === "geolocation") return ["location"];
  if (permission === "notifications") return ["notifications"];
  if (
    permission !== "media" ||
    !mediaTypes?.length ||
    mediaTypes.some((type) => type !== "audio" && type !== "video")
  )
    return [];
  return [
    ...new Set(
      mediaTypes.map((type) => (type === "audio" ? ("microphone" as const) : ("camera" as const))),
    ),
  ];
}

function key(site: PermissionSite, permission: BrowserPermission): string {
  // A third-party frame never inherits a grant made when that site was a top-level tab.
  return JSON.stringify([site.topOrigin, site.origin, permission]);
}

export async function createBrowserPermissionStore(directory: string) {
  const file = path.join(directory, "browser-permissions.json");
  let choices = new Map<string, boolean>();
  try {
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          typeof entry[1] !== "boolean"
        )
          continue;
        const parts: unknown = JSON.parse(entry[0]);
        if (!Array.isArray(parts) || parts.length !== 3) continue;
        const [top, origin, permission] = parts;
        if (
          typeof top === "string" &&
          typeof origin === "string" &&
          permissionOrigin(top) === top &&
          permissionOrigin(origin) === origin &&
          ["camera", "microphone", "location", "notifications"].includes(permission)
        )
          choices.set(entry[0], entry[1]);
      }
    }
  } catch {
    // Missing or invalid data grants nothing. The next explicit choice replaces it.
    choices.clear();
  }
  let generation = 0;
  let writes = Promise.resolve();
  const persist = (update: () => Map<string, boolean> | null, expectedGeneration: number) => {
    const write = writes.then(async () => {
      if (generation !== expectedGeneration) return;
      const next = update();
      if (!next) return;
      await mkdir(directory, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify([...next]), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      if (generation === expectedGeneration) choices = next;
      return;
    });
    writes = write.catch(() => {});
    return write;
  };
  return {
    get generation() {
      return generation;
    },
    get(site: PermissionSite, permission: BrowserPermission) {
      return choices.get(key(site, permission));
    },
    async remember(
      site: PermissionSite,
      permission: BrowserPermission,
      allow: boolean,
      expectedGeneration: number,
    ) {
      if (generation !== expectedGeneration) return;
      await persist(() => new Map(choices).set(key(site, permission), allow), expectedGeneration);
    },
    async reset() {
      generation++;
      choices = new Map();
      await persist(() => new Map(), generation);
    },
  };
}

export type BrowserPermissionStore = Awaited<ReturnType<typeof createBrowserPermissionStore>>;

export async function decideBrowserPermissions(input: {
  store: BrowserPermissionStore;
  site: PermissionSite;
  permissions: BrowserPermission[];
  isCurrent(): boolean;
  prompt(permission: BrowserPermission): Promise<PermissionChoice>;
}): Promise<boolean> {
  const generation = input.store.generation;
  const current = () => input.isCurrent() && generation === input.store.generation;
  if (!input.permissions.length || !current()) return false;
  for (const permission of input.permissions) {
    const saved = input.store.get(input.site, permission);
    if (saved === false) return false;
    if (saved === true) continue;
    const choice = await input.prompt(permission);
    if (!current()) return false;
    if (choice.remember)
      await input.store.remember(input.site, permission, choice.allow, generation);
    if (!current() || !choice.allow) return false;
  }
  return current();
}
