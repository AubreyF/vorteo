// The PATH the Host daemon and coordinator run with. launchd and systemd start services
// with a bare PATH, so provider CLIs installed the usual way (Claude Code in ~/.local/bin,
// Codex through npm or Homebrew) would be missing. The installer runs in the owner's own
// shell, so its PATH at plan time names where those CLIs live.
import path from "node:path";

const PLATFORM_PATH = {
  darwin: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"],
  linux: ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"],
};

/**
 * @param {{ platform: string, home: string, nodeDirectory: string, envPath?: string }} input
 * @returns {string}
 */
export function servicePath({ platform, home, nodeDirectory, envPath = "" }) {
  const candidates = [
    nodeDirectory,
    path.join(home, ".local", "bin"),
    ...envPath.split(":"),
    ...(PLATFORM_PATH[platform] ?? PLATFORM_PATH.linux),
  ];
  const kept = [];
  for (const entry of candidates) {
    // Only absolute folders; npm adds node_modules/.bin folders that belong to this run.
    if (!path.isAbsolute(entry) || entry.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const folder = path.normalize(entry);
    if (!kept.includes(folder)) kept.push(folder);
  }
  return kept.join(":");
}

/** Sets PATH in a launchd plist or a systemd unit written by the installer. */
export function withServicePath(text, value) {
  const plist = /(<key>PATH<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (plist.test(text)) {
    const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
    return text.replace(plist, (_, open, close) => `${open}${escaped}${close}`);
  }
  const unit = /^Environment="?PATH=[^\n]*$/m;
  if (unit.test(text)) return text.replace(unit, () => `Environment="PATH=${value}"`);
  return text;
}
