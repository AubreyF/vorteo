import {
  DemoConversationState,
  demoReply,
  type DemoConversationPersistence,
} from "./conversation-state";
import { DemoChecklistState, type DemoChecklistPersistence } from "./checklist-state";
import {
  SessionOutboundMessageSchema,
  WSInboundMessageSchema,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type WSOutboundMessage,
} from "@getpaseo/protocol/messages";
import { createDemoScenario, DEMO_SERVER_ID, DEMO_TIMESTAMP } from "./scenario";
import { demoFilePath } from "./files";
import { DemoFileState, type DemoFilePersistence } from "./file-state";

type DemoWorkspace = ReturnType<typeof createDemoScenario>["workspaces"][number];
type DemoWorkspaceFilter = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>["filter"];

const PAGE = { nextCursor: null, prevCursor: null, hasMore: false };

/** An in-process protocol peer. Unsupported actions fail here, never reach a host. */
export class DemoSession {
  private scenario = createDemoScenario();
  private subscriptionOrdinal = 0;
  private files: DemoFileState;

  private checklists: DemoChecklistState;
  private conversations: DemoConversationState;
  private timelineSubscriptions = new Map<string, { agentIds: string[]; owner: symbol }>();
  constructor(
    persistence?: DemoFilePersistence,
    checklistPersistence?: DemoChecklistPersistence,
    conversationPersistence?: DemoConversationPersistence,
  ) {
    this.files = new DemoFileState(persistence);
    this.conversations = new DemoConversationState(
      new Set(this.scenario.agents.map((agent) => agent.id)),
      conversationPersistence,
    );
    this.checklists = new DemoChecklistState(createDemoScenario().agents, checklistPersistence);
    for (const agent of this.scenario.agents) agent.tasks = this.checklists.read(agent.id);
  }
  private fileSubscriptions = new Map<string, { cwd: string; path: string; owner: symbol }>();
  private diffSubscriptions = new Map<string, { cwd: string; owner: symbol }>();
  private workspaceSubscriptions = new Map<
    string,
    { filter: DemoWorkspaceFilter; owner: symbol }
  >();
  private agentSubscriptions = new Map<
    string,
    {
      filter: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"];
      owner: symbol;
    }
  >();
  private listeners = new Map<symbol, (message: WSOutboundMessage) => void>();
  private readonly directOwner = Symbol("direct");

  connect(listener: (message: WSOutboundMessage) => void) {
    const owner = Symbol("demo-client");
    this.listeners.set(owner, listener);
    return {
      receive: (data: unknown) => this.receive(data, owner),
      close: () => {
        this.listeners.delete(owner);
        for (const subscriptions of [
          this.fileSubscriptions,
          this.diffSubscriptions,
          this.workspaceSubscriptions,
          this.agentSubscriptions,
          this.timelineSubscriptions,
        ]) {
          for (const [id, subscription] of subscriptions) {
            if (subscription.owner === owner) subscriptions.delete(id);
          }
        }
      },
    };
  }

  reset(): void {
    this.files.reset();
    this.checklists.reset();
    this.conversations.reset();
    this.scenario = createDemoScenario();
    this.fileSubscriptions.clear();
    this.diffSubscriptions.clear();
    this.workspaceSubscriptions.clear();
    this.agentSubscriptions.clear();
    this.timelineSubscriptions.clear();
  }

  receive(data: unknown, owner = this.directOwner): WSOutboundMessage[] {
    const frame = WSInboundMessageSchema.parse(data);
    if (frame.type === "ping") return [{ type: "pong" }];
    if (frame.type === "hello") {
      return [
        this.wrap({
          type: "status",
          payload: {
            status: "server_info",
            serverId: DEMO_SERVER_ID,
            hostname: "Demo",
            version: null,
            features: {
              ownedSubscriptions: true,
              agentTaskSnapshots: true,
              agentChecklistMutations: true,
              checklistBlockedStatus: true,
              checklistReviewStatus: true,
              agentJournal: true,
              workspaceFileEditing: true,
            },
          },
        }),
      ];
    }
    if (frame.type !== "session") return [];
    return this.handle(frame.message, owner).map((message) => this.wrap(message));
  }

  private wrap(message: unknown): WSOutboundMessage {
    return { type: "session", message: SessionOutboundMessageSchema.parse(message) };
  }

