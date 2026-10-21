import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  maintenanceRecoveryDocument,
  maintenanceRecoveryScript,
} from "../dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-page.js";

function asset(path, content) {
  const bytes = Buffer.from(content);
  if (bytes.length === 0 || bytes.length > 16 * 1024)
    throw new Error("Recovery asset exceeds its native inspection limit");
  return {
    path,
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

await writeFile(
  new URL(
    "../dist/server/server/execution-installation/coordinator-bootstrap-maintenance-recovery-assets.json",
    import.meta.url,
  ),
  JSON.stringify({
    version: 1,
    document: asset("/", maintenanceRecoveryDocument),
    script: asset("/recovery.js", maintenanceRecoveryScript),
  }) + "\n",
  { mode: 0o600 },
);
