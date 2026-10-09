import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = [
  "version",
  "installationId",
  "epoch",
  "token",
  "supervisorPid",
  "lockDevice",
  "lockInode",
].sort();

function record(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1 ||
      info.size > 16384
    )
      throw new Error("Unsafe Factory ownership record");
    const value = JSON.parse(readFileSync(fd, "utf8"));
    if (
      !value ||
      !isDeepStrictEqual(Object.keys(value).sort(), fields) ||
      value.version !== 1 ||
      !uuid.test(value.installationId) ||
      !uuid.test(value.token) ||
      ["epoch", "supervisorPid", "lockInode"].some(
        (key) => !Number.isSafeInteger(value[key]) || value[key] < 1,
      ) ||
      !Number.isSafeInteger(value.lockDevice) ||
      value.lockDevice < 0
    )
      throw new Error("Invalid Factory ownership record");
    return Object.freeze(value);
  } finally {
    closeSync(fd);
  }
}

/** Call only in the supervised daemon. Both trusted processes retain the flock;
 * Paseo maps its daemon copy independently of the supervisor's descriptor number.
 * This guard fences dispatch. Settlement still needs the native custody receipt.
 */
export function captureControllerOwnership(environment = process.env) {
  const root = environment.VORTON_FACTORY_STATE_ROOT;
  const descriptor = environment.VORTON_FACTORY_LOCK_FD;
  const daemonDescriptor = environment.PASEO_CONTROLLER_LIFETIME_FD;
  if (
    process.platform !== "linux" ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    realpathSync(root) !== root ||
    !/^[0-9]+$/.test(descriptor ?? "") ||
    !/^[0-9]+$/.test(daemonDescriptor ?? "") ||
    !Number.isSafeInteger(Number(daemonDescriptor)) ||
    Number(daemonDescriptor) < 3
  )
    throw new Error("Factory requires its container-local ownership launcher");
  const directory = lstatSync(root);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe Factory state directory");
  const identity = record(join(root, "controller.json"));
  if (identity.token !== environment.VORTON_FACTORY_OWNER_TOKEN)
    throw new Error("Factory launcher token does not match ownership");
  let revoked = false;
  const assertCurrent = () => {
    if (revoked) throw new Error("Factory controller authority was revoked");
    try {
      if (!process.connected || process.ppid !== identity.supervisorPid)
        throw new Error("Factory supervisor connection was lost");
      const currentDirectory = lstatSync(root);
      if (
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino ||
        currentDirectory.uid !== directory.uid ||
        (currentDirectory.mode & 0o777) !== 0o700
      )
        throw new Error("Factory state directory changed");
      if (!isDeepStrictEqual(record(join(root, "controller.json")), identity))
        throw new Error("Factory controller ownership changed");
      const lock = lstatSync(join(root, "controller.lock"));
      const held = statSync(`/proc/${identity.supervisorPid}/fd/${descriptor}`);
      const daemonHeld = fstatSync(Number(daemonDescriptor));
      for (const info of [lock, held, daemonHeld]) {
        if (
          !info.isFile() ||
          info.dev !== identity.lockDevice ||
          info.ino !== identity.lockInode ||
          info.uid !== process.getuid() ||
          (info.mode & 0o777) !== 0o600 ||
          info.nlink !== 1
        )
          throw new Error("Factory supervisor lock identity changed");
      }
    } catch (error) {
      // Authority cannot revive in this runtime, even if an old record is restored.
      revoked = true;
      throw error;
    }
  };
  assertCurrent();
  return Object.freeze({
    root,
    identity,
    assertCurrent,
    revoke: () => {
      revoked = true;
    },
  });
}
