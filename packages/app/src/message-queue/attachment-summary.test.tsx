// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMessageQueue } from "./use-message-queue";
import { GoalBar } from "@/goals/goal-bar";
import { useAgentGoal } from "@/goals/use-agent-goal";
import { isQueueGoalError } from "./goal-error";
import { SharedQueueView as QueueView } from "./queue-view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function SharedQueueView(props: React.ComponentProps<typeof QueueView>) {
  return (
    <QueryClientProvider client={queryClient}>
      <QueueView {...props} />
    </QueryClientProvider>
  );
}

const state = vi.hoisted(() => ({
  visible: true,
  empty: false,
  paused: false,
  pending: false,
  media: true,
  goalError: false,
  mutate: vi.fn(),
  expand: vi.fn(),
}));
vi.mock("./use-message-queue", () => ({
  useMessageQueue: () => ({
    visible: state.visible,
    supported: true,
    connected: true,
    canMutate: true,
    mutate: state.mutate,
    snapshot: {
      revision: 0,
      paused: state.paused,
      deliveryError: state.goalError
        ? "A goal change could not be confirmed. Review and set the task goal before continuing."
        : undefined,
      items: state.empty
        ? []
        : [
            { id: "text", text: "Text only", attachments: [], delivery: { status: "queued" } },
            {
              id: "media",
              text: "With attachment",
              attachments: [{ id: "image", kind: state.media ? "image" : "file" }],
              delivery: { status: "queued" },
            },
          ],
    },
    pending: state.pending
      ? [
          {
            operation: {
              kind: "enqueue",
              operationId: "local",
              text: "Local image",
              attachments: [],
            },
            localAttachments: [{ kind: "image", metadata: { fileName: "photo.png" } }],
            // Uploaded copies must not count twice while waiting for acknowledgement.
            prepared: { kind: "enqueue", attachments: [{ id: "uploaded", kind: "image" }] },
            error: null,
          },
        ]
      : [],
  }),
}));
vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("@/components/draggable-list", () => ({
  DraggableList: ({
    data,
    renderItem,
  }: {
    data: { id: string }[];
    renderItem: (info: unknown) => React.ReactNode;
  }) => (
    <>
      {data.map((item, index) => (
        <React.Fragment key={item.id}>
          {renderItem({ item, index, drag: () => {}, isActive: false })}
        </React.Fragment>
      ))}
    </>
  ),
}));
// Attachment summaries do not exercise the durable edit transport.
vi.mock("./edit-draft-runtime", () => ({
  queueEditDraftStorage: { list: async () => [] },
  queueEditDraftSession: { open: async () => undefined },
  reviewRejectedQueueEdit: async () => undefined,
}));
vi.mock("./shared-attachments", () => ({ SharedQueueAttachments: () => null }));
vi.mock("@/components/ui/text-input", () => ({ EditingTextInput: () => null }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    accessibilityLabel,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => false }));
vi.mock("@/goals/use-goal-elapsed", () => ({ useGoalElapsed: () => 0 }));
vi.mock("@/goals/use-agent-goal", () => ({
  useAgentGoal: () => ({
    supported: state.visible,
    connected: true,
    canMutate: true,
    mutate: state.mutate,
    state: { status: "ready", goal: { status: "paused", objective: "Keep working" } },
  }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));
vi.mock("lucide-react-native", () => ({
  Image: () => <span data-testid="media-icon" />,
  Paperclip: () => <span data-testid="file-icon" />,
  ArrowUp: () => null,
  Pencil: () => null,
  MoreHorizontal: () => null,
  RotateCw: () => null,
  Play: () => null,
  Pause: () => null,
  Trash2: () => null,
  Maximize2: () => null,
  GripVertical: () => null,
}));
vi.mock("@/styles/theme", () => ({
  baseColors: { zinc: { 800: "black" } },
  ICON_SIZE: { sm: 16, xs: 12 },
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <div data-testid={testID} aria-label={accessibilityLabel}>
      {children}
    </div>
  ),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    accessibilityLabel,
    testID,
  }: {
    children: React.ReactNode;
    accessibilityLabel?: string;
    testID?: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} data-testid={testID}>
      {children}
    </button>
  ),
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.visible = true;
  state.empty = false;
  state.paused = false;
  state.pending = false;
  state.media = true;
  state.goalError = false;
  vi.clearAllMocks();
  queryClient.clear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
function Harness() {
  const queue = useMessageQueue("host", "agent");
  const goal = useAgentGoal("host", "agent");
  return (
    <>
      <SharedQueueView
        serverId="host"
        agentId="agent"
        control={queue}
        goalErrorHandled={goal.supported}
      />
      {state.goalError ? (
        <GoalBar
          control={goal}
          onExpand={state.expand}
          queueError={
            isQueueGoalError(queue.snapshot?.deliveryError)
              ? queue.snapshot?.deliveryError
              : undefined
          }
        />
      ) : null}
    </>
  );
}
async function render() {
  await act(async () => root.render(<Harness />));
}
it("marks an image row while leaving the text-only row unmarked", async () => {
  await render();
  expect(
    container.querySelector(
      '[data-testid="queue-message-text"] [data-testid="queue-attachment-summary"]',
    ),
  ).toBeNull();
  const row = container.querySelector('[data-testid="queue-message-media"]');
  expect(row?.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
  expect(row?.querySelector('[data-testid="media-icon"]')).not.toBeNull();
});
it("uses a file icon for non-image attachments", async () => {
  state.media = false;
  await render();
  expect(container.querySelector('[data-testid="file-icon"]')).not.toBeNull();
});
it("marks a locally saved image before host acknowledgement without counting its upload twice", async () => {
  state.pending = true;
  await render();
  expect(container.querySelectorAll('[aria-label="1 attachment"]')).toHaveLength(2);
  expect(container.textContent).toContain("Local image");
});
it("preserves the Vorton visibility gate", async () => {
  state.visible = false;
  await render();
  expect(container.childElementCount).toBe(0);
});

it("labels the queue and keeps goal recovery within the goal card", async () => {
  state.goalError = true;
  await render();
  const queue = container.querySelector('[data-testid="shared-message-queue"]');
  const goal = container.querySelector('[data-testid="agent-goal-bar"]');
  expect(queue?.textContent).toContain("Message queue");
  expect(queue?.querySelector('[data-testid="message-queue-card-count"]')?.textContent).toBe("2");
  expect(queue?.textContent).not.toContain("goal change");
  expect(container.textContent).not.toContain("Retry delivery");
  expect(goal?.textContent).toContain("Queue delivery is blocked");
  expect(goal?.textContent).toContain("Review and save the goal to continue.");
  expect(goal?.textContent).not.toContain("goal change could not be confirmed");
  const review = Array.from(goal!.querySelectorAll("button")).find(
    (button) => button.textContent === "Review goal",
  );
  await act(async () => review!.click());
  expect(state.expand).toHaveBeenCalledOnce();
  const toggle = goal!.querySelector('[data-testid="agent-goal-pause-resume"]');
  expect(toggle?.nextElementSibling).toBeNull();
});
it("keeps edit and send icons available and toggles the queue with its header control", async () => {
  await render();
  expect(container.querySelectorAll('[aria-label="Edit queued message"]')).toHaveLength(2);
  expect(container.querySelectorAll('[aria-label="Send queued message now"]')).toHaveLength(2);
  state.mutate.mockResolvedValue(undefined);
  await act(async () =>
    (container.querySelector('[aria-label="Pause queue"]') as HTMLButtonElement).click(),
  );
  expect(state.mutate).toHaveBeenCalledWith({ kind: "pause", paused: true, expectedRevision: 0 });
});

it("hides an empty paused queue after Stop while preserving locally pending messages", async () => {
  state.empty = true;
  state.paused = true;
  await act(async () =>
    root.render(
      <SharedQueueView
        serverId="host"
        agentId="agent"
        control={useMessageQueue("host", "agent")}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="shared-message-queue"]')).toBeNull();
  state.pending = true;
  await act(async () =>
    root.render(
      <SharedQueueView
        serverId="host"
        agentId="agent"
        control={useMessageQueue("host", "agent")}
      />,
    ),
  );
  expect(container.textContent).toContain("Local image");
});