  private handle(message: SessionInboundMessage, owner: symbol): SessionOutboundMessage[] {
    const requestId = "requestId" in message ? (message.requestId ?? "") : "";
    const subscriptionId = `demo-subscription-${++this.subscriptionOrdinal}`;
    if (message.type === "send_agent_message_request") return this.sendDemoMessage(message);
    if (message.type === "agent.checklist.mutate.request") return this.mutateTasks(message);
    return (
      this.handleWorkspace(message, requestId, subscriptionId, owner) ??
      this.handleThread(message, requestId, subscriptionId, owner) ??
      this.handleFiles(message, requestId, subscriptionId, owner) ?? [
        {
          type: "rpc_error",
          payload: {
            requestId,
            requestType: message.type,
            code: "DEMO_ACTION_UNAVAILABLE",
            error: "This action is unavailable in the isolated demo. No real host was contacted.",
          },
        },
      ]
    );
  }

  private handleWorkspace(
    message: SessionInboundMessage,
    requestId: string,
    subscriptionId: string,
    owner: symbol,
  ): SessionOutboundMessage[] | null {
    const { projects, workspaces, agents } = this.scenario;
    switch (message.type) {
      case "session.events.set_subscription.request":
        return [
          {
            type: "session.events.set_subscription.response",
            payload: { requestId, subscriptionId },
          },
        ];
      case "subscription.release.request":
        this.releaseSubscription(message.subscriptionId, owner);
        return [
          {
            type: "subscription.release.response",
            payload: { requestId, subscriptionId: message.subscriptionId },
          },
        ];
      case "fetch_workspaces_request":
        if (message.subscribe)
          this.workspaceSubscriptions.set(subscriptionId, { owner, filter: message.filter });
        return [
          {
            type: "fetch_workspaces_response",
            payload: {
              requestId,
              subscriptionId: message.subscribe ? subscriptionId : null,
              entries: workspaces
                .filter((workspace) => matchesDemoWorkspace(workspace, message.filter))
                .map((workspace) => this.workspaceSnapshot(workspace)),
              emptyProjects: [],
              pageInfo: PAGE,
            },
          },
        ];
      case "list_terminals_request":
        return [
          {
            type: "list_terminals_response",
            payload: { requestId, cwd: message.cwd, terminals: [] },
          },
        ];
      case "subscribe_terminals_request":
        return [
          {
            type: "terminals_changed",
            payload: {
              requestId,
              subscriptionId,
              cwd: message.cwd,
              workspaceId: message.workspaceId,
              terminals: [],
            },
          },
        ];
      case "unsubscribe_terminals_request":
        return [];
      case "project.list.request":
        return [{ type: "project.list.response", payload: { requestId, projects } }];
      case "fetch_agents_request":
      case "fetch_agent_history_request": {
        if (message.type === "fetch_agents_request" && message.subscribe)
          this.agentSubscriptions.set(subscriptionId, { filter: message.filter, owner });
        const entries = agents.flatMap((agent) => {
          const workspace = workspaces.find((entry) => entry.id === agent.workspaceId);
          if (!workspace?.project) return [];
          if (!matchesDemoAgent(agent, workspace, message.filter)) return [];
          const search =
            message.type === "fetch_agent_history_request"
              ? message.search?.trim().toLowerCase()
              : undefined;
          if (
            search &&
            ![
              agent.title,
              workspace.title,
              workspace.projectDisplayName,
              workspace.gitRuntime?.currentBranch,
            ]
              .join(" ")
              .toLowerCase()
              .includes(search)
          )
            return [];
          return [{ agent, project: workspace.project }];
        });
        if (message.type === "fetch_agent_history_request") {
          return [
            {
              type: "fetch_agent_history_response",
              payload: { requestId, entries, pageInfo: PAGE },
            },
          ];
        }
        return [
          {
            type: "fetch_agents_response",
            payload: {
              requestId,
              subscriptionId: message.subscribe ? subscriptionId : null,
              entries,
              pageInfo: PAGE,
            },
          },
        ];
      }
      default:
        return null;
    }
  }

