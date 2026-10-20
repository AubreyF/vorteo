import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallationSettingsSnapshot } from "@getpaseo/protocol/installation-settings";
import { InstructionRequestError, InstructionRequests, sha256 } from "./instruction-requests.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(initial = "Be candid.") {
  const directory = mkdtempSync(path.join(tmpdir(), "instruction-requests-"));
  directories.push(directory);
  let snapshot = { revision: 7, settings: { appendSystemPrompt: initial } };
  const settings = {
    snapshot: () => snapshot as unknown as InstallationSettingsSnapshot,
    update: vi.fn(
      async (input: { expectedRevision: number; settings: { appendSystemPrompt: string } }) => {
        if (input.expectedRevision !== snapshot.revision) throw new Error("conflict");
        snapshot = { revision: snapshot.revision + 1, settings: { ...input.settings } };
        return snapshot as unknown as InstallationSettingsSnapshot;
      },
    ),
  };
  const setText = (text: string) => {
    snapshot = { revision: snapshot.revision + 1, settings: { appendSystemPrompt: text } };
  };
  return { directory, settings, setText, requests: new InstructionRequests(directory, settings) };
}

const input = (text: string, baseRevision = 7) => ({
  appendSystemPrompt: text,
  baseRevision,
  reason: "Add preview guidance",
  requester: "Gari Parti sync thread",
});

describe("InstructionRequests", () => {
  it("stores a pending request without changing settings", () => {
    const { requests, settings } = fixture();
    const created = requests.submit(input("Be candid.\nUse preview links."), "container");
    expect(created).toMatchObject({
      status: "pending",
      environment: "container",
      baseRevision: 7,
      baseSha256: sha256("Be candid."),
      proposedSha256: sha256("Be candid.\nUse preview links."),
    });
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("refuses a request written against an older revision or matching the current text", () => {
    const { requests } = fixture();
    expect(() => requests.submit(input("New", 6), "host")).toThrow(InstructionRequestError);
    expect(() => requests.submit(input("Be candid."), "host")).toThrow(/match the current/);
  });

  it("applies exactly the reviewed text and marks other pending requests stale", async () => {
    const { requests, settings } = fixture();
    const first = requests.submit(input("First"), "host");
    const second = requests.submit(input("Second"), "container");
    const applied = await requests.decide({
      id: first.id,
      decision: "approve",
      proposedSha256: first.proposedSha256,
    });
    expect(settings.update).toHaveBeenCalledWith({
      expectedRevision: 7,
      settings: { appendSystemPrompt: "First" },
    });
    expect(applied).toMatchObject({ status: "applied", appliedRevision: 8 });
    expect(requests.list().find((item) => item.id === second.id)?.status).toBe("stale");
  });

  it("refuses an approval for text other than the request's", async () => {
    const { requests, settings } = fixture();
    const created = requests.submit(input("First"), "host");
    await expect(
      requests.decide({ id: created.id, decision: "approve", proposedSha256: sha256("Other") }),
    ).rejects.toThrow(/Reviewed text differs/);
    expect(settings.update).not.toHaveBeenCalled();
    expect(requests.list()[0].status).toBe("pending");
  });

  it("never overwrites instructions changed after submission", async () => {
    const { requests, settings, setText } = fixture();
    const created = requests.submit(input("Agent text"), "container");
    setText("Owner edited this meanwhile");
    const result = await requests.decide({
      id: created.id,
      decision: "approve",
      proposedSha256: created.proposedSha256,
    });
    expect(result.status).toBe("stale");
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("rejects without touching settings and refuses a second decision", async () => {
    const { requests, settings } = fixture();
    const created = requests.submit(input("First"), "host");
    const decision = { id: created.id, decision: "reject", proposedSha256: created.proposedSha256 };
    expect((await requests.decide(decision)).status).toBe("rejected");
    await expect(requests.decide({ ...decision, decision: "approve" })).rejects.toThrow(
      /already rejected/,
    );
    expect(settings.update).not.toHaveBeenCalled();
  });

  it("only lets the submitting environment read or cancel its request", () => {
    const { requests } = fixture();
    const created = requests.submit(input("First"), "container");
    expect(requests.get(created.id, "host")).toBeNull();
    expect(() => requests.cancel(created.id, "host")).toThrow(/Unknown/);
    expect(requests.cancel(created.id, "container").status).toBe("cancelled");
  });

  it("persists requests privately across restarts", () => {
    const { requests, directory, settings } = fixture();
    const created = requests.submit(input("First"), "host");
    const file = path.join(directory, "instruction-requests.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).requests).toHaveLength(1);
    const reloaded = new InstructionRequests(directory, settings);
    expect(reloaded.get(created.id, "host")?.appendSystemPrompt).toBe("First");
  });

  it("bounds the number of pending requests", () => {
    const { requests } = fixture();
    for (let index = 0; index < 16; index++) requests.submit(input(`Text ${index}`), "container");
    expect(() => requests.submit(input("One more"), "container")).toThrow(/Too many/);
  });
});
