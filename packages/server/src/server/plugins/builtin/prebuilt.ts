import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Built-in plugin bundles compiled when the release is built. Compiling every built-in with
 * esbuild at daemon start took about a second idle and tens of seconds under load, and the
 * daemon accepts no connections until plugins start. A bundle is used only when its plugin's
 * source files and the daemon version still match what it was built from; otherwise the daemon
 * compiles as before. Development checkouts run from `plugins/`, which has no prebuilt files.
 */
export const PREBUILT_BUNDLES_FILE = "prebuilt-bundles.json";

const FORMAT = 1;

const prebuiltSchema = z.object({
  format: z.literal(FORMAT),
  sourceDigest: z.string(),
  bundleDigest: z.string(),
  serverBundle: z.string().nullable(),
  clientBundle: z.string().nullable(),
});

export interface PluginBundles {
  serverBundle: string | null;
  clientBundle: string | null;
}

export type PrebuiltBundlesResult =
  | { status: "loaded"; bundles: PluginBundles }
  | { status: "missing" }
  | { status: "stale"; reason: string };

async function listSourceFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === "node_modules" || child === PREBUILT_BUNDLES_FILE) continue;
    if (entry.isDirectory()) files.push(...(await listSourceFiles(directory, child)));
    else files.push(child);
  }
  return files;
}

/** Hashes every file the plugin ships, with its relative path, plus the daemon version. */
export async function builtinSourceDigest(directory: string, daemonVersion: string) {
  const hash = createHash("sha256").update(`format ${FORMAT}\0version ${daemonVersion}\0`);
  for (const file of (await listSourceFiles(directory)).sort()) {
    const content = await readFile(path.join(directory, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  return hash.digest("hex");
}

function bundleDigest(bundles: PluginBundles) {
  return createHash("sha256")
    .update(JSON.stringify([bundles.serverBundle, bundles.clientBundle]))
    .digest("hex");
}

/** Writes compiled bundles beside the plugin source they were compiled from. */
export async function writePrebuiltBundles(
  directory: string,
  daemonVersion: string,
  bundles: PluginBundles,
): Promise<void> {
  const record: z.infer<typeof prebuiltSchema> = {
    format: FORMAT,
    sourceDigest: await builtinSourceDigest(directory, daemonVersion),
    bundleDigest: bundleDigest(bundles),
    serverBundle: bundles.serverBundle,
    clientBundle: bundles.clientBundle,
  };
  await writeFile(path.join(directory, PREBUILT_BUNDLES_FILE), JSON.stringify(record));
}

/** Returns the prebuilt bundles only when both the source and the bundle digests verify. */
export async function readPrebuiltBundles(
  directory: string,
  daemonVersion: string,
): Promise<PrebuiltBundlesResult> {
  const text = await readFile(path.join(directory, PREBUILT_BUNDLES_FILE), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (text === null) return { status: "missing" };
  let parsed: z.infer<typeof prebuiltSchema>;
  try {
    parsed = prebuiltSchema.parse(JSON.parse(text));
  } catch {
    return { status: "stale", reason: "unreadable prebuilt file" };
  }
  const bundles = { serverBundle: parsed.serverBundle, clientBundle: parsed.clientBundle };
  if (bundleDigest(bundles) !== parsed.bundleDigest) {
    return { status: "stale", reason: "bundle digest mismatch" };
  }
  if ((await builtinSourceDigest(directory, daemonVersion)) !== parsed.sourceDigest) {
    return { status: "stale", reason: "plugin source or daemon version changed" };
  }
  return { status: "loaded", bundles };
}
