import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { BootstrapRequestConflict } from "./coordinator-bootstrap-errors.js";
import { SESSION_HOST_ENTRYPOINT } from "./session-host-job.js";

/** One proposed switch of a release link to a candidate release directory. */
export interface ReleaseSelection {
  link: string;
  candidate: string;
}

export type ReleaseSelectionGuard = (selection: ReleaseSelection) => void;

/** A release that cannot run beside the installed session host job. */
export class SessionHostReleaseRefused extends BootstrapRequestConflict {
  constructor(readonly release: string) {
    super(`Remove the session host job first: release ${release} has no session host support.`);
    this.name = "SessionHostReleaseRefused";
  }
}

let registered: ReleaseSelectionGuard | null = null;

/** The link's own path with its parent's symlinks resolved; the link itself is not followed. */
function linkIdentity(link: string): string {
  try {
    return path.join(realpathSync(path.dirname(link)), path.basename(link));
  } catch {
    return path.resolve(link);
  }
}

/**
 * The coordinator registers its guard once at startup. Every Host release selection, from source
 * updates and from supervisor maintenance alike, then passes through the same check. Selection
 * code runs deep in custody-checked paths with no configuration of its own, so the guard is
 * registered rather than passed down.
 */
export function setReleaseSelectionGuard(guard: ReleaseSelectionGuard | null): void {
  registered = guard;
}

/** Throws when the registered guard refuses the selection; checks nothing when none is set. */
export function assertReleaseSelectionAllowed(selection: ReleaseSelection): void {
  registered?.(selection);
}

/**
 * Refuses to select a release without the session host entrypoint through the Host's current
 * link while the session host job is installed: its daemon does not know about hosted sessions
 * and would start a second provider beside a host still running them. Removing the job first
 * requires the setting off and no hosted sessions, so an old release never meets a live host.
 */
export function createSessionHostReleaseGuard(input: {
  currentReleaseLink: string;
  plistPath: string;
  exists?: (file: string) => boolean;
}): ReleaseSelectionGuard {
  const exists = input.exists ?? existsSync;
  return ({ link, candidate }) => {
    if (linkIdentity(link) !== linkIdentity(input.currentReleaseLink)) return;
    if (!exists(input.plistPath)) return;
    if (exists(path.join(candidate, SESSION_HOST_ENTRYPOINT))) return;
    throw new SessionHostReleaseRefused(path.basename(candidate));
  };
}
