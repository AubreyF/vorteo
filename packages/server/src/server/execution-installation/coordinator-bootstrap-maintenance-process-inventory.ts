import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { BootstrapProcessIdentitySchema } from "@getpaseo/protocol/coordinator-bootstrap";
import type { inspectSelectedCoordinatorRuntime } from "./coordinator-bootstrap-renewal.js";
import type { RecoveryBootWitness } from "./coordinator-bootstrap-maintenance-recovery-proof.js";
import { BootstrapRequestConflict } from "./coordinator-bootstrap.js";

// The native SDK defines PROC_UID_ONLY and proc_listpidspath. Match kernel
// file references, including executable mappings, rather than process titles.
const inventory = `
import ctypes,json,os,sys
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
lib.proc_listpidspath.argtypes=[ctypes.c_uint32,ctypes.c_uint32,ctypes.c_char_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_int]
lib.proc_listpidspath.restype=ctypes.c_int
uid=os.getuid()
paths=json.loads(sys.argv[1])
capacity=65536
found=set()
for attempt in range(2):
    for path in paths:
        buf=(ctypes.c_int*capacity)()
        ctypes.set_errno(0)
        size=lib.proc_listpidspath(4,uid,os.fsencode(path),0,buf,ctypes.sizeof(buf))
        if size<0 or size>=ctypes.sizeof(buf) or size%ctypes.sizeof(ctypes.c_int):
            raise RuntimeError('Native runtime reference inventory incomplete')
        found.update(pid for pid in buf[:size//ctypes.sizeof(ctypes.c_int)] if pid>0)
print(json.dumps({'uid':uid,'complete':True,'pids':sorted(found)}))
`;

const InventorySchema = z.strictObject({
  uid: z.number().int().nonnegative(),
  complete: z.literal(true),
  pids: z.array(z.number().int().positive()).max(65536),
});

/** Read-only, bounded native inventory used after predecessor exclusion.
 * Unknown processes and incomplete enumeration are errors, never absence. */
export function assertMaintenanceRuntimeProcessesAbsent(input: {
  uid: number;
  executables: readonly string[];
  allowedProcesses?: readonly Pick<RecoveryBootWitness, "process" | "assertCurrent">[];
  coordinator?: NonNullable<Awaited<ReturnType<typeof inspectSelectedCoordinatorRuntime>>>;
}): void {
  if (process.platform !== "darwin" || input.uid !== process.getuid?.())
    throw new BootstrapRequestConflict("Runtime inventory requires native owner custody");
  if (
    input.executables.length < 1 ||
    input.executables.length > 2 ||
    input.executables.some((file) => !file.startsWith("/") || realpathSync(file) !== file)
  )
    throw new BootstrapRequestConflict("Runtime inventory paths are not canonical reviewed slots");
  const allowed = input.allowedProcesses ?? [];
  if (allowed.length > 2)
    throw new BootstrapRequestConflict("Runtime inventory has too many retained executors");
  const witnesses = [...allowed];
  if (input.coordinator) {
    if (
      input.coordinator.target !== "coordinator" ||
      input.coordinator.process.parentPid !== 1 ||
      !input.executables.includes(input.coordinator.process.executable) ||
      allowed.some(
        (item) =>
          item.process.bootId !== input.coordinator!.process.bootId ||
          item.process.pid === input.coordinator!.process.pid,
      )
    )
      throw new BootstrapRequestConflict(
        "Shared runtime coordinator witness differs from native executors",
      );
    witnesses.push(input.coordinator);
  }
  const identities = witnesses.map((item) => BootstrapProcessIdentitySchema.parse(item.process));
  const assertAllowed = () => {
    for (const [index, item] of witnesses.entries()) {
      if (
        identities[index]!.uid !== input.uid ||
        !isDeepStrictEqual(identities[index], item.process) ||
        item.assertCurrent() !== undefined
      )
        throw new BootstrapRequestConflict("Runtime inventory executor custody changed");
    }
  };
  assertAllowed();
  const raw = execFileSync(
    "/usr/bin/python3",
    ["-I", "-B", "-c", inventory, JSON.stringify(input.executables)],
    {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 2000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assertAllowed();
  requireMaintenanceRuntimeAbsence(
    JSON.parse(raw),
    input.uid,
    identities.map((item) => item.pid),
  );
}

export function requireMaintenanceRuntimeAbsence(
  value: unknown,
  uid: number,
  allowedPids: readonly number[] = [],
): void {
  const result = InventorySchema.parse(value);
  if (result.uid !== uid || result.pids.some((pid) => !allowedPids.includes(pid)))
    throw new BootstrapRequestConflict(
      "Reviewed runtime still has a native process or different owner",
    );
}
