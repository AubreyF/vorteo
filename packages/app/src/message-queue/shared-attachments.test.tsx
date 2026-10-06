// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SharedQueueAttachments } from "./shared-attachments";
import { LegacyQueueImport } from "./legacy-import";
import { legacyImportOperationId } from "./legacy";
import { useSessionStore } from "@/stores/session-store";
import type { OutboxRecord } from "./outbox-record";
import type { commitComposerQueue } from "./commit-composer";

const state = vi.hoisted(() => {
  const imports: OutboxRecord[] = [];
  return {
    imports,
    commit: vi.fn(),
    flush: vi.fn(),
    get: vi.fn(),
    read: vi.fn(),
    token: vi.fn(),
    download: vi.fn(),
  };
});
vi.mock("./commit-composer", () => ({ commitComposerQueue: state.commit }));
vi.mock("./runtime", () => ({
  messageOutbox: { list: async () => state.imports },
  flushMessageOutbox: state.flush,
  requireQueueClient: () => ({
    getMessageQueueAttachment: state.get,
    readFile: state.read,
    requestDownloadToken: state.token,
  }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host" }],
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/download-store", () => ({
  useDownloadStore: { getState: () => ({ startDownload: state.download }) },
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: ({ source }: { source: { uri: string } | null }) =>
    source ? <img src={source.uri} alt="Shared preview" /> : null,
}));

let root: Root;
let container: HTMLDivElement;
const attachment = {
  id: "image",
  fileName: "photo.png",
  mimeType: "image/png",
  size: 3,
  kind: "image" as const,
};
const presentation = { attachments: [attachment] };
async function render() {
  await act(async () =>
    root.render(
      <SharedQueueAttachments
        serverId="host"
        agentId="agent"
        messageId="stable-queue-id"
        presentation={presentation}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.imports.length = 0;
  state.flush.mockResolvedValue(undefined);
  state.get.mockResolvedValue({
    file: { attachment, cwd: "/captured", path: "content" },
    error: null,
  });
  state.read.mockResolvedValue({ bytes: new Uint8Array([97, 98, 99]) });
  state.token.mockResolvedValue({
    token: "token",
    fileName: "content",
    mimeType: "application/octet-stream",
    error: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows captured attachments without fetching until opened", async () => {
  await render();
  expect(container.textContent).toContain("photo.png");
  expect(state.get).not.toHaveBeenCalled();
});
it("loads a captured image by stable queue identity only when opened", async () => {
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(state.get).toHaveBeenCalledWith({
    agentId: "agent",
    messageId: "stable-queue-id",
    attachmentId: "image",
  });
  expect(state.read).toHaveBeenCalledWith("/captured", "content", undefined, 4);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,YWJj");
});
it("shows host errors without trying an unchecked file path", async () => {
  state.get.mockResolvedValue({ file: null, error: { message: "Attachment was removed" } });
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Attachment was removed");
  expect(state.read).not.toHaveBeenCalled();
});
it("uses the existing download flow with captured attachment metadata", async () => {
  state.get.mockResolvedValue({
    file: {
      attachment: { ...attachment, kind: "file", fileName: "notes.txt", mimeType: "text/plain" },
      cwd: "/captured",
      path: "content",
      downloadToken: "token",
    },
    error: null,
  });
  await render();
  await act(async () => container.querySelector("button")!.click());
  const request = state.download.mock.calls[0][0];
  expect(request.fileName).toBe("notes.txt");
  expect(await request.requestFileDownloadToken("content")).toMatchObject({
    token: "token",
    fileName: "notes.txt",
    mimeType: "text/plain",
  });
  expect(state.get).toHaveBeenLastCalledWith({
    agentId: "agent",
    messageId: "stable-queue-id",
    attachmentId: "image",
    download: true,
  });
  expect(state.read).not.toHaveBeenCalled();
});

const textContext = {
  attachments: [],
  context: [
    {
      type: "text" as const,
      mimeType: "text/plain" as const,
      title: "Selection",
      text: "Captured selection",
    },
  ],
};
it("shows captured context without requiring a file attachment or host request", async () => {
  await act(async () =>
    root.render(
      <SharedQueueAttachments
        serverId="host"
        agentId="agent"
        messageId="message"
        presentation={textContext}
      />,
    ),
  );
  expect(container.textContent).toContain("View Selection");
  expect(container.textContent).not.toContain("Captured selection");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Captured selection");
  expect(state.get).not.toHaveBeenCalled();
});

it("imports old pending messages once across remounts and preserves them until acknowledgement", async () => {
  const store = useSessionStore.getState();
  store.initializeSession("legacy-host", null, 1);
  store.updateSessionServerInfo("legacy-host", {
    serverId: "legacy-host",
    hostname: null,
    version: "test",
    features: { durableMessageQueue: true },
  });
  const oldMessages = [
    { id: "old-one", text: "Continue old work", attachments: [] },
    { id: "old-two", text: "Then run the checks", attachments: [] },
  ];
  store.setQueuedMessages("legacy-host", new Map([["agent", oldMessages]]));
  state.commit.mockImplementation(async (input: Parameters<typeof commitComposerQueue>[0]) => {
    if (!input.identity) throw new Error("Missing import identity");
    state.imports.push({
      version: 1,
      serverId: input.serverId,
      agentId: input.agentId,
      revision: 0,
      createdAt: 1,
      localAttachments: [],
      prepared: null,
      error: null,
      operation: { kind: "enqueue", ...input.identity, text: input.text, attachments: [] },
    });
  });
  state.flush.mockRejectedValueOnce(new Error("Connection lost before acknowledgement"));
  try {
    await act(async () =>
      root.render(<LegacyQueueImport serverId="legacy-host" agentId="agent" cwd="/repo" />),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Connection lost before acknowledgement");
    expect(state.commit).toHaveBeenCalledTimes(2);
    expect(state.imports.map(({ operation }) => operation)).toEqual(
      oldMessages.map((message) => ({
        kind: "enqueue",
        operationId: legacyImportOperationId(message.id),
        messageId: message.id,
        text: message.text,
        attachments: [],
      })),
    );
    expect(useSessionStore.getState().sessions["legacy-host"]?.queuedMessages.get("agent")).toEqual(
      oldMessages,
    );
    await act(async () => root.render(null));
    await act(async () =>
      root.render(<LegacyQueueImport serverId="legacy-host" agentId="agent" cwd="/repo" />),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(state.commit).toHaveBeenCalledTimes(2);
    expect(state.flush).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().sessions["legacy-host"]?.queuedMessages.get("agent")).toEqual(
      oldMessages,
    );
  } finally {
    await act(async () => root.render(null));
    store.clearSession("legacy-host");
  }
});
