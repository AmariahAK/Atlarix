/**
 * Deterministic MCP trigger poller: call one MCP tool with fixed args, hash
 * the result, fire when the hash changes. Server-agnostic (works for Slack
 * search, Jira queries, Sentry issue lists, …) and LLM-free — only a fired
 * trigger enqueues an agent run.
 *
 * Consent: creating an MCP-trigger automation records consent="always" for
 * that server+tool (the form says so explicitly). The poller NEVER prompts and
 * NEVER drives OAuth — a missing consent or expired auth surfaces as a feed
 * error telling the user what to fix.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers, mcpToolConsents } from "@/db/schema";
import { ToolRegistry } from "@/lib/tools/registry";
import type { McpCursor, McpTrigger } from "../types";

export interface McpPollResult {
  fired: boolean;
  context?: string;
  nextCursor: McpCursor;
}

const CONTEXT_MAX = 4000;

/** Deterministic stringify (sorted keys) so hash stability doesn't depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

type McpCallFn = (args: {
  server: string;
  tool: string;
  arguments?: unknown;
  workspaceId?: number;
  _mcpInvocationContext?: unknown;
}) => Promise<Record<string, unknown>>;

async function hasAlwaysConsent(serverId: number, toolName: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(mcpToolConsents)
    .where(
      and(
        eq(mcpToolConsents.serverId, serverId),
        eq(mcpToolConsents.toolName, toolName),
      ),
    )
    .limit(1);
  return row?.consent === "always";
}

export async function pollMcp(
  trigger: McpTrigger,
  cursor: McpCursor | null,
  workspaceId: number,
  opts?: { mcpCall?: McpCallFn },
): Promise<McpPollResult> {
  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, trigger.serverId))
    .limit(1);
  if (!server) {
    throw new Error(`MCP server #${trigger.serverId} no longer exists — edit or delete this automation`);
  }
  if (!server.enabled) {
    throw new Error(`MCP server "${server.name}" is disabled — enable it or edit this automation`);
  }

  const mcpCall =
    opts?.mcpCall ??
    ((ToolRegistry.get("mcp_call")?.handler ?? null) as McpCallFn | null);
  if (!mcpCall) throw new Error("mcp_call tool is not registered");

  const result = await mcpCall({
    server: server.name,
    tool: trigger.tool,
    arguments: trigger.args ?? {},
    workspaceId,
    _mcpInvocationContext: {
      // Unattended: consent must have been pre-granted ("always") at creation.
      requireConsent: async () => hasAlwaysConsent(server.id, trigger.tool),
      // Never drive OAuth unattended — fail the poll with an actionable error.
      requireAuth: async () => false,
    },
  });
  if (result && typeof result === "object" && "error" in result && result.error) {
    throw new Error(String(result.error));
  }

  const raw = typeof result.result === "string" ? result.result : stableStringify(result.result);
  const hash = createHash("sha256").update(raw).digest("hex");
  const seeding = cursor == null;
  if (seeding || hash === cursor.hash) {
    return { fired: false, nextCursor: { hash } };
  }
  return {
    fired: true,
    context:
      `Result of ${server.name}/${trigger.tool} changed since the last poll. Current result:\n` +
      raw.slice(0, CONTEXT_MAX),
    nextCursor: { hash },
  };
}
