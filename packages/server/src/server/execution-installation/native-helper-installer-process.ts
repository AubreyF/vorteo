import { execFile } from "node:child_process";

export interface InstallerPresence {
  state: "present" | "absent" | "unverified";
}

/** PID occupancy is diagnostic evidence only. A reused PID or surviving child
 * cannot authorize cleanup or replay of an interrupted installation. */
export function inspectInstallerPresence(pid: number): Promise<InstallerPresence> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647)
    return Promise.resolve({ state: "unverified" });
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "pid="],
      { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 5000, maxBuffer: 1024 },
      (error, stdout, stderr) => {
        if (!error && stdout.trim() === String(pid)) {
          resolve({ state: "present" });
          return;
        }
        // ps exits 1 with no output when that PID is absent. Other errors,
        // including timeouts and permission failures, prove nothing.
        if (error?.code === 1 && !stdout.trim() && !stderr.trim()) {
          resolve({ state: "absent" });
          return;
        }
        resolve({ state: "unverified" });
      },
    );
  });
}
