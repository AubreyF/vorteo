import { expect, test } from "vitest";
import { transferTaskAttachments } from "./attachments";

test("uploads the original bytes into the chosen environment without mutating the draft", async () => {
  const original = {
    type: "uploaded_file" as const,
    id: "source-file",
    fileName: "notes.txt",
    path: "/host/uploads/notes.txt",
    mimeType: "text/plain",
    size: 3,
  };
  const requests: unknown[] = [];
  const copied = { ...original, id: "destination-file", path: "/container/uploads/notes.txt" };
  const result = await transferTaskAttachments({
    attachments: [original],
    source: {
      async readFile(cwd, path) {
        requests.push({ cwd, path });
        return {
          bytes: new Uint8Array([1, 2, 3]),
          mime: "text/plain",
          size: 3,
          path,
          kind: "text",
          modifiedAt: "2026-10-07T00:00:00Z",
        };
      },
    },
    destination: {
      async uploadFile(input) {
        requests.push(input);
        return { requestId: "upload", file: copied, error: null };
      },
    },
  });
  expect(result).toEqual([copied]);
  expect(original.path).toBe("/host/uploads/notes.txt");
  expect(requests).toEqual([
    { cwd: "/host/uploads", path: "notes.txt" },
    { fileName: "notes.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2, 3]) },
  ]);
});

test("names the attachment on transfer failure and leaves the draft available for retry", async () => {
  const original = {
    type: "uploaded_file" as const,
    id: "source-file",
    fileName: "notes.txt",
    path: "/host/uploads/notes.txt",
    mimeType: "text/plain",
    size: 3,
  };
  await expect(
    transferTaskAttachments({
      attachments: [original],
      source: {
        async readFile() {
          throw new Error("Disconnected");
        },
      },
      destination: {
        async uploadFile() {
          throw new Error("Must not upload");
        },
      },
    }),
  ).rejects.toThrow("Could not transfer notes.txt. Retry or remove this attachment. Disconnected");
  expect(original.path).toBe("/host/uploads/notes.txt");
});
