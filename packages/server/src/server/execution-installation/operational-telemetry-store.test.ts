import { mkdtemp, readFile, writeFile, mkdir, readdir, symlink, link, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createOperationalStore,
  OperationalStoreError,
  OPERATIONAL_SLOT_BYTES,
} from "./operational-telemetry-store.js";
import type { OperationalRecordInput } from "./operational-telemetry-record.js";

const START = Date.UTC(2026, 9, 25);

function sample(nowMs: number): OperationalRecordInput {
  return {
    nowMs,
    monotonicMs: nowMs - START,
    previous: null,
    version: "0.11.0-beta.3.vorteo.844",
    observation: null,
    events: [],
    droppedEvents: 0,
    failedWrites: 0,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vorteo-operational-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "operational");
  return { root, directory, store: createOperationalStore(directory) };
}

describe("private operational retention", () => {
  it("preserves duplicate-key content instead of rotating the slot", async () => {
    const { directory, store } = await fixture();
    expect(await store.append(sample(START))).toBe("written");
    const slot = Math.floor(START / 3600000) % 48;
    const path = join(directory, `minute-${String(slot).padStart(2, "0")}.jsonl`);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = '{"format":"preserve original evidence",' + lines[1].slice(1);
    const annotated = lines.join("\n");
    await writeFile(path, annotated);
    await expect(store.append(sample(START + 48 * 3600000))).rejects.toMatchObject({
      code: "invalid_slot",
    });
    expect(await readFile(path, "utf8")).toBe(annotated);
  });

  it("refuses a private extra field in a middle record without rotating any bytes", async () => {
    const { directory, store } = await fixture();
    await store.append(sample(START));
    await store.append(sample(START + 60000));
    const slot = Math.floor(START / 3600000) % 48;
    const path = join(directory, `minute-${String(slot).padStart(2, "0")}.jsonl`);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = JSON.stringify({
      ...JSON.parse(lines[1]),
      privateContent: "preserve original sentinel",
    });
    const annotated = lines.join("\n");
    await writeFile(path, annotated);
    await expect(store.append(sample(START + 48 * 3600000))).rejects.toBeInstanceOf(
      OperationalStoreError,
    );
    expect(await readFile(path, "utf8")).toBe(annotated);
  });

  it("validates all sixty records in a full hour and rotates the bounded slot", async () => {
    const { store } = await fixture();
    for (let minute = 0; minute < 60; minute++)
      expect(await store.append(sample(START + minute * 60000))).toBe("written");
    expect(await store.append(sample(START + 48 * 3600000))).toBe("written");
  });

  it("preserves unrecognized middle content even when header and final record are valid", async () => {
    const { directory, store } = await fixture();
    expect(await store.append(sample(START))).toBe("written");
    const slot = Math.floor(START / 3600000) % 48;
    const path = join(directory, `minute-${String(slot).padStart(2, "0")}.jsonl`);
    const original = await readFile(path, "utf8");
    const firstNewline = original.indexOf("\n") + 1;
    const annotated =
      original.slice(0, firstNewline) + "original middle evidence\n" + original.slice(firstNewline);
    await writeFile(path, annotated);
    await expect(store.append(sample(START + 48 * 3600000))).rejects.toBeInstanceOf(
      OperationalStoreError,
    );
    expect(await readFile(path, "utf8")).toBe(annotated);
  });

  it("keeps at most 48 hourly slots and never touches unrelated files", async () => {
    const { root, directory, store } = await fixture();
    const original = join(root, "original-receipt.json");
    await writeFile(original, "preserve original");
    for (let hour = 0; hour < 50; hour++)
      expect(await store.append(sample(START + hour * 3600000))).toBe("written");
    const files = await readdir(directory);
    expect(files).toHaveLength(48);
    for (const name of files) {
      const text = await readFile(join(directory, name), "utf8");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(OPERATIONAL_SLOT_BYTES);
      expect(text).not.toContain("preserve original");
    }
    expect(await readFile(original, "utf8")).toBe("preserve original");
  });

  it("deduplicates a minute across a new writer and rejects clock rollback", async () => {
    const { directory, store } = await fixture();
    expect(await store.append(sample(START))).toBe("written");
    expect(await createOperationalStore(directory).append(sample(START + 1000))).toBe(
      "already_sampled",
    );
    expect(await store.append(sample(START + 48 * 3600000))).toBe("written");
    await expect(store.append(sample(START))).rejects.toMatchObject({ code: "clock_rollback" });
  });

  it("preserves malformed content instead of rotating an unrecognized file", async () => {
    const { directory, store } = await fixture();
    await mkdir(directory, { mode: 0o700 });
    const slot = Math.floor(START / 3600000) % 48;
    const path = join(directory, `minute-${String(slot).padStart(2, "0")}.jsonl`);
    await writeFile(path, "original evidence", { mode: 0o600 });
    await expect(store.append(sample(START))).rejects.toBeInstanceOf(OperationalStoreError);
    expect(await readFile(path, "utf8")).toBe("original evidence");
  });

  it("refuses a symlink directory and linked slot without changing the target", async () => {
    const { root, directory, store } = await fixture();
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory, "dir");
    await expect(store.append(sample(START))).rejects.toMatchObject({ code: "unsafe_directory" });
    expect(await readdir(target)).toEqual([]);
    const second = await fixture();
    await mkdir(second.directory, { mode: 0o700 });
    const evidence = join(second.root, "keep.txt");
    await writeFile(evidence, "preserve hard-linked original", { mode: 0o600 });
    const slot = Math.floor(START / 3600000) % 48;
    await link(evidence, join(second.directory, `minute-${String(slot).padStart(2, "0")}.jsonl`));
    await expect(second.store.append(sample(START))).rejects.toMatchObject({ code: "unsafe_slot" });
    expect(await readFile(evidence, "utf8")).toBe("preserve hard-linked original");
  });
});