  private handleThread(
    message: SessionInboundMessage,
    requestId: string,
    subscriptionId: string,
    owner: symbol,
  ): SessionOutboundMessage[] | null {
    const { workspaces, agents, timelines } = this.scenario;
    switch (message.type) {
      case "fetch_agent_request": {
        const agent = agents.find((entry) => entry.id === message.agentId) ?? null;
        const project =
          workspaces.find((entry) => entry.id === agent?.workspaceId)?.project ?? null;
        return [
          {
            type: "fetch_agent_response",
            payload: { requestId, agent, project, error: agent ? null : "Demo thread not found." },
          },
        ];
      }
      case "agent.timeline.set_subscription.request":
        this.timelineSubscriptions.set(subscriptionId, { agentIds: message.agentIds, owner });
        return [
          {
            type: "agent.timeline.set_subscription.response",
            payload: { requestId, subscriptionId, agentIds: message.agentIds },
          },
        ];
      case "fetch_agent_timeline_request": {
        const agent = agents.find((entry) => entry.id === message.agentId) ?? null;
        const initial = timelines.get(message.agentId) ?? [];
        const allEntries = [
          ...initial,
          ...this.conversations.entries(message.agentId, initial.length + 1),
        ];
        const entries = allEntries.filter((entry) => {
          if (!message.cursor) return true;
          return message.direction === "before"
            ? entry.seqEnd < message.cursor.seq
            : entry.seqStart > message.cursor.seq;
        });
        const epoch = "demo-timeline-v1";
        return [
          {
            type: "fetch_agent_timeline_response",
            payload: {
              requestId,
              agentId: message.agentId,
              agent,
              direction: message.direction ?? "tail",
              projection: message.projection ?? "projected",
              epoch,
              reset: false,
              staleCursor: false,
              gap: false,
              window: { minSeq: 1, maxSeq: allEntries.length, nextSeq: allEntries.length + 1 },
              startCursor: entries.length ? { epoch, seq: entries[0].seqStart } : null,
              endCursor: entries.length ? { epoch, seq: entries[entries.length - 1].seqEnd } : null,
              hasOlder: false,
              hasNewer: false,
              entries,
              error: null,
            },
          },
        ];
      }
      case "agent.checklist.get.request":
        return [
          {
            type: "agent.checklist.get.response",
            payload: {
              requestId,
              agentId: message.agentId,
              tasks: agents.find((entry) => entry.id === message.agentId)?.tasks ?? [],
              error: null,
            },
          },
        ];
      case "workspace.label.list.request":
        return [
          {
            type: "workspace.label.list.response",
            payload: {
              requestId,
              subscriptionId,
              labels: [],
              sync: { mode: "snapshot", generation: "demo-v1", headSeq: 0, removals: [] },
            },
          },
        ];
      case "get_providers_snapshot_request":
        return [
          {
            type: "get_providers_snapshot_response",
            payload: { requestId, entries: [], generatedAt: DEMO_TIMESTAMP },
          },
        ];
      case "list_available_providers_request":
        return [
          {
            type: "list_available_providers_response",
            payload: { requestId, providers: [], fetchedAt: DEMO_TIMESTAMP },
          },
        ];
      default:
        return null;
    }
  }

