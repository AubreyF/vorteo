import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { InstallationNameSchema } from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";

const StoredNameSchema = z.strictObject({ name: InstallationNameSchema });

/**
 * The owner's display name for this installation, such as "Vorteo Lab", so two
 * installations open side by side are never confused. Unset means "Vorteo".
 * Coordinator-owned and served in the page descriptor, so it shows before sign-in.
 */
export function createInstallationNameStore(stateDir: string) {
  const file = path.join(stateDir, "installation-name.json");
  return {
    read(): string | undefined {
      if (!existsSync(file)) return undefined;
      try {
        return StoredNameSchema.parse(JSON.parse(readFileSync(file, "utf8"))).name;
      } catch {
        // A damaged file must never stop the interface from loading.
        return undefined;
      }
    },
    write(name: string | null): string | undefined {
      if (name === null) {
        writePrivateFileAtomicSync(file, JSON.stringify({}));
        return undefined;
      }
      const parsed = InstallationNameSchema.parse(name);
      writePrivateFileAtomicSync(file, JSON.stringify({ name: parsed }));
      return parsed;
    },
  };
}
