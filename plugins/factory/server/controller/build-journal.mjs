import { constants } from "node:fs";
import { open, lstat, realpath, rename, unlink, link } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const cap = 8 * 1024 * 1024;
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Protected local storage under the build coordinator's existing exclusive
 * lifetime authority. Never initialize automatically on restart. History is
 * retained; reaching the storage bound holds admission rather than forgetting
 * request IDs or verified receipts. Trusted private ancestors are required.
 */
export async function openBuildJournal({ root, repository, authority }) {
  const identity = await lstat(root);
  const guard = async () => {
    authority.assertCurrent();
    const current = await lstat(root);
    check(
      (await realpath(root)) === root &&
        current.isDirectory() &&
        current.uid === process.getuid() &&
        (current.mode & 0o777) === 0o700 &&
        identity.dev === current.dev &&
        identity.ino === current.ino,
      "Build journal directory changed or is unsafe",
    );
    authority.assertCurrent();
  };
  await guard();
  const path = join(root, "build-queue.json");
  const validate = (state) => {
    check(
      state?.version === 1 &&
        state.repository === repository &&
        Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        Array.isArray(state.requests) &&
        Array.isArray(state.releases) &&
        (state.externalReleases === undefined || Array.isArray(state.externalReleases)) &&
        (state.failedReleases === undefined || Array.isArray(state.failedReleases)) &&
        (state.retiredSourceReviews === undefined || Array.isArray(state.retiredSourceReviews)) &&
        (state.active === null || typeof state.active === "object"),
      "Invalid build journal state",
    );
    return state;
  };
  const read = async () => {
    await guard();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const before = await file.stat();
      check(
        before.isFile() &&
          before.uid === process.getuid() &&
          before.nlink === 1 &&
          (before.mode & 0o777) === 0o600 &&
          before.size <= cap,
        "Unsafe build journal file",
      );
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const part = await file.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      const after = await file.stat();
      const named = await lstat(path);
      check(
        count === before.size &&
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          named.dev === after.dev &&
          named.ino === after.ino,
        "Build journal changed during read",
      );
      await guard();
      const content = bytes.subarray(0, count);
      return {
        bytes: content,
        state: validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content))),
      };
    } finally {
      await file.close();
    }
  };
  const persist = async (state, replace) => {
    validate(state);
    const bytes = Buffer.from(JSON.stringify(state) + "\n");
    check(
      bytes.length <= cap,
      "Build journal is full; preserve history before admitting more work",
    );
    await guard();
    const temporary = join(root, `.build-queue-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await guard();
      if (replace) await rename(temporary, path);
      else {
        await link(temporary, path);
        await unlink(temporary);
      }
      const directory = await open(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await guard();
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  let flight = Promise.resolve();
  return {
    // Explicit installation only; exclusive publication refuses an existing file.
    initialize: () =>
      persist(
        { version: 1, repository, revision: 0, active: null, requests: [], releases: [] },
        false,
      ),
    inspect: async () => structuredClone((await read()).state),
    transact(effect) {
      const operation = flight
        .catch(() => {})
        .then(async () => {
          const before = await read();
          const value = await effect(structuredClone(before.state));
          await guard();
          check(
            hash((await read()).bytes) === hash(before.bytes),
            "Build journal changed; reconcile before retry",
          );
          check(
            value?.state?.revision === before.state.revision,
            "Build journal revision was changed by caller",
          );
          if (JSON.stringify(value.state) !== JSON.stringify(before.state)) {
            value.state.revision += 1;
            await persist(value.state, true);
          }
          return structuredClone(value.result);
        });
      flight = operation;
      return operation;
    },
  };
}