  private sendDemoMessage(
    message: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
  ): SessionOutboundMessage[] {
    let error: string | null = null;
    try {
      const agent = this.scenario.agents.find((entry) => entry.id === message.agentId);
      if (!agent) throw new Error("Demo thread not found.");
      if (message.images?.length || message.attachments?.length)
        throw new Error("The demo composer supports text only. Remove attachments and retry.");
      const text = message.text.trim();
      if (!text || text.length > 10_000)
        throw new Error("Enter a demo message of 1 to 10,000 characters.");
      const timestamp = new Date().toISOString();
      const added = this.conversations.append({
        agentId: agent.id,
        messageId: message.messageId ?? message.requestId,
        text,
        timestamp,
        reply: demoReply({
          text,
          title: agent.title ?? "this workspace",
          tasks: agent.tasks ?? [],
          files: this.files.diff(agent.cwd).map((file) => file.path),
        }),
      });
      if (added) {
        const initial = this.scenario.timelines.get(agent.id) ?? [];
        const entries = this.conversations.entries(agent.id, initial.length + 1).slice(-2);
        queueMicrotask(() => {
          for (const [id, subscription] of this.timelineSubscriptions) {
            if (!subscription.agentIds.includes(agent.id)) continue;
            for (const entry of entries)
              this.listeners.get(subscription.owner)?.(
                this.wrap({
                  type: "agent_stream",
                  payload: {
                    subscriptionId: id,
                    agentId: agent.id,
                    epoch: "demo-timeline-v1",
                    seq: entry.seqStart,
                    timestamp: entry.timestamp,
                    event: { type: "timeline", provider: "demo", item: entry.item },
                  },
                }),
              );
          }
        });
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Demo message failed.";
    }
    return [
      {
        type: "send_agent_message_response",
        payload: {
          requestId: message.requestId,
          agentId: message.agentId,
          accepted: error === null,
          error,
        },
      },
    ];
  }

  private mutateTasks(
    message: Extract<SessionInboundMessage, { type: "agent.checklist.mutate.request" }>,
  ): SessionOutboundMessage[] {
    const { agents, workspaces } = this.scenario;
    const { requestId } = message;
    const agent = agents.find((entry) => entry.id === message.agentId);
    try {
      if (!agent) throw new Error("Demo thread not found.");
      agent.tasks = this.checklists.mutate(agent.id, message.mutation);
      const project = workspaces.find((entry) => entry.id === agent.workspaceId)?.project ?? null;
      queueMicrotask(() => {
        const workspace = workspaces.find((entry) => entry.id === agent.workspaceId);
        if (!workspace) return;
        for (const [id, subscription] of this.agentSubscriptions) {
          if (!matchesDemoAgent(agent, workspace, subscription.filter)) continue;
          this.listeners.get(subscription.owner)?.(
            this.wrap({
              type: "agent_update",
              payload: { subscriptionId: id, kind: "upsert", agent, project },
            }),
          );
        }
      });
      return [
        {
          type: "agent.checklist.mutate.response",
          payload: { requestId, agentId: message.agentId, tasks: agent.tasks, error: null },
        },
      ];
    } catch (error) {
      return [
        {
          type: "agent.checklist.mutate.response",
          payload: {
            requestId,
            agentId: message.agentId,
            tasks: null,
            error: error instanceof Error ? error.message : "Demo checklist update failed.",
          },
        },
      ];
    }
  }

  private releaseSubscription(id: string, owner: symbol): void {
    for (const subscriptions of [
      this.fileSubscriptions,
      this.diffSubscriptions,
      this.workspaceSubscriptions,
      this.agentSubscriptions,
      this.timelineSubscriptions,
    ]) {
      if (subscriptions.get(id)?.owner === owner) subscriptions.delete(id);
    }
  }

  private workspaceSnapshot(workspace: DemoWorkspace): DemoWorkspace {
    const files = this.files.diff(workspace.workspaceDirectory);
    const diffStat = files.reduce(
      (total, file) => ({
        additions: total.additions + file.additions,
        deletions: total.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 },
    );
    return {
      ...workspace,
      diffStat,
      gitRuntime: workspace.gitRuntime
        ? { ...workspace.gitRuntime, isDirty: files.length > 0 }
        : workspace.gitRuntime,
    };
  }

  private publishFileChange(cwd: string): void {
    for (const [id, subscription] of this.diffSubscriptions) {
      if (subscription.cwd !== cwd) continue;
      this.listeners.get(subscription.owner)?.(
        this.wrap({
          type: "checkout_diff_update",
          payload: { subscriptionId: id, cwd, files: this.files.diff(cwd), error: null },
        }),
      );
    }
    const workspace = this.scenario.workspaces.find((entry) => entry.workspaceDirectory === cwd);
    if (!workspace) return;
    for (const [id, subscription] of this.workspaceSubscriptions) {
      if (!matchesDemoWorkspace(workspace, subscription.filter)) continue;
      this.listeners.get(subscription.owner)?.(
        this.wrap({
          type: "workspace_update",
          payload: {
            subscriptionId: id,
            kind: "upsert",
            workspace: this.workspaceSnapshot(workspace),
          },
        }),
      );
    }
  }

  private handleFiles(
    message: SessionInboundMessage,
    requestId: string,
    subscriptionId: string,
    owner: symbol,
  ): SessionOutboundMessage[] | null {
    switch (message.type) {
      case "file_explorer_request": {
        const path = message.path ?? message.cwd;
        const file = this.files.read(message.cwd, path);
        return [
          SessionOutboundMessageSchema.parse({
            type: "file_explorer_response",
            payload: {
              requestId,
              cwd: message.cwd,
              path,
              mode: message.mode,
              directory:
                message.mode === "list"
                  ? {
                      path,
                      entries: this.files.directory(message.cwd, path),
                    }
                  : null,
              file:
                message.mode === "file" && file !== null
                  ? {
                      path,
                      kind: "text",
                      encoding: "utf-8",
                      content: file.content,
                      size: new TextEncoder().encode(file.content).length,
                      modifiedAt: file.modifiedAt,
                      revision: file.revision,
                    }
                  : null,
              error: message.mode === "file" && file === null ? "Sample file not found." : null,
            },
          }),
        ];
      }
      case "fs.file.subscribe.request": {
        this.fileSubscriptions.set(subscriptionId, { cwd: message.cwd, path: message.path, owner });
        return [
          {
            type: "fs.file.subscribe.response",
            payload: {
              requestId,
              subscriptionId,
              initial: this.files.version(message.cwd, message.path),
            },
          },
        ];
      }
      case "fs.file.write.request": {
        const result = this.files.write(message);
        if (result.status === "written") {
          queueMicrotask(() => {
            this.publishFileChange(message.cwd);
            for (const [id, subscription] of this.fileSubscriptions) {
              if (
                subscription.cwd !== message.cwd ||
                demoFilePath(message.cwd, subscription.path) !==
                  demoFilePath(message.cwd, message.path)
              )
                continue;
              this.listeners.get(subscription.owner)?.(
                this.wrap({
                  type: "fs.file.update",
                  payload: {
                    subscriptionId: id,
                    version: this.files.version(subscription.cwd, subscription.path),
                  },
                }),
              );
            }
          });
        }
        return [{ type: "fs.file.write.response", payload: { requestId, result } }];
      }
      case "fs.file.unsubscribe.request":
        this.releaseSubscription(message.subscriptionId, owner);
        return [
          {
            type: "fs.file.unsubscribe.response",
            payload: { requestId, subscriptionId: message.subscriptionId },
          },
        ];
      default:
        return this.handleCheckout(message, requestId, subscriptionId, owner);
    }
  }

  private handleCheckout(
    message: SessionInboundMessage,
    requestId: string,
    subscriptionId: string,
    owner: symbol,
  ): SessionOutboundMessage[] | null {
    switch (message.type) {
      case "unsubscribe_checkout_diff_request":
        this.releaseSubscription(message.subscriptionId, owner);
        return [];
      case "checkout_status_request":
        return [
          {
            type: "checkout_status_response",
            payload: {
              requestId,
              cwd: message.cwd,
              error: null,
              isGit: true,
              isPaseoOwnedWorktree: false,
              repoRoot: message.cwd,
              mainRepoRoot: null,
              currentBranch:
                this.scenario.workspaces.find(
                  (workspace) => workspace.workspaceDirectory === message.cwd,
                )?.gitRuntime?.currentBranch ?? null,
              isDirty: this.files.diff(message.cwd).length > 0,
              baseRef: "main",
              aheadBehind: { ahead: 2, behind: 0 },
              aheadOfOrigin: 0,
              behindOfOrigin: 0,
              hasRemote: false,
              remoteUrl: null,
            },
          },
        ];
      case "subscribe_checkout_diff_request":
      case "checkout.diff.get.request":
        if (message.type === "subscribe_checkout_diff_request")
          this.diffSubscriptions.set(subscriptionId, { cwd: message.cwd, owner });
        return [
          SessionOutboundMessageSchema.parse({
            type:
              message.type === "subscribe_checkout_diff_request"
                ? "subscribe_checkout_diff_response"
                : "checkout.diff.get.response",
            payload: {
              requestId,
              subscriptionId,
              cwd: message.cwd,
              files: this.files.diff(message.cwd),
              error: null,
            },
          }),
        ];
      default:
        return null;
    }
  }
}

function matchesDemoAgent(
  agent: ReturnType<typeof createDemoScenario>["agents"][number],
  workspace: ReturnType<typeof createDemoScenario>["workspaces"][number],
  filter: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"],
): boolean {
  if (!filter) return true;
  if (filter.projectKeys && !filter.projectKeys.includes(workspace.projectId)) return false;
  if (filter.statuses && !filter.statuses.includes(agent.status)) return false;
  if (
    filter.requiresAttention !== undefined &&
    filter.requiresAttention !== agent.requiresAttention
  )
    return false;
  if (
    filter.thinkingOptionId !== undefined &&
    filter.thinkingOptionId !== (agent.thinkingOptionId ?? null)
  )
    return false;
  return Object.entries(filter.labels ?? {}).every(([key, value]) => agent.labels?.[key] === value);
}

function matchesDemoWorkspace(workspace: DemoWorkspace, filter: DemoWorkspaceFilter): boolean {
  if (filter?.projectId && filter.projectId !== workspace.projectId) return false;
  const query = filter?.query?.trim().toLowerCase();
  return (
    !query ||
    [
      workspace.title,
      workspace.projectDisplayName,
      workspace.workspaceDirectory,
      workspace.gitRuntime?.currentBranch,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
}
