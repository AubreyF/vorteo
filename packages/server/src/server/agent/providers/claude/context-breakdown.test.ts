import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { toContextBreakdown } from "./context-breakdown.js";

const OBSERVED_AT = new Date("2026-10-21T12:00:00.000Z");

function usage(
  overrides: Partial<SDKControlGetContextUsageResponse> = {},
): SDKControlGetContextUsageResponse {
  return {
    categories: [
      { name: "System prompt", tokens: 11_400, color: "promptBorder" },
      { name: "Messages", tokens: 27_600, color: "purple" },
      { name: "Autocompact buffer", tokens: 33_000, color: "inactive" },
      { name: "Free space", tokens: 826_500, color: "inactive" },
      { name: "MCP tools (deferred)", tokens: 161_600, color: "inactive", isDeferred: true },
    ],
    totalTokens: 140_500,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 14,
    gridRows: [],
    model: "claude-opus-5-5",
    memoryFiles: [{ path: "/repo/CLAUDE.md", type: "Project", tokens: 1_900 }],
    mcpTools: [
      { name: "mcp__paseo__get_checklist", serverName: "paseo", tokens: 400 },
      { name: "mcp__paseo__unused", serverName: "paseo", tokens: 0 },
    ],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
    ...overrides,
  };
}

describe("toContextBreakdown", () => {
  test("classifies Claude's rows and keeps non-empty item groups", () => {
    expect(toContextBreakdown(usage(), OBSERVED_AT)).toEqual({
      model: "claude-opus-5-5",
      totalTokens: 140_500,
      maxTokens: 1_000_000,
      categories: [
        { name: "System prompt", tokens: 11_400, kind: "used" },
        { name: "Messages", tokens: 27_600, kind: "used" },
        { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { name: "Free space", tokens: 826_500, kind: "free" },
        { name: "MCP tools (deferred)", tokens: 161_600, kind: "deferred" },
      ],
      groups: [
        {
          id: "mcp_tools",
          items: [{ name: "mcp__paseo__get_checklist", detail: "paseo", tokens: 400 }],
        },
        {
          id: "memory_files",
          items: [{ name: "/repo/CLAUDE.md", detail: "Project", tokens: 1_900 }],
        },
      ],
      observedAt: "2026-10-21T12:00:00.000Z",
    });
  });

  test("reports how far a session runs over its window", () => {
    const breakdown = toContextBreakdown(
      usage({ totalTokens: 210_000, maxTokens: 200_000, rawMaxTokens: 200_000 }),
      OBSERVED_AT,
    );
    expect(breakdown?.overLimit).toEqual({ tokensOver: 10_000, kind: "window" });
  });

  test("returns null for a response without a usable window", () => {
    expect(toContextBreakdown(undefined, OBSERVED_AT)).toBeNull();
    expect(toContextBreakdown(usage({ maxTokens: 0, rawMaxTokens: 0 }), OBSERVED_AT)).toBeNull();
  });
});
