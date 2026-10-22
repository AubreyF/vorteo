// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMessageQueue } from "./use-message-queue";
import { GoalBar } from "@/goals/goal-bar";
import { useAgentGoal } from "@/goals/use-agent-goal";
import { goalQueueNotice } from "@/goals/goal-presentation";
import { SharedQueueView as QueueView } from "./queue-view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.hoisted(async () => {
  globalThis.React = await import("react");
});
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
  dispatching: false,
  pendingEdit: false,
  media: true,
  goalError: false,
  mutate: vi.fn(),
  expand: vi.fn(),
}));
vi.mock("@/hooks/use-action-error", () => ({ useReportActionError: () => vi.fn() }));
vi.mock("./use-message-queue", () => ({
  useMessageQueue: () => ({
    visible: state.visible,
    supported: true,
    connected: true,
    canSendNow: true,
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
            {
              id: "text",
              text: "Text only",
              attachments: [],
              delivery: { status: state.dispatching ? "dispatching" : "queued" },
            },
            {
              id: "media",
              text: "With attachment",
              attachments: [{ id: "image", kind: state.media ? "image" : "file" }],
              delivery: { status: "queued" },
            },
          ],
    },
    pending: [
      ...(state.pendingEdit
        ? [
            {
              operation: {
                kind: "edit",
                messageId: "text",
                operationId: "edit",
                text: "Text only",
                attachments: [],
              },
              localAttachments: [],
              error: null,
            },
          ]
        : []),
      ...(state.pending
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
        : []),
    ],
  }),
}));
vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));
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
// Animation is covered separately; these checks exercise queue content and actions.
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => <span role="progressbar" />,
}));
vi.mock("./queue-indicator", () => ({
  QueueMessageIndicator: ({
    children,
    record,
  }: {
    children?: React.ReactNode;
    record: unknown;
  }) => <div data-testid={record ? "saving-indicator" : undefined}>{children}</div>,
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipText: () => null,
}));
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
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
// Card resizing pulls in react-native-gesture-handler, which needs the real UIManager.
vi.mock("@/components/card-height-handle", () => ({
  useDraggedCardHeight: () => ({
    active: false,
    height: undefined,
    dragging: false,
    preview: () => {},
    commit: () => {},
    reset: () => {},
  }),
  DraggedCardHeightHandle: () => null,
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
  Info: () => null,
  Files: () => null,
  GitCompareArrows: () => null,
  BookOpen: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  BrushCleaning: () => null,
  ChartPie: () => null,
  FileText: () => null,
  MessageCircleQuestion: () => null,
  MessagesSquare: () => null,
  ShieldCheck: () => null,
  Target: () => null,
  Users: () => null,
  Image: () => <span data-testid="media-icon" />,
  Paperclip: () => <span data-testid="file-icon" />,
  ArrowUp: () => null,
  Pencil: () => null,
  MoreVertical: () => null,
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
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Easing: { bezier: () => undefined },
  FadeIn: {
    duration: () => ({
      easing: () => ({ reduceMotion: () => undefined }),
      reduceMotion: () => undefined,
    }),
  },
  FadeOut: {
    duration: () => ({
      easing: () => ({ reduceMotion: () => undefined }),
      reduceMotion: () => undefined,
    }),
  },
  ReduceMotion: { System: "system" },
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => value,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@/storage/app-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("react-native", () => ({
  Dimensions: { get: () => ({ width: 1400, height: 900 }) },
  StyleSheet: { create: () => ({}) },
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
  useWindowDimensions: () => ({ width: 1400, height: 900 }),
  ScrollView: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
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
  state.dispatching = false;
  state.pendingEdit = false;
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
          queueNotice={goalQueueNotice(goal.state, queue.snapshot)}
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
  expect(queue?.textContent).toContain("Queue");
  expect(queue?.querySelector('[data-testid="message-queue-card-count"]')?.textContent).toBe("2");
  expect(queue?.textContent).not.toContain("goal change");
  expect(container.textContent).not.toContain("Retry delivery");
  expect(goal?.textContent).toContain("Message delivery is blocked");
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

it("keeps row actions in place while dispatching and shows progress around Send", async () => {
  await render();
  const row = () => container.querySelector('[data-testid="queue-message-text"]')!;
  const buttons = row().querySelectorAll("button").length;
  state.dispatching = true;
  await render();
  expect(row().querySelectorAll("button")).toHaveLength(buttons);
  expect(row().querySelector('[data-testid="queue-send-progress"]')).not.toBeNull();
  expect(row().querySelector('[aria-label="Sending queued message"]')).not.toBeNull();
  expect(row().textContent).not.toContain("Sending...");
  expect(
    container.querySelector(
      '[data-testid="queue-message-media"] [data-testid="queue-send-progress"]',
    ),
  ).toBeNull();
});

it("shows a pending edit on its message row without a header status or extra row", async () => {
  state.pendingEdit = true;
  await render();
  expect(container.querySelectorAll('[data-testid^="queue-message-"]')).toHaveLength(2);
  expect(
    container.querySelector('[data-testid="queue-message-text"] [data-testid="saving-indicator"]'),
  ).not.toBeNull();
  expect(container.textContent).not.toContain("Saving message");
});
