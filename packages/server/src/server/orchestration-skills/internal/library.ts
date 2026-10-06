import { downloadSkill } from "../source.js";
export { downloadSkill } from "../source.js";
import { decodeSkillPackage } from "../package.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  SkillPackageSchema,
  type SkillPackage,
  SkillAuditSchema,
  SkillPreviewSchema,
  type SkillAudit,
  type SkillSource,
  type SkillLibraryRead,
  type SkillLibraryChange,
  type SkillLibraryResult,
  type SkillPreview,
  type SkillInventory,
  type SkillInstallation,
} from "@getpaseo/protocol/skill-library";
import {
  inventorySkills,
  missing,
  packageHash,
  readPackage,
  RECEIPT,
  SkillLibraryError,
  type SkillFiles,
} from "./inventory.js";

const PreviewRecord = z.object({
  preview: SkillPreviewSchema,
  canonical: z.string().nullable(),
  canonicalHash: z.string().nullable(),
});
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
async function writeFiles(directory: string, files: SkillFiles): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of files) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), bytes, {
      mode: files.executables?.has(name) ? 0o700 : 0o600,
    });
  }
}
async function durableJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

export class SkillLibrary {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly state: string,
    private readonly home = os.homedir(),
    private readonly download = downloadSkill,
    private readonly authorizeChange?: (preview: SkillPreview) => Promise<void>,
  ) {}

  async read(request: SkillLibraryRead): Promise<SkillLibraryResult> {
    if (request.kind === "audit") return { kind: "audit", entries: await this.audit() };
    const cwd = request.kind === "package" ? undefined : request.cwd;
    const inventory = await this.inventory(cwd);
    if (request.kind === "inventory") return { kind: "inventory", inventory };
    const skill = inventory.skills.find((entry) => entry.id === request.id);
    if (!skill) throw new SkillLibraryError("missing", "Skill is no longer in this inventory");
    if (request.kind === "package") return this.exportPackage(skill);
    const pkg = await readPackage(skill.path);
    const instructions = pkg.files.get("SKILL.md");
    if (!instructions) throw new SkillLibraryError("metadata", "Missing instructions");
    return { kind: "detail", skill, instructions: instructions.toString("utf8") };
  }

  private async exportPackage(skill: SkillInstallation): Promise<SkillLibraryResult> {
    if (skill.owner !== "personal" || skill.issues.length || !skill.sha256)
      throw new SkillLibraryError("ownership", "Only inspected personal packages can be shared");
    const pkg = await readPackage(skill.path);
    if (pkg.hash !== skill.sha256)
      throw new SkillLibraryError("conflict", "Skill changed during export; inspect it again");
    return {
      kind: "package",
      package: {
        name: path.basename(skill.path),
        sha256: pkg.hash,
        source: skill.source,
        files: [...pkg.files].map(([name, bytes]) => ({
          path: name,
          content: bytes.toString("base64"),
          executable: pkg.files.executables?.has(name) === true,
        })),
      },
    };
  }

  private async prepareImport(input: SkillPackage, inventory: SkillInventory) {
    const pkg = SkillPackageSchema.parse(input);
    const files = decodeSkillPackage(pkg);
    const target = path.join(this.home, ".agents/skills", pkg.name);
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (stat) {
      const existing = inventory.skills.find((skill) => skill.path === target);
      const history = await this.audit();
      if (!existing || existing.owner !== "personal" || stat.isSymbolicLink())
        throw new SkillLibraryError(
          "ownership",
          "Preserve the existing package before sharing this definition",
        );
      const recorded = history.some(
        (entry) => entry.target === target && entry.afterHash === existing.sha256,
      );
      const unchangedAdoption = existing.sha256 === pkg.sha256;
      if (!recorded && !unchangedAdoption)
        throw new SkillLibraryError(
          "conflict",
          "Skill changed locally; review its changes before replacing it",
        );
      if (
        existing.source?.repository !== pkg.source?.repository ||
        existing.source?.directory !== pkg.source?.directory
      )
        throw new SkillLibraryError("ownership", "Existing skill has a different source identity");
    }
    return {
      files,
      source: pkg.source,
      target,
      action: "install" as const,
      canonical: null,
      canonicalHash: null,
    };
  }

  change(request: SkillLibraryChange): Promise<SkillLibraryResult> {
    const operation = this.queue.then(() => this.withLock(request));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async withLock(request: SkillLibraryChange): Promise<SkillLibraryResult> {
    await fs.mkdir(this.state, { recursive: true, mode: 0o700 });
    const lock = path.join(this.state, "lock");
    try {
      await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const owner = Number(await fs.readFile(lock, "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0)
        throw new SkillLibraryError("locked", "Skill library lock requires inspection");
      try {
        process.kill(owner, 0);
      } catch (probe) {
        if (!(probe instanceof Error) || !("code" in probe) || probe.code !== "ESRCH") throw probe;
        await fs.unlink(lock);
        return this.withLock(request);
      }
      throw new SkillLibraryError("locked", "Another skill library operation is running");
    }
    try {
      await this.recover();
      return await this.changeSerialized(request);
    } finally {
      await fs.unlink(lock);
    }
  }

  private async recover(): Promise<void> {
    const journal = path.join(this.state, "pending.json");
    const raw = await fs.readFile(journal, "utf8").catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!raw) return;
    const preview = SkillPreviewSchema.parse(JSON.parse(raw));
    const committed = await fs
      .stat(path.join(this.state, "audit", `${preview.id}.json`))
      .catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
    if (committed) {
      await fs.unlink(journal);
      return;
    }
    const backup = path.join(this.state, "backups", preview.id);
    const original = await fs.lstat(backup).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    const current = await this.current(preview.target);
    const currentHash = current?.hash ?? null;
    const expected =
      currentHash === preview.beforeHash ||
      currentHash === preview.afterHash ||
      currentHash === null;
    if (!expected)
      throw new SkillLibraryError(
        "recovery_conflict",
        "Interrupted skill change has new local edits. Preserve and review the pending journal before recovery.",
      );
    if (original) {
      await fs.rm(preview.target, { recursive: true, force: true });
      await fs.rename(backup, preview.target);
    } else if (preview.beforeHash === null && current) {
      await fs.rm(preview.target, { recursive: true, force: true });
    } else if (currentHash !== preview.beforeHash) {
      throw new SkillLibraryError(
        "recovery_conflict",
        "Original skill package is missing; recovery requires inspection",
      );
    }
    await fs.unlink(journal);
  }

  private async inventory(cwd?: string): Promise<SkillInventory> {
    const inventory = await inventorySkills({ home: this.home, cwd });
    const history = await this.audit();
    for (const skill of inventory.skills) {
      if (
        skill.owner === "personal" &&
        history.some(
          (entry) =>
            entry.target === skill.path &&
            ["link", "consolidate", "install", "restore"].includes(entry.action),
        )
      )
        skill.managed = true;
    }
    return inventory;
  }

  private async audit(): Promise<SkillAudit[]> {
    const root = path.join(this.state, "audit");
    const entries = await fs.readdir(root).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    const result: SkillAudit[] = [];
    for (const name of entries.filter((filename) => filename.endsWith(".json")).sort())
      result.push(
        SkillAuditSchema.parse(JSON.parse(await fs.readFile(path.join(root, name), "utf8"))),
      );
    return result;
  }

  private async current(target: string) {
    return readPackage(target).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
  }

  private async prepareInstall(source: SkillSource, inventory: SkillInventory) {
    const files = await this.download(source);
    const name = path.posix.basename(source.directory);
    if (!safeName.test(name)) throw new SkillLibraryError("source", "Invalid skill directory name");
    const target = path.join(this.home, ".agents/skills", name);
    const existing = inventory.skills.find((entry) => entry.path === target);
    if (
      existing &&
      (!existing.managed ||
        existing.source?.repository !== source.repository ||
        existing.source.directory !== source.directory)
    )
      throw new SkillLibraryError(
        "ownership",
        "Existing skill has a different owner; preserve it before installing",
      );
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (stat && !existing)
      throw new SkillLibraryError(
        "ownership",
        "Target contains unrecognized files; preserve it before installing",
      );
    if (stat?.isSymbolicLink())
      throw new SkillLibraryError("ownership", "Update the canonical package instead of its link");
    return {
      files,
      source,
      target,
      action: "install" as const,
      canonical: null,
      canonicalHash: null,
    };
  }

  private async prepareRestore(auditId: string) {
    const entry = (await this.audit()).find((item) => item.id === auditId);
    if (!entry || !entry.beforeHash)
      throw new SkillLibraryError("missing", "No previous package is retained for this change");
    const target = entry.target;
    if (((await this.current(target))?.hash ?? null) !== entry.afterHash)
      throw new SkillLibraryError("conflict", "Installed files changed after this operation");
    const backup = path.join(this.state, "backups", entry.id);
    const link = (await fs.lstat(backup)).isSymbolicLink();
    const canonical = link ? path.resolve(path.dirname(target), await fs.readlink(backup)) : null;
    const original = await readPackage(canonical ?? backup);
    if (original.hash !== entry.beforeHash)
      throw new SkillLibraryError(
        "conflict",
        "Retained package or its canonical source changed; preserve it for review",
      );
    const files = original.files;
    const receipt = await fs
      .readFile(path.join(canonical ?? backup, RECEIPT), "utf8")
      .catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
    const source: SkillSource | null = receipt ? JSON.parse(receipt) : null;
    return {
      files,
      source,
      target,
      action: "restore" as const,
      canonical,
      canonicalHash: canonical ? original.hash : null,
    };
  }

  private async prepareLink(
    request: Extract<SkillLibraryChange, { kind: "preview_link" }>,
    inventory: SkillInventory,
  ) {
    const skill = inventory.skills.find((entry) => entry.id === request.id);
    if (!skill || skill.owner !== "personal" || skill.issues.length || !skill.sha256)
      throw new SkillLibraryError("ownership", "Only inspected personal packages can be linked");
    if ((await fs.lstat(skill.path)).isSymbolicLink())
      throw new SkillLibraryError(
        "ownership",
        "Choose the canonical package to create a discovery link",
      );
    const target = path.join(this.home, `.${request.provider}/skills`, path.basename(skill.path));
    const existing = await fs.lstat(target).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (existing)
      throw new SkillLibraryError(
        "conflict",
        "Provider discovery path already exists. Review its details and consolidate identical packages instead.",
      );
    return {
      files: (await readPackage(skill.path)).files,
      source: skill.source,
      target,
      action: "link" as const,
      canonical: skill.path,
      canonicalHash: skill.sha256,
    };
  }

  private async prepareExisting(
    request: Extract<SkillLibraryChange, { kind: "preview_remove" | "preview_consolidate" }>,
    inventory: SkillInventory,
  ) {
    const entry = inventory.skills.find((item) => item.id === request.id);
    if (!entry || entry.owner !== "personal")
      throw new SkillLibraryError("ownership", "Only personal skills can be changed here");
    const target = entry.path;
    const source = entry.source;
    if (request.kind === "preview_remove") {
      if (!entry.managed)
        throw new SkillLibraryError(
          "ownership",
          "Only library-managed packages can be removed here",
        );
      await this.ensureUnreferenced(target, inventory);
      return {
        files: new Map<string, Buffer>(),
        source,
        target,
        action: "remove" as const,
        canonical: null,
        canonicalHash: null,
      };
    }
    const selected = inventory.skills.find((item) => item.id === request.canonicalId);
    if (
      !selected ||
      selected.path === target ||
      selected.owner !== "personal" ||
      !selected.sha256 ||
      selected.sha256 !== entry.sha256
    )
      throw new SkillLibraryError(
        "conflict",
        "Consolidation requires identical personal skill packages",
      );
    if ((await fs.lstat(selected.path)).isSymbolicLink())
      throw new SkillLibraryError("ownership", "Select a canonical directory, not another link");
    await this.ensureUnreferenced(target, inventory);
    return {
      files: (await readPackage(selected.path)).files,
      source,
      target,
      action: "consolidate" as const,
      canonical: selected.path,
      canonicalHash: selected.sha256,
    };
  }

  private async ensureUnreferenced(target: string, inventory: SkillInventory): Promise<void> {
    if ((await fs.lstat(target)).isSymbolicLink()) return;
    const real = await fs.realpath(target);
    if (inventory.skills.some((skill) => skill.path !== target && skill.resolvedPath === real))
      throw new SkillLibraryError(
        "referenced",
        "Other discovery links reference this package. Remove those links before changing its location.",
      );
  }

  private async changeSerialized(request: SkillLibraryChange): Promise<SkillLibraryResult> {
    if (request.kind === "apply") return this.apply(request.previewId);
    const inventory = await this.inventory();
    let prepared;
    if (request.kind === "preview_import")
      prepared = await this.prepareImport(request.package, inventory);
    else if (request.kind === "preview_install")
      prepared = await this.prepareInstall(request.source, inventory);
    else if (request.kind === "preview_restore")
      prepared = await this.prepareRestore(request.auditId);
    else if (request.kind === "preview_link") prepared = await this.prepareLink(request, inventory);
    else prepared = await this.prepareExisting(request, inventory);
    const { files, source, target, action, canonical, canonicalHash } = prepared;
    const before = await this.current(target);
    const id = randomUUID();
    const changes = [...new Set([...(before?.files.keys() ?? []), ...files.keys()])]
      .sort()
      .map((name) => ({
        path: name,
        before: before?.files.get(name)?.toString("utf8") ?? null,
        after: files.get(name)?.toString("utf8") ?? null,
      }))
      .filter((entry) => entry.before !== entry.after);
    const preview: SkillPreview = {
      id,
      name: path.basename(target),
      action,
      source,
      target,
      beforeHash: before?.hash ?? null,
      afterHash: action === "remove" ? null : packageHash(files),
      changes,
      createdAt: new Date().toISOString(),
    };
    const staging = path.join(this.state, "previews", id);
    await writeFiles(path.join(staging, "package"), files);
    if (source) await fs.writeFile(path.join(staging, "package", RECEIPT), JSON.stringify(source));
    await fs.writeFile(
      path.join(staging, "preview.json"),
      JSON.stringify({ preview, canonical, canonicalHash }),
    );
    return { kind: "preview", preview };
  }

  private async apply(id: string): Promise<SkillLibraryResult> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SkillLibraryError("preview", "Invalid preview ID");
    const committed = (await this.audit()).find((entry) => entry.id === id);
    if (committed) return { kind: "applied", entry: committed };
    const staging = path.join(this.state, "previews", id);
    const { preview, canonical, canonicalHash } = PreviewRecord.parse(
      JSON.parse(await fs.readFile(path.join(staging, "preview.json"), "utf8")),
    );
    await this.authorizeChange?.(preview);
    const current = await this.current(preview.target);
    if ((current?.hash ?? null) !== preview.beforeHash)
      throw new SkillLibraryError(
        "conflict",
        "Skill changed since preview; review a fresh preview",
      );
    if (canonical && (await readPackage(canonical)).hash !== canonicalHash)
      throw new SkillLibraryError("conflict", "Canonical package changed since preview");
    if (
      preview.action !== "remove" &&
      (await readPackage(path.join(staging, "package"))).hash !== preview.afterHash
    )
      throw new SkillLibraryError("conflict", "Staged package changed since preview");
    const backup = path.join(this.state, "backups", id);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.mkdir(path.dirname(preview.target), { recursive: true });
    if (preview.action === "remove" || preview.action === "consolidate")
      await this.ensureUnreferenced(preview.target, await inventorySkills({ home: this.home }));
    const journal = path.join(this.state, "pending.json");
    const entry: SkillAudit = {
      id,
      at: new Date().toISOString(),
      action: preview.action,
      target: preview.target,
      beforeHash: preview.beforeHash,
      afterHash: preview.afterHash,
      source: preview.source,
    };
    await durableJson(journal, preview);
    try {
      if (current) await fs.rename(preview.target, backup);
      if (canonical)
        await fs.symlink(
          path.relative(path.dirname(preview.target), canonical),
          preview.target,
          "dir",
        );
      else if (preview.action !== "remove")
        await fs.rename(path.join(staging, "package"), preview.target);
      const audit = path.join(this.state, "audit", `${id}.json`);
      await fs.mkdir(path.dirname(audit), { recursive: true });
      await durableJson(audit, entry);
    } catch (error) {
      await this.recover();
      throw error;
    }
    // A committed audit is the transaction boundary. Cleanup cannot undo it.
    await fs.unlink(journal);
    await fs.rm(staging, { recursive: true, force: true });
    return { kind: "applied", entry };
  }
}
