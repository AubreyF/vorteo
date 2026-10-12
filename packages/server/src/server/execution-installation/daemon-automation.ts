import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DaemonAutomationChangeSchema,
  DaemonAutomationPreferenceSchema,
  type DaemonAutomationPreference,
} from "@getpaseo/protocol/execution-installation";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { RestartRequestError } from "./restarts.js";

/** Owner preference lives with the coordinator, not a browser or a replaceable daemon. */
export class DaemonAutomation {
  private readonly file: string;
  constructor(
    private readonly stateDir: string,
    private readonly legacyHostOnly: boolean,
  ) {
    this.file = path.join(stateDir, "daemon-automation.json");
  }

  read(): DaemonAutomationPreference {
    if (!existsSync(this.file)) {
      return {
        revision: null,
        enabled: false,
        enabledAfter: null,
        legacyHostOnly: this.legacyHostOnly,
      };
    }
    const state = DaemonAutomationPreferenceSchema.parse(
      JSON.parse(readFileSync(this.file, "utf8")),
    );
    if (
      !state.revision ||
      state.legacyHostOnly ||
      state.enabled !== (state.enabledAfter !== null)
    ) {
      throw new RestartRequestError("Invalid retained daemon automation preference");
    }
    return state;
  }

  activation(): string | null | undefined {
    const state = this.read();
    if (state.revision === null) return undefined;
    return state.enabledAfter;
  }

  change(input: unknown): DaemonAutomationPreference {
    const change = DaemonAutomationChangeSchema.parse(input);
    const current = this.read();
    if (change.expectedRevision !== current.revision) {
      throw new RestartRequestError("Daemon automation preference changed. Refresh before saving.");
    }
    if (current.revision !== null && current.enabled === change.enabled) return current;
    const next: DaemonAutomationPreference = {
      revision: randomUUID(),
      enabled: change.enabled,
      enabledAfter: change.enabled ? new Date().toISOString() : null,
      legacyHostOnly: false,
    };
    writePrivateFileAtomicSync(this.file, JSON.stringify(next));
    // The preference must survive power loss before the queue can grant authority.
    for (const target of [this.file, this.stateDir]) {
      const fd = openSync(target, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return next;
  }
}
