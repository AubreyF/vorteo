import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.url === \`file://${process.argv[1]}\`` is false on Windows, where argv[1] is
// `D:\a\...` and the module URL is `file:///D:/a/...`, so a script guarded that way silently
// does nothing on a Windows runner. Compare resolved filesystem paths instead.
//
// Node resolves symlinks before loading the entry module, so import.meta.url names the real
// file while argv[1] keeps the path as typed, such as one through an installation's `current`
// symlink. Both sides are compared by their real path.
export function isMainModule(importMetaUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  return realPath(fileURLToPath(importMetaUrl)) === realPath(path.resolve(argvPath));
}

function realPath(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}
