import { z } from "zod";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { EnvironmentSchema, type BridgeConfig, type Environment } from "./config.js";
import { DaemonConnection, type DaemonAccess } from "./daemon.js";
import { BridgeEvents } from "./events.js";
import { WorkspaceObserver } from "./observer.js";
import { BridgeStore } from "./store.js";

const readNames = new Set([
  "get_agent_status",
  "get_agent_activity",
  "list_workspace_scripts",
  "list_terminals",
  "capture_terminal",
  "list_schedules",
  "inspect_schedule",
  "schedule_logs",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "list_pending_permissions",
]);
const writeNames = new Set([
  "create_workspace",
  "rename_workspace",
  "archive_workspace",
  "create_agent",
  "send_agent_prompt",
  "cancel_agent",
  "archive_agent",
  "update_agent",
  "start_workspace_script",
  "stop_workspace_script",
  "create_schedule",
  "pause_schedule",
  "resume_schedule",
  "delete_schedule",
  "update_schedule",
  "run_schedule_once",
]);
const TargetInput = z.object({ environment: EnvironmentSchema, serverId: z.string().min(1) });
const CallInput = TargetInput.extend({
  input: z.record(z.string(), z.unknown()),
  operationId: z.uuid().optional(),
});
const ThreadInput = TargetInput.extend({
  threadId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(30),
  direction: z.enum(["tail", "before", "after"]).default("tail"),
  cursor: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).optional(),
});
const SearchInput = TargetInput.extend({
  threadId: z.string().min(1),
  query: z.string().min(1),
  cursor: z.number().int().nonnegative().optional(),
});
const InventoryInput = TargetInput.extend({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
const WorkspaceInput = TargetInput.extend({ workspaceId: z.string().min(1) });
const ArtifactInput = WorkspaceInput.extend({
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
      "Use a relative workspace path",
    ),
});
const ChangesInput = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
const OperationInput = z.object({ operationId: z.uuid() });

export class BridgeTools {
  private readonly connections: Record<Environment, DaemonAccess>;
  private readonly catalogs: Record<Environment, Map<string, Tool>> = {
    host: new Map(),
    dev: new Map(),
  };
  private readonly availability: Record<Environment, "cached" | "available" | "unavailable"> = {
    host: "cached",
    dev: "cached",
  };
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly jobs = new Set<Promise<void>>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BridgeStore,
    connections?: Record<Environment, DaemonAccess>,
  ) {
    this.connections = connections ?? {
      host: new DaemonConnection(config.host),
      dev: new DaemonConnection(config.dev),
    };
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS tool_catalog (server_id TEXT PRIMARY KEY, tools TEXT NOT NULL)",
    );
    for (const environment of ["host", "dev"] as const) {
      const row = store.db
        .prepare("SELECT tools FROM tool_catalog WHERE server_id=?")
        .get(config[environment].serverId);
      if (row) {
        const cached = z.object({ tools: z.string() }).parse(row);
        this.rememberTools(environment, z.array(ToolSchema).parse(JSON.parse(cached.tools)));
      }
    }
  }

  observe(events: BridgeEvents): WorkspaceObserver[] {
    return (["host", "dev"] as const).map((environment) => {
      const observer = new WorkspaceObserver(
        environment,
        this.config[environment].serverId,
        this.connections[environment],
        this.store,
        events,
      );
      observer.start();
      return observer;
    });
  }

  async discover(): Promise<void> {
    await Promise.allSettled(
      (["host", "dev"] as const).map((environment) => this.refresh(environment)),
    );
  }

  private async refresh(environment: Environment): Promise<void> {
    try {
      const tools = await this.connections[environment].listTools();
      this.rememberTools(environment, tools);
      this.availability[environment] = "available";
      this.store.db
        .prepare(
          "INSERT INTO tool_catalog (server_id, tools) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET tools=excluded.tools",
        )
        .run(this.config[environment].serverId, JSON.stringify(tools));
    } catch (error) {
      this.availability[environment] = "unavailable";
      throw error;
    }
  }

  private rememberTools(environment: Environment, tools: Tool[]): void {
    this.catalogs[environment] = new Map(
      tools
        .filter((tool) => readNames.has(tool.name) || writeNames.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
  }

  list(): Tool[] {
    const names = new Set([...this.catalogs.host.keys(), ...this.catalogs.dev.keys()]);
    const tools: Tool[] = [];
    for (const name of names) {
      const write = writeNames.has(name);
      const variants = [];
      for (const environment of ["host", "dev"] as const) {
        const tool = this.catalogs[environment].get(name);
        if (!tool) continue;
        variants.push({
          type: "object",
          properties: {
            environment: { const: environment },
            serverId: { const: this.config[environment].serverId },
            input: tool.inputSchema,
            ...(write ? { operationId: { type: "string", format: "uuid" } } : {}),
          },
          required: ["environment", "serverId", "input", ...(write ? ["operationId"] : [])],
          additionalProperties: false,
        });
      }
      const definition = this.catalogs.host.get(name) ?? this.catalogs.dev.get(name);
      tools.push({
        name,
        description: `${definition?.description ?? name} Select the exact target from get_overview; schemas and availability differ by environment. ${write ? "Use a stable operationId. A receipt describes dispatch, not worker completion. Inspect unknown outcomes before any new action." : ""}`,
        inputSchema: { type: "object", oneOf: variants },
        annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: write },
      });
    }
    tools.push(
      this.readTool(
        "get_bridge_status",
        "Inspect notification delivery and timeline observation failures without exposing credentials.",
        z.object({}),
      ),
      this.readTool(
        "list_workspaces",
        "Read a page of workspaces in one environment.",
        InventoryInput,
      ),
      this.readTool(
        "list_threads",
        "Read a page of active threads in one environment.",
        InventoryInput,
      ),
      this.readTool(
        "read_artifact",
        "Read up to 64 KiB of a workspace file. Symlinks leaving the workspace are rejected by Vorteo.",
        ArtifactInput,
      ),
      this.readTool(
        "get_workspace_diff",
        "Read uncommitted changes in a workspace.",
        WorkspaceInput,
      ),
      this.readTool(
        "get_changes",
        "Read retained attention events after a local sequence cursor, including events missed during a subscription outage.",
        ChangesInput,
      ),
      this.readTool(
        "get_overview",
        "Read all workspaces and threads across Host and Dev. Reports environment outages explicitly.",
        z.object({}),
      ),
      this.readTool(
        "get_thread",
        "Read timeline evidence for a native Vorteo thread. Use returned cursors with before or after to page through history.",
        ThreadInput,
      ),
      this.readTool(
        "search_thread",
        "Search a Vorteo thread for decisions, results, or other evidence.",
        SearchInput,
      ),
      this.readTool(
        "get_operation",
        "Read a durable write receipt. Unknown means inspect actual state before deciding another action.",
        OperationInput,
      ),
    );
    return tools;
  }

  private readTool(name: string, description: string, schema: z.ZodObject): Tool {
    return ToolSchema.parse({
      name,
      description,
      inputSchema: z.toJSONSchema(schema),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    });
  }

  private connection(environment: Environment, serverId: string): DaemonAccess {
    if (this.config[environment].serverId !== serverId)
      throw new Error("Environment and server ID do not match");
    return this.connections[environment];
  }

  async call(name: string, args: unknown): Promise<unknown> {
    if (name === "get_overview") return this.overview();
    if (name === "get_bridge_status")
      return {
        deliveryCounts: this.store.db
          .prepare("SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status")
          .all(),
        activeSubscriptions: this.store.db
          .prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE expires > ?")
          .get(Date.now()),
        catalogs: this.availability,
        permissionResponses:
          "Use the native owner permission controls; this bridge cannot grant or expand authority.",
        observationErrors: this.store.db
          .prepare("SELECT environment, thread_id, observed_at FROM observation_errors LIMIT 100")
          .all(),
      };
    if (
      [
        "list_workspaces",
        "list_threads",
        "read_artifact",
        "get_workspace_diff",
        "get_changes",
      ].includes(name)
    )
      return this.readWorkspace(name, args);
    if (name === "get_operation")
      return this.store.operation(OperationInput.parse(args).operationId);
    if (name === "get_thread") {
      const input = ThreadInput.parse(args);
      const client = await this.connection(input.environment, input.serverId).readClient();
      const timeline = await client.fetchAgentTimeline(input.threadId, {
        limit: input.limit,
        projection: "projected",
        direction: input.direction,
        cursor: input.cursor,
      });
      return {
        environment: input.environment,
        serverId: input.serverId,
        observedAt: new Date().toISOString(),
        threadId: input.threadId,
        source: this.threadUrl(input.serverId, input.threadId),
        timeline,
      };
    }
    if (name === "search_thread") {
      const input = SearchInput.parse(args);
      const client = await this.connection(input.environment, input.serverId).readClient();
      return this.sourced(
        input.environment,
        input.serverId,
        await client.searchAgentTimeline({
          agentId: input.threadId,
          query: input.query,
          cursor: input.cursor,
        }),
        input.threadId,
      );
    }
    if (!readNames.has(name) && !writeNames.has(name))
      throw new Error("Tool is not available through this integration");
    const input = CallInput.parse(args);
    const connection = this.connection(input.environment, input.serverId);
    if (writeNames.has(name) && !input.operationId)
      throw new Error("Writes require an operationId");
    // Reconcile identical retries even when a target is offline or a tool was removed.
    if (input.operationId && this.store.hasOperation(input.operationId))
      return this.store.claim({ operationId: input.operationId, tool: name, arguments: input })
        .operation;
    await this.refresh(input.environment);
    const upstream = this.catalogs[input.environment].get(name);
    if (!upstream) throw new Error("Tool is unavailable in the selected environment");
    const valid = this.validator.getValidator(upstream.inputSchema)(input.input);
    if (!valid.valid)
      throw new Error("Input does not match the selected environment's tool schema");
    if (readNames.has(name))
      return this.sourced(
        input.environment,
        input.serverId,
        await connection.callTool(name, input.input),
      );
    if (!input.operationId) throw new Error("Writes require an operationId");
    const claim = this.store.claim({
      operationId: input.operationId,
      tool: name,
      arguments: input,
    });
    if (!claim.claimed) return claim.operation;
    const operationId = input.operationId;
    const job = this.performWrite(connection, name, input.input, operationId);
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
    return claim.operation;
  }

  private async readWorkspace(name: string, args: unknown): Promise<unknown> {
    if (name === "get_changes") {
      const input = ChangesInput.parse(args);
      const rows = this.store.db
        .prepare("SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
        .all(input.after, input.limit);
      const changes = rows.map((value) => {
        const row = z.object({ seq: z.number(), body: z.string() }).parse(value);
        return { cursor: row.seq, event: JSON.parse(row.body) };
      });
      const nextAfter = changes.at(-1)?.cursor ?? input.after;
      return {
        observedAt: new Date().toISOString(),
        changes,
        nextAfter,
        hasMore: Boolean(
          this.store.db.prepare("SELECT 1 FROM events WHERE seq > ? LIMIT 1").get(nextAfter),
        ),
        guidance:
          "Persist nextAfter after processing this page. Live subscriptions do not replay old events; use this cursor to catch up after renewal or reconnect.",
      };
    }
    if (name === "list_workspaces" || name === "list_threads") {
      const input = InventoryInput.parse(args);
      const client = await this.connection(input.environment, input.serverId).readClient();
      const page = { limit: input.limit, cursor: input.cursor };
      const result =
        name === "list_workspaces"
          ? await client.fetchWorkspaces({ page })
          : await client.fetchAgents({ filter: { includeArchived: false }, page });
      return this.sourced(input.environment, input.serverId, result);
    }
    const input = WorkspaceInput.parse(args);
    const client = await this.connection(input.environment, input.serverId).readClient();
    let cursor: string | undefined;
    let directory: string | undefined;
    do {
      const page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
      const workspace = page.entries.find((entry) => entry.id === input.workspaceId);
      if (workspace) {
        directory = workspace.workspaceDirectory;
        break;
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    if (!directory) throw new Error("Workspace not found in the selected environment");
    if (name === "get_workspace_diff")
      return this.sourced(
        input.environment,
        input.serverId,
        await client.getCheckoutDiff(directory, { mode: "uncommitted" }),
        undefined,
        input.workspaceId,
      );
    const artifact = ArtifactInput.parse(args);
    const file = await client.readFile(directory, artifact.path, undefined, 65536);
    const text = file.kind === "text";
    return {
      environment: input.environment,
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      path: artifact.path,
      mime: file.mime,
      size: file.size,
      encoding: text ? "utf8" : "base64",
      content: Buffer.from(file.bytes).toString(text ? "utf8" : "base64"),
      modifiedAt: file.modifiedAt,
      observedAt: new Date().toISOString(),
      source: {
        environment: input.environment,
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        path: artifact.path,
      },
    };
  }

  private async performWrite(
    connection: DaemonAccess,
    name: string,
    input: Record<string, unknown>,
    operationId: string,
  ): Promise<void> {
    const args = { ...input };
    if (name === "send_agent_prompt" || name === "create_agent") args.background = true;
    const context =
      "[Vorteo integration request from Nova. This is an agent-mediated instruction, not a retained owner message. Preserve existing authorization and installation approval boundaries.]\n\n";
    if (name === "send_agent_prompt" && typeof args.prompt === "string")
      args.prompt = context + args.prompt;
    if (name === "create_agent" && typeof args.initialPrompt === "string")
      args.initialPrompt = context + args.initialPrompt;
    try {
      const result = await connection.callTool(name, args);
      this.store.finish(operationId, result, result.isError === true);
    } catch {
      // A transport error cannot establish whether the daemon committed a write.
      this.store.uncertain(operationId);
    }
  }

  private threadUrl(serverId: string, threadId: string): string {
    return new URL(
      `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(threadId)}`,
      this.config.origin,
    ).toString();
  }

  private sourced(
    environment: Environment,
    serverId: string,
    data: unknown,
    threadId?: string,
    workspaceId?: string,
  ) {
    return {
      environment,
      serverId,
      observedAt: new Date().toISOString(),
      source: {
        environment,
        serverId,
        threadId,
        workspaceId,
        ...(threadId ? { url: this.threadUrl(serverId, threadId) } : {}),
      },
      data,
    };
  }

  async overview(): Promise<unknown> {
    const entries = await Promise.all(
      (["host", "dev"] as const).map(async (environment) => {
        const serverId = this.config[environment].serverId;
        try {
          const client = await this.connections[environment].readClient();
          const workspaces = [];
          let workspaceCount = 0;
          let workspaceCursor: string | undefined;
          do {
            const page = await client.fetchWorkspaces({
              page: { limit: 200, cursor: workspaceCursor },
            });
            workspaceCount += page.entries.length;
            workspaces.push(...page.entries.slice(0, Math.max(0, 100 - workspaces.length)));
            workspaceCursor = page.pageInfo.hasMore
              ? (page.pageInfo.nextCursor ?? undefined)
              : undefined;
          } while (workspaceCursor);
          let agents: Awaited<ReturnType<typeof client.fetchAgents>>["entries"] = [];
          let threadCount = 0;
          let agentCursor: string | undefined;
          do {
            const page = await client.fetchAgents({
              filter: { includeArchived: false },
              page: { limit: 200, cursor: agentCursor },
            });
            threadCount += page.entries.length;
            agents = [...agents, ...page.entries]
              .sort((a, b) => {
                const priority = (reason: string | null | undefined) =>
                  ({ permission: 3, error: 2, finished: 1 })[reason ?? ""] ?? 0;
                return (
                  priority(b.agent.attentionReason) - priority(a.agent.attentionReason) ||
                  b.agent.updatedAt.localeCompare(a.agent.updatedAt) ||
                  a.agent.id.localeCompare(b.agent.id)
                );
              })
              .slice(0, 100);
            agentCursor = page.pageInfo.hasMore
              ? (page.pageInfo.nextCursor ?? undefined)
              : undefined;
          } while (agentCursor);
          return {
            environment,
            serverId,
            observedAt: new Date().toISOString(),
            status: "connected",
            workspaces: workspaces
              .slice(0, 100)
              .map((workspace) => ({ id: workspace.id, directory: workspace.workspaceDirectory })),
            workspaceCount,
            threadCount,
            truncated: workspaceCount > 100 || threadCount > 100,
            continuation: {
              workspaces: "list_workspaces",
              threads: "list_threads",
              limit: 100,
              cursor: null,
            },
            agents: agents.slice(0, 100).map(({ agent }) => ({
              id: agent.id,
              workspaceId: agent.workspaceId,
              title: agent.title?.slice(0, 200) ?? null,
              status: agent.status,
              attentionReason: agent.attentionReason,
              updatedAt: agent.updatedAt,
              url: new URL(
                `/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agent.id)}`,
                this.config.origin,
              ).toString(),
            })),
          };
        } catch {
          return {
            environment,
            serverId,
            observedAt: new Date().toISOString(),
            status: "unavailable",
            workspaces: null,
            agents: null,
          };
        }
      }),
    );
    return { observedAt: new Date().toISOString(), environments: entries };
  }

  async close(): Promise<void> {
    await Promise.all(this.jobs);
    await Promise.all(Object.values(this.connections).map((connection) => connection.close()));
  }
}
