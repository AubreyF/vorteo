import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const journalCap = 128 * 1024;
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function removeTemporary(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** One bounded record per immutable assessment under the controller's private,
 * exclusively owned directory. Completed records remain as audit history; no
 * startup initialization, directory scan or deletion is needed to resume one.
 */
export function openQualificationJournal({ root, receiptSha256, authority }) {
  check(/^[a-f0-9]{64}$/.test(receiptSha256), "Invalid qualification journal identity");
  const validate = (state) => {
    check(
      state?.version === 1 &&
        state.decision?.receiptSha256 === receiptSha256 &&
        digest(JSON.stringify(state.decision.receipt)) === receiptSha256 &&
        ["audit", "label", "complete"].includes(state.phase) &&
        typeof state.commentIntent === "boolean" &&
        typeof state.labelIntent === "boolean" &&
        (state.commentId === null ||
          (Number.isSafeInteger(state.commentId) && state.commentId > 0)) &&
        (state.phase === "audit" || state.commentId !== null),
      "Invalid qualification journal state",
    );
    return state;
  };
  return openFactoryPrivateRecord({
    root,
    name: `qualification-${receiptSha256}.json`,
    authority,
    cap: journalCap,
    validate,
  });
}

/** Shared file custody for qualification publication and intake. Callers own
 * their schemas and lifecycle; this is only a bounded, compare-before-write
 * record under the controller's existing exclusive authority.
 */
export function openFactoryPrivateRecord({ root, name, authority, cap, validate }) {
  check(
    /^[a-z0-9-]+\.json$/.test(name) &&
      Number.isSafeInteger(cap) &&
      cap > 0 &&
      cap <= 2 * 1024 * 1024,
    "Invalid Factory private record identity or bound",
  );
  const rootIdentity = lstatSync(root);
  const path = join(root, name);
  const guard = () => {
    authority.assertCurrent();
    const info = lstatSync(root);
    check(
      info.isDirectory() &&
        info.uid === process.getuid() &&
        (info.mode & 0o777) === 0o700 &&
        info.dev === rootIdentity.dev &&
        info.ino === rootIdentity.ino &&
        realpathSync(root) === root,
      "Qualification journal directory changed or is unsafe",
    );
  };
  const read = () => {
    guard();
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    } catch (error) {
      if (error.code === "ENOENT") return { fingerprint: null, state: null };
      throw error;
    }
    try {
      const before = fstatSync(fd);
      check(
        before.isFile() &&
          before.uid === process.getuid() &&
          before.nlink === 1 &&
          (before.mode & 0o777) === 0o600 &&
          before.size <= cap,
        "Unsafe qualification journal file",
      );
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const size = readSync(fd, bytes, count, bytes.length - count, count);
        if (!size) break;
        count += size;
      }
      const after = fstatSync(fd),
        named = lstatSync(path);
      check(
        count === before.size &&
          after.size === before.size &&
          after.mtimeMs === before.mtimeMs &&
          after.ctimeMs === before.ctimeMs &&
          after.dev === named.dev &&
          after.ino === named.ino,
        "Qualification journal changed during read",
      );
      guard();
      const content = bytes.subarray(0, count);
      return {
        fingerprint: digest(content),
        state: validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content))),
      };
    } finally {
      closeSync(fd);
    }
  };
  guard();
  let expected;
  return {
    inspect() {
      return structuredClone(read().state);
    },
    async read() {
      const current = read();
      expected = current.fingerprint;
      return structuredClone(current.state);
    },
    async write(state) {
      check(expected !== undefined, "Read qualification state before writing");
      validate(state);
      const bytes = Buffer.from(JSON.stringify(state));
      check(bytes.length <= cap, "Qualification journal exceeds its bound");
      check(
        read().fingerprint === expected,
        "Qualification journal changed; reconcile before writing",
      );
      const temporary = join(root, `.qualification-${randomUUID()}`);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        guard();
        check(read().fingerprint === expected, "Qualification journal changed before commit");
        renameSync(temporary, path);
        const directory = openSync(
          root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        expected = digest(bytes);
      } finally {
        removeTemporary(temporary);
      }
    },
  };
}
