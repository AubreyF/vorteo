import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mode = process.argv[2] ?? "--bump";
if (!["--bump", "--hook", "--check"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
const root = readJson("package.json");
const previous = JSON.parse(git("show", "HEAD:package.json")).version;
const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.([1-9]\d*)(?:\.(?:vorteo|vorton)\.([1-9]\d*))?|-(?:vorteo|vorton)\.([1-9]\d*))?$/;
const before = pattern.exec(previous);
const current = pattern.exec(root.version);
if (!before || !current)
  throw new Error("Expected a stable or beta base, optionally with a Vorteo counter.");
function upstreamBase(parts) {
  return parts.slice(1, 4).join(".") + (parts[4] ? `-beta.${parts[4]}` : "");
}
function compareBase(left, right) {
  const a = [...left.slice(1, 4).map(Number), left[4] ? Number(left[4]) : Infinity];
  const b = [...right.slice(1, 4).map(Number), right[4] ? Number(right[4]) : Infinity];
  const difference = a.findIndex((value, index) => value !== b[index]);
  return difference === -1 ? 0 : Math.sign(a[difference] - b[difference]);
}
const base = upstreamBase(current);
const parentVersions = [before];
// Read both parents so preparation and hook retries preserve the incoming counter.
const mergeHeadPath = git("rev-parse", "--git-path", "MERGE_HEAD");
if (existsSync(mergeHeadPath)) {
  for (const head of readFileSync(mergeHeadPath, "utf8").trim().split(/\s+/)) {
    const version = JSON.parse(git("show", `${head}:package.json`)).version;
    const parsed = pattern.exec(version);
    if (!parsed) throw new Error("Expected a stable or beta base in merge parent.");
    parentVersions.push(parsed);
  }
}
if (parentVersions.some((parent) => compareBase(current, parent) < 0)) {
  throw new Error("The upstream base cannot decrease below a parent.");
}
// Recover the counters consumed before upstream updates stopped resetting them:
// 0.7.2 reached 36, 0.9.0-beta.2 reached 46, and 0.11.0-beta.3 reached 17.
const historicalCounterFloor = 36 + 46 + 17;
const parentCounters = parentVersions.map((parent) => Number(parent[5] ?? parent[6] ?? 0));
const counter = Math.max(historicalCounterFloor, ...parentCounters) + 1;
if (!Number.isSafeInteger(counter)) throw new Error("Vorteo counter exceeds safe integer range.");
const next = `${base}${current[4] ? "." : "-"}vorteo.${counter}`;
const files = [
  "package.json",
  ...root.workspaces.map((workspace) => `${workspace}/package.json`),
  "package-lock.json",
];
// A hook must never stage unrelated working-tree edits in these files.
if (mode === "--hook") {
  git("ls-files", "--error-unmatch", "--", ...files);
  const dirty = git("diff", "--name-only", "--", ...files);
  if (dirty) throw new Error(`Stage or stash manifest changes before committing:\n${dirty}`);
}
const packages = files.slice(0, -1).map((file) => [file, readJson(file)]);
const names = new Set(packages.map(([, pkg]) => pkg.name));
const lock = readJson("package-lock.json");
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
for (const [file, pkg] of packages) {
  pkg.version = next;
  for (const section of sections) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (names.has(name) && name !== pkg.name) pkg[section][name] = pkg.private ? "*" : next;
    }
  }
  const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
  const entry = lock.packages[key];
  if (!entry) throw new Error(`Missing workspace lock entry: ${key}`);
  entry.version = next;
  for (const section of sections) {
    for (const name of Object.keys(entry[section] ?? {})) {
      if (names.has(name) && pkg[section]?.[name]) entry[section][name] = pkg[section][name];
    }
  }
}
lock.version = next;
packages.push(["package-lock.json", lock]);
if (mode === "--check") {
  for (const [file, expected] of packages) {
    const staged = JSON.parse(git("show", `:${file}`));
    if (JSON.stringify(staged) !== JSON.stringify(expected))
      throw new Error(`Stage synchronized version ${next}: ${file}`);
  }
} else {
  for (const [file, pkg] of packages) writeJson(file, pkg);
  if (mode === "--hook") git("add", "--", ...files);
}
console.log(`Vorteo version: ${next}`);
