import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentContextBreakdown,
  AgentContextGroup,
  AgentContextItem,
} from "@getpaseo/protocol/agent-context";

type ClaudeContextCategory = SDKControlGetContextUsageResponse["categories"][number];

/**
 * The SDK flags deferred rows but not the free-space and compaction-buffer rows, so those are
 * recognized by the names the CLI gives them ("Free space", "Autocompact buffer").
 */
function categoryKind(category: ClaudeContextCategory): string {
  if (category.isDeferred) return "deferred";
  const name = category.name.toLowerCase();
  if (name.includes("free space")) return "free";
  if (name.includes("buffer")) return "buffer";
  return "used";
}

function finiteTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function group(id: string, items: AgentContextItem[]): AgentContextGroup[] {
  const kept = items.filter((item) => item.tokens > 0);
  return kept.length ? [{ id, items: kept }] : [];
}

/** Map Claude's /context data to the provider-neutral breakdown, or null when it is unusable. */
export function toContextBreakdown(
  usage: SDKControlGetContextUsageResponse | null | undefined,
  observedAt: Date,
): AgentContextBreakdown | null {
  if (!usage || !Array.isArray(usage.categories)) return null;
  const totalTokens = finiteTokens(usage.totalTokens);
  const maxTokens = finiteTokens(usage.rawMaxTokens) ?? finiteTokens(usage.maxTokens);
  if (totalTokens === null || !maxTokens) return null;
  const categories = usage.categories.flatMap((category) => {
    const tokens = finiteTokens(category.tokens);
    return tokens === null || typeof category.name !== "string"
      ? []
      : [{ name: category.name, tokens, kind: categoryKind(category) }];
  });
  const groups = [
    ...group(
      "mcp_tools",
      (usage.mcpTools ?? []).map((tool) => ({
        name: tool.name,
        detail: tool.serverName,
        tokens: tool.tokens,
      })),
    ),
    ...group(
      "memory_files",
      (usage.memoryFiles ?? []).map((file) => ({
        name: file.path,
        detail: file.type,
        tokens: file.tokens,
      })),
    ),
    ...group(
      "skills",
      (usage.skills?.skillFrontmatter ?? []).map((skill) => ({
        name: skill.name,
        detail: skill.source,
        tokens: skill.tokens,
      })),
    ),
    ...group(
      "agents",
      (usage.agents ?? []).map((agent) => ({
        name: agent.agentType,
        detail: agent.source,
        tokens: agent.tokens,
      })),
    ),
  ];
  return {
    ...(typeof usage.model === "string" && usage.model ? { model: usage.model } : {}),
    totalTokens,
    maxTokens,
    categories,
    groups,
    ...(totalTokens > maxTokens
      ? { overLimit: { tokensOver: totalTokens - maxTokens, kind: "window" } }
      : {}),
    observedAt: observedAt.toISOString(),
  };
}
