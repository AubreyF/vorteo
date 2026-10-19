import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ReceiptSchema = z.object({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) });

/** Resolve on every spawn, including owner-approved restart, rather than pinning the boot release. */
export function resolveManagedWorker(env: NodeJS.ProcessEnv): string | null {
  const link = env.PASEO_MANAGED_RELEASE_LINK;
  const configuredRoot = env.PASEO_MANAGED_RELEASE_ROOT;
  if (!link && !configuredRoot) return null;
  if (!link || !configuredRoot || !path.isAbsolute(link) || !path.isAbsolute(configuredRoot))
    throw new Error("Managed release selection requires an absolute link and root");
  const root = realpathSync(configuredRoot);
  if (path.dirname(link) !== root)
    throw new Error("Managed release link must belong to its release root");
  const release = realpathSync(link);
  if (!release.startsWith(root + path.sep))
    throw new Error("Managed release escaped its configured root");
  ReceiptSchema.parse(
    JSON.parse(readFileSync(path.join(release, ".installation-source.json"), "utf8")),
  );
  const worker = path.join(release, "packages/server/dist/server/server/daemon-worker.js");
  if (realpathSync(worker) !== worker || !statSync(worker).isFile())
    throw new Error("Managed worker must be a regular file inside its release");
  return worker;
}
