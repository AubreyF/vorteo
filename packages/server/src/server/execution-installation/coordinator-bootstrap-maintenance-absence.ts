import { execFileSync } from "node:child_process";
import { z } from "zod";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

/** A failed print is not absence unless the native service manager names the
 * exact missing service in this user's domain. Timeouts and permission errors
 * must remain uncertainty, including inside the final lifecycle transaction. */
export function assertMaintenanceServiceAbsent(service: string): void {
  if (inspectMaintenanceServicePresence(service) !== "absent")
    throw new BootstrapRequestConflict("Maintenance service is still registered");
}

/** Branch selection only. A later observation must retain native custody. */
export function inspectMaintenanceServicePresence(service: string): "registered" | "absent" {
  requireLocalService(service);
  try {
    execFileSync("/bin/launchctl", ["print", service], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    requireMaintenanceServiceAbsenceResult(service, error);
    return "absent";
  }
  return "registered";
}

export function requireMaintenanceServiceAbsenceResult(service: string, value: unknown): void {
  const { uid, label } = requireLocalService(service);
  const result = z
    .object({
      status: z.literal(113),
      signal: z.null().optional(),
      stderr: z.string(),
    })
    .safeParse(value);
  const expected = `Bad request.\nCould not find service "${label}" in domain for user gui: ${uid}`;
  if (!result.success || result.data.stderr.trim() !== expected)
    throw new BootstrapRequestConflict("Maintenance service absence is unproven");
}

function requireLocalService(service: string) {
  const uid = process.getuid?.();
  const match =
    /^gui\/(\d+)\/(local\.vorteo\.[a-zA-Z0-9.-]+\.installation(?:-recovery-[a-f0-9-]{36})?)$/.exec(
      service,
    );
  if (uid === undefined || !match || match[1] !== String(uid))
    throw new BootstrapRequestConflict(
      "Maintenance absence target is outside enrolled user custody",
    );
  return { uid, label: match[2] };
}
