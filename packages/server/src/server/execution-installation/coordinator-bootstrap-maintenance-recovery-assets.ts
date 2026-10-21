import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import {
  assertBootstrapPathsProtected,
  readProtectedDocument,
} from "./coordinator-bootstrap-artifact.js";
import { retainServiceFiles } from "./coordinator-bootstrap-maintenance-service-inspection.js";
import {
  maintenanceRecoveryDocument,
  maintenanceRecoveryScript,
} from "./coordinator-bootstrap-maintenance-recovery-page.js";

const asset = z.object({
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MaintenanceRecoveryAssetsSchema = z
  .object({
    version: z.literal(1),
    document: asset.extend({ path: z.literal("/") }).strict(),
    script: asset.extend({ path: z.literal("/recovery.js") }).strict(),
  })
  .strict();
export type MaintenanceRecoveryAssets = z.infer<typeof MaintenanceRecoveryAssetsSchema>;
const packagedManifest = new URL(
  "./coordinator-bootstrap-maintenance-recovery-assets.json",
  import.meta.url,
);
const knownModule = fileURLToPath(
  new URL("./coordinator-bootstrap-maintenance-recovery-page.js", import.meta.url),
);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function knownMaintenanceRecoveryAssets(): MaintenanceRecoveryAssets {
  const document = Buffer.from(maintenanceRecoveryDocument);
  const script = Buffer.from(maintenanceRecoveryScript);
  return {
    version: 1,
    document: { path: "/", byteLength: document.length, sha256: hash(document) },
    script: { path: "/recovery.js", byteLength: script.length, sha256: hash(script) },
  };
}

/** The selected runtime was artifact-verified by the caller. Read data only;
 * importing its module would execute target code inside the observer. */
export async function readSelectedMaintenanceRecoveryAssets(input: {
  runtimeDirectory: string;
  writableMountRoots: readonly string[];
}) {
  const directory = path.join(
    input.runtimeDirectory,
    "packages/server/dist/server/server/execution-installation",
  );
  const manifest = path.join(directory, path.basename(fileURLToPath(packagedManifest)));
  await assertBootstrapPathsProtected([directory], input.writableMountRoots);
  try {
    await lstat(manifest);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const selectedModule = path.join(
      directory,
      "coordinator-bootstrap-maintenance-recovery-page.js",
    );
    const assertCurrent = retainServiceFiles([selectedModule, knownModule]);
    const selected = await readProtectedDocument(selectedModule);
    const known = await readProtectedDocument(knownModule);
    if (hash(selected) !== hash(known))
      throw new BootstrapRequestConflict(
        "Legacy recovery assets differ from the verified observer",
      );
    assertCurrent();
    return { assets: knownMaintenanceRecoveryAssets(), assertCurrent };
  }
  const assertCurrent = retainServiceFiles([manifest]);
  const assets = MaintenanceRecoveryAssetsSchema.parse(
    JSON.parse((await readProtectedDocument(manifest)).toString("utf8")),
  );
  assertCurrent();
  return { assets, assertCurrent };
}
