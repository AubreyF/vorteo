import { downloadSkill } from "../../orchestration-skills/source.js";
import { packageHash } from "../../orchestration-skills/internal/inventory.js";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  SkillSourceSchema,
  type SkillSource,
  InstallationSkillSchema,
  SkillPackageSchema,
  type InstallationSkill,
  type SkillPackage,
} from "@getpaseo/protocol/skill-library";
import { decodeSkillPackage } from "../../orchestration-skills/package.js";
import { ensurePrivateDirectory } from "../../private-files.js";

/** Protected installation storage. Guest observations never supply filesystem paths. */
export class InstallationSkillPackages {
  constructor(private readonly directory: string) {
    ensurePrivateDirectory(directory);
    for (const target of [directory, path.dirname(directory)]) {
      const descriptor = openSync(target, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
  }

  async prepare(source: SkillSource, download = downloadSkill) {
    const validated = SkillSourceSchema.parse(source);
    const files = await download(validated);
    const pkg = SkillPackageSchema.parse({
      name: path.posix.basename(validated.directory),
      source: validated,
      sha256: packageHash(files),
      files: [...files]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, content]) => ({
          path: file,
          content: content.toString("base64"),
          executable: files.executables?.has(file) ?? false,
        })),
    });
    const definition = this.save(pkg);
    return { definition, package: pkg };
  }

  save(input: SkillPackage): InstallationSkill {
    const pkg = SkillPackageSchema.parse(input);
    decodeSkillPackage(pkg);
    const identity = pkg.source
      ? `github:${pkg.source.repository}/${pkg.source.directory}`
      : `content:${pkg.sha256}`;
    const definition = { name: pkg.name, source: pkg.source, sha256: pkg.sha256, identity };
    const file = path.join(this.directory, `${pkg.sha256}.json`);
    if (existsSync(file)) {
      this.read(definition);
      return definition;
    }
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        const files = pkg.files.toSorted((left, right) => left.path.localeCompare(right.path));
        writeFileSync(descriptor, JSON.stringify({ files }));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      try {
        linkSync(temporary, file);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        this.read(definition);
      }
      const parent = openSync(this.directory, "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    return definition;
  }

  read(input: InstallationSkill): SkillPackage {
    const definition = InstallationSkillSchema.parse(input);
    const identity = definition.source
      ? `github:${definition.source.repository}/${definition.source.directory}`
      : `content:${definition.sha256}`;
    if (identity !== definition.identity)
      throw new Error("Skill definition has a conflicting identity");
    const file = path.join(this.directory, `${definition.sha256}.json`);
    if (statSync(file).size > 6 * 1024 * 1024)
      throw new Error("Stored skill package exceeds the transfer limit");
    const content: unknown = JSON.parse(readFileSync(file, "utf8"));
    const files = SkillPackageSchema.pick({ files: true }).strict().parse(content).files;
    const pkg = SkillPackageSchema.parse({
      name: definition.name,
      source: definition.source,
      sha256: definition.sha256,
      files,
    });
    decodeSkillPackage(pkg);
    return pkg;
  }
}
