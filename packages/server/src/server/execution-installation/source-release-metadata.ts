import { z } from "zod";

export type InertGit = (...args: string[]) => Promise<string>;
const manifestSchema = z
  .object({ name: z.string(), version: z.string(), private: z.boolean().optional() })
  .passthrough();
const lockSchema = z
  .object({
    version: z.string(),
    lockfileVersion: z.literal(3),
    packages: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .passthrough();
const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const versionPattern = /^(\d+\.\d+\.\d+(?:-beta\.\d+)?)[.-](?:vorteo|vorton)\.(\d+)$/;
function versionParts(version: string) {
  const match = versionPattern.exec(version);
  if (!match || !Number.isSafeInteger(Number(match[2])))
    throw new Error("Unsupported release version; resolve metadata explicitly");
  return { base: match[1]!, counter: Number(match[2]) };
}
function releaseVersion(versions: string[], increment: number) {
  const parts = versions.map(versionParts);
  if (parts.some((item) => item.base !== parts[0]!.base))
    throw new Error("Upstream release bases differ; resolve explicitly");
  const counter = Math.max(99, ...parts.map((item) => item.counter)) + increment;
  if (!Number.isSafeInteger(counter)) throw new Error("Release counter exceeds safe integer range");
  const base = parts[0]!.base;
  return `${base}${base.includes("-beta.") ? "." : "-"}vorteo.${counter}`;
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Pinned coordinator implementation of only the repository's generated version fields. */
export async function releaseMetadata(git: InertGit, commit: string) {
  const root = manifestSchema.parse(JSON.parse(await git("show", `${commit}:package.json`)));
  const workspaces = z.array(z.string()).parse(root.workspaces);
  for (const workspace of workspaces) {
    if (
      !/^[a-zA-Z0-9_@./-]+$/.test(workspace) ||
      workspace.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Workspace layout requires explicit integration");
  }
  const manifests = new Map([["package.json", root]]);
  for (const workspace of workspaces)
    manifests.set(
      `${workspace}/package.json`,
      manifestSchema.parse(JSON.parse(await git("show", `${commit}:${workspace}/package.json`))),
    );
  const lock = lockSchema.parse(JSON.parse(await git("show", `${commit}:package-lock.json`)));
  const names = new Set([...manifests.values()].map((item) => item.name));
  if (lock.version !== root.version) throw new Error("Root lock version differs from manifest");
  for (const [file, pkg] of manifests) {
    const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
    const entry = lock.packages[key];
    if (!entry || entry.version !== root.version || pkg.version !== root.version)
      throw new Error(`Inconsistent workspace release metadata: ${file}`);
    for (const section of sections) {
      const dependencies = z.record(z.string(), z.string()).parse(pkg[section] ?? {});
      const locked = z.record(z.string(), z.string()).parse(entry[section] ?? {});
      if (
        JSON.stringify(Object.entries(dependencies).sort()) !==
        JSON.stringify(Object.entries(locked).sort())
      )
        throw new Error(`Manifest and lock dependency declarations differ: ${file} ${section}`);
      for (const [name, pin] of Object.entries(dependencies)) {
        if (names.has(name) && name !== pkg.name && pin !== (pkg.private ? "*" : root.version))
          throw new Error(`Substantive internal dependency pin requires review: ${file} ${name}`);
      }
    }
  }
  const notes = await git("show", `${commit}:VORTEO_CHANGELOG.md`);
  return {
    version: root.version,
    workspaces,
    notes,
    files(version: string, changelog: string) {
      for (const [file, pkg] of manifests) {
        const key = file === "package.json" ? "" : file.slice(0, -"/package.json".length);
        const entry = lock.packages[key]!;
        pkg.version = version;
        entry.version = version;
        for (const section of sections) {
          const dependencies = z.record(z.string(), z.string()).parse(pkg[section] ?? {});
          for (const name of Object.keys(dependencies)) {
            if (names.has(name) && name !== pkg.name)
              dependencies[name] = pkg.private ? "*" : version;
          }
          if (pkg[section]) pkg[section] = dependencies;
          if (entry[section]) entry[section] = dependencies;
        }
      }
      lock.version = version;
      return new Map([
        ...Array.from(manifests, ([file, pkg]) => [file, json(pkg)] as const),
        ["package-lock.json", json(lock)],
        ["VORTEO_CHANGELOG.md", changelog + "\n"],
      ]);
    },
  };
}

function combineNotes(base: string, left: string, right: string) {
  const split = base.indexOf("\n## ");
  if (split < 0) throw new Error("Changelog requires explicit integration");
  const prefix = base.slice(0, split + 1);
  const history = base.slice(split + 1);
  const additions: string[] = [];
  for (const text of [left, right]) {
    if (!text.startsWith(prefix) || !text.endsWith(history))
      throw new Error("Existing release notes were edited; resolve explicitly");
    additions.push(text.slice(prefix.length, text.length - history.length).trim());
  }
  const entries = new Map<string, string[]>();
  for (const addition of additions) {
    for (const block of addition.split(/(?=^## )/m).filter(Boolean)) {
      const [heading, ...body] = block.trim().split("\n");
      if (!/^## \S+ - \d{4}-\d{2}-\d{2}$/.test(heading!))
        throw new Error("Release-note heading requires review");
      const bodies = entries.get(heading!) ?? [];
      const content = body.join("\n").trim();
      if (!bodies.includes(content)) bodies.push(content);
      entries.set(heading!, bodies);
    }
  }
  const added = [...entries]
    .map(([heading, bodies]) => `${heading}\n\n${bodies.join("\n\n")}`)
    .join("\n\n");
  return `${prefix}${added ? added + "\n\n" : ""}${history}`;
}

export async function reconcileReleaseMetadata(
  git: InertGit,
  base: string,
  head: string,
  incoming: string,
) {
  const [before, left, right] = await Promise.all(
    [base, head, incoming].map((commit) => releaseMetadata(git, commit)),
  );
  if (
    [left, right].some(
      (item) => JSON.stringify(item.workspaces) !== JSON.stringify(before!.workspaces),
    )
  )
    throw new Error("Workspace membership changed; resolve explicitly");
  const version = releaseVersion([left!.version, right!.version], 0);
  const notes = combineNotes(before!.notes, left!.notes, right!.notes);
  return {
    base: before!.files(before!.version, before!.notes),
    left: left!.files(before!.version, before!.notes),
    right: right!.files(before!.version, before!.notes),
    version,
    notes,
  };
}

export async function finalizeReleaseMetadata(
  git: InertGit,
  head: string,
  reasons: string[],
  date: string,
  parentVersions: string[],
) {
  const metadata = await releaseMetadata(git, head);
  const version = releaseVersion([metadata.version, ...parentVersions], 1);
  const split = metadata.notes.indexOf("\n## ");
  if (split < 0) throw new Error("Changelog requires explicit integration");
  const summary = reasons.map((reason) => `- ${reason.replace(/\s+/g, " ")}`).join("\n");
  const notes = `${metadata.notes.slice(0, split)}\n\n## ${version} - ${date}\n\n### Maintenance\n\n${summary}\n\n${metadata.notes.slice(split + 1)}`;
  return metadata.files(version, notes);
}
