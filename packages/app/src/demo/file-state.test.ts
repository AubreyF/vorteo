import { expect, it } from "vitest";
import { DemoFileState, type DemoFileSnapshot } from "./file-state";
import { DEMO_TIMESTAMP } from "./scenario";

const input = {
  cwd: "/demo/atlas/release",
  path: "README.md",
  content: "Saved sample\n",
  expectedModifiedAt: DEMO_TIMESTAMP,
  expectedRevision: "demo-v1",
};

it("restores saved content and revision in a new session, and Reset clears it", () => {
  let saved: DemoFileSnapshot | null = null;
  const persistence = {
    load: () => saved,
    save: (snapshot: DemoFileSnapshot) => {
      saved = snapshot;
    },
  };
  const original = new DemoFileState(persistence);
  expect(original.write(input).status).toBe("written");
  const restored = new DemoFileState(persistence);
  expect(restored.read(input.cwd, input.path)).toMatchObject({
    content: input.content,
    revision: "demo-v2",
  });
  expect(restored.write(input).status).toBe("conflict");
  expect(
    restored.write({ ...input, expectedRevision: "demo-v2", content: "Second save" }),
  ).toMatchObject({ status: "written", revision: "demo-v3" });
  restored.reset();
  expect(new DemoFileState(persistence).read(input.cwd, input.path)).toMatchObject({
    revision: "demo-v1",
  });
});

it("reports a storage failure without acknowledging or applying the edit", () => {
  let quotaExceeded = true;
  let saved: DemoFileSnapshot | null = null;
  const state = new DemoFileState({
    load: () => saved,
    save: (snapshot) => {
      if (quotaExceeded) throw new Error("Quota exceeded");
      saved = snapshot;
    },
  });
  const original = state.read(input.cwd, input.path);
  expect(state.write(input)).toMatchObject({
    status: "error",
    error: expect.stringContaining("browser storage"),
  });
  expect(state.read(input.cwd, input.path)).toEqual(original);
  expect(state.diff(input.cwd)).toEqual([]);
  quotaExceeded = false;
  expect(state.write(input)).toMatchObject({ status: "written", revision: "demo-v2" });
});

it("rejects corrupt snapshots and paths outside the sample catalog", () => {
  for (const path of ["../../private", "__proto__", "constructor"]) {
    const state = new DemoFileState({
      load: () => ({
        version: 1,
        sequence: 2,
        edits: [{ ...input, path, revision: "demo-v2", modifiedAt: DEMO_TIMESTAMP }],
      }),
      save: () => {},
    });
    expect(state.read(input.cwd, path)).toBeNull();
    expect(state.read(input.cwd, input.path)?.revision).toBe("demo-v1");
    expect(state.write({ ...input, path }).status).toBe("error");
  }
});
