import { z } from "zod";
import type { FileVersion, FileWriteResult } from "@getpaseo/protocol/messages";
import { demoDiff, demoFilePath, demoFiles, demoDirectory } from "./files";
import { DEMO_TIMESTAMP } from "./scenario";

const DemoFileSnapshotSchema = z.object({
  version: z.literal(1),
  sequence: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1),
  edits: z
    .array(
      z.object({
        cwd: z.string(),
        path: z.string(),
        content: z.string().max(1_048_576),
        revision: z.string().regex(/^demo-v[1-9][0-9]*$/),
        modifiedAt: z.string().datetime(),
      }),
    )
    .max(100),
});
export type DemoFileSnapshot = z.infer<typeof DemoFileSnapshotSchema>;
export interface DemoFilePersistence {
  load(): unknown;
  save(snapshot: DemoFileSnapshot): void;
}
type EditedFile = DemoFileSnapshot["edits"][number];

/** Demo edits exist only in this session and never identify a host filesystem. */
export class DemoFileState {
  private edits = new Map<string, EditedFile>();
  private sequence = 1;

  constructor(private readonly persistence?: DemoFilePersistence) {
    let saved: unknown;
    try {
      saved = persistence?.load();
    } catch {
      return;
    }
    const parsed = DemoFileSnapshotSchema.safeParse(saved);
    if (!parsed.success) return;
    const restored = new Map<string, EditedFile>();
    for (const edit of parsed.data.edits) {
      const key = this.key(edit.cwd, edit.path);
      const validPath = Object.hasOwn(demoFiles(edit.cwd), edit.path);
      const validRevision = Number(edit.revision.slice(6)) <= parsed.data.sequence;
      if (!validPath || !validRevision || restored.has(key)) return;
      restored.set(key, edit);
    }
    this.edits = restored;
    this.sequence = parsed.data.sequence;
  }

  reset(): void {
    this.persistence?.save({ version: 1, sequence: 1, edits: [] });
    this.edits.clear();
    this.sequence = 1;
  }

  private key(cwd: string, path: string): string {
    return JSON.stringify([cwd, demoFilePath(cwd, path)]);
  }

  read(cwd: string, path: string): EditedFile | null {
    const files = demoFiles(cwd);
    const relativePath = demoFilePath(cwd, path);
    if (!Object.hasOwn(files, relativePath)) return null;
    const content = files[relativePath];
    return (
      this.edits.get(this.key(cwd, path)) ?? {
        cwd,
        path: relativePath,
        content,
        revision: "demo-v1",
        modifiedAt: DEMO_TIMESTAMP,
      }
    );
  }

  directory(cwd: string, path: string) {
    return demoDirectory(cwd, path).map((entry) => {
      const version = this.version(cwd, entry.path);
      if (entry.kind !== "file" || version.status !== "ready") return entry;
      entry.size = version.size;
      entry.modifiedAt = version.modifiedAt;
      return entry;
    });
  }

  version(cwd: string, path: string): FileVersion {
    const file = this.read(cwd, path);
    if (!file) return { status: "missing", cwd, path };
    return {
      status: "ready",
      cwd,
      path,
      size: new TextEncoder().encode(file.content).length,
      revision: file.revision,
      modifiedAt: file.modifiedAt,
    };
  }

  write(input: {
    cwd: string;
    path: string;
    content: string;
    expectedRevision?: string;
    expectedModifiedAt: string;
  }): FileWriteResult {
    const current = this.read(input.cwd, input.path);
    if (!current) return { status: "error", error: "Sample file not found." };
    const matches =
      input.expectedRevision === undefined
        ? input.expectedModifiedAt === current.modifiedAt
        : input.expectedRevision === current.revision;
    if (!matches) return { status: "conflict", version: this.version(input.cwd, input.path) };
    const sequence = this.sequence + 1;
    const next = {
      cwd: input.cwd,
      path: demoFilePath(input.cwd, input.path),
      content: input.content,
      revision: `demo-v${sequence}`,
      modifiedAt: new Date(Date.parse(DEMO_TIMESTAMP) + sequence).toISOString(),
    };
    const edits = new Map(this.edits);
    edits.set(this.key(input.cwd, input.path), next);
    const snapshot = DemoFileSnapshotSchema.safeParse({
      version: 1,
      sequence,
      edits: [...edits.values()],
    });
    if (!snapshot.success)
      return { status: "error", error: "This edit exceeds the demo storage limit." };
    try {
      this.persistence?.save(snapshot.data);
    } catch {
      return {
        status: "error",
        error:
          "The demo could not save this edit in browser storage. Check available space and storage access, then retry.",
      };
    }
    this.sequence = sequence;
    this.edits = edits;
    return {
      status: "written",
      revision: next.revision,
      modifiedAt: next.modifiedAt,
      size: new TextEncoder().encode(next.content).length,
    };
  }

  diff(cwd: string) {
    const originals = demoFiles(cwd);
    const seeded = demoDiff(cwd);
    return Object.entries(originals).flatMap(([path, initial]) => {
      const seed = seeded.find((file) => file.path === path);
      const edit = this.edits.get(this.key(cwd, path));
      if (!edit) return seed ? [seed] : [];
      const before = seed
        ? seed.hunks
            .flatMap((hunk) =>
              hunk.lines.filter((line) => line.type !== "add").map((line) => line.content),
            )
            .join("\n") + "\n"
        : initial;
      if (before === edit.content) return [];
      const lines = (content: string) =>
        content === "" ? [] : content.replace(/\n$/, "").split("\n");
      const oldLines = lines(before);
      const newLines = lines(edit.content);
      return [
        {
          path,
          isNew: false,
          isDeleted: false,
          additions: newLines.length,
          deletions: oldLines.length,
          hunks: [
            {
              oldStart: oldLines.length ? 1 : 0,
              oldCount: oldLines.length,
              newStart: newLines.length ? 1 : 0,
              newCount: newLines.length,
              lines: [
                ...oldLines.map((content) => ({ type: "remove", content })),
                ...newLines.map((content) => ({ type: "add", content })),
              ],
            },
          ],
        },
      ];
    });
  }
}
