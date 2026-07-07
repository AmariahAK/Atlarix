/**
 * The single tool-execution funnel (permission ruleset + hooks + MCP consent +
 * mutation verification) and the search-routing activity shim — extracted from
 * chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import {
  evaluateRuleset,
  loadEffectiveRuleset,
} from "@/lib/tools/permissions/ruleset";
import { runPreToolUseHooks, runPostToolUseHooks } from "@/lib/hooks/file-hooks";
import { getStoredConsent } from "@/ipc/utils/mcp_consent";
import { requireMcpAuth, type RequireMcpAuthInfo } from "@/ipc/utils/mcp_auth_wait";
import { ToolRegistry } from "@/lib/tools";
import { runCommandFailureGuidance } from "@/lib/tools/run-command-guidance";
import { recordMutationOutcome } from "@/lib/agent/mutation-verify";
import { safeSend } from "@/ipc/utils/safe_sender";

const logger = log.scope("chat_stream_handlers");

export async function runToolExecute(
  toolName: string,
  executeArgs: Record<string, unknown>,
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
  streamOpts?: {
    turnId?: string;
    abortController?: AbortController;
    /** Session UUID for attachment scoping (stable across relaunches). */
    workspaceSessionId?: string;
    /** This turn is an unattended automation run (no human to consent). */
    unattended?: boolean;
  },
): Promise<unknown> {
  // No per-turn call cap or duplicate-call dedup: every tool call executes.

  // v12 2.2: unified permission ruleset + blocking pre_tool_use hooks at the
  // SINGLE execution funnel — covers ask+build, native AND text-tool paths
  // uniformly (the legacy mode/category gates in the wrappers continue to
  // apply on top). No rules/hooks files ⇒ behavior identical to pre-2.2.
  const gateWorkspace =
    typeof executeArgs.workspace === "string" ? executeArgs.workspace : undefined;
  if (gateWorkspace) {
    const decision = evaluateRuleset(
      loadEffectiveRuleset(gateWorkspace),
      toolName,
      executeArgs,
    );
    if (decision?.kind === "deny") {
      logger.warn(
        `[ruleset] ${toolName} blocked by permission rule: ${decision.rule}`,
      );
      return JSON.stringify({
        success: false,
        error: `Blocked by permission rule \`${decision.rule}\` (.atlarix/permissions.json — workspace or global ~/.atlarix). Do not retry this exact call; choose a different approach or ask the user to adjust the rule.`,
      });
    }
    if (decision?.kind === "ask") {
      // v1: mutating tools already prompt via the permission interceptor;
      // log the match so rule authors can see it firing.
      logger.log(`[ruleset] ask-rule matched for ${toolName}: ${decision.rule}`);
    }

    const hookDenial = await runPreToolUseHooks(
      gateWorkspace,
      toolName,
      executeArgs,
    );
    if (hookDenial) {
      return JSON.stringify({
        success: false,
        error: `Blocked by a workspace pre_tool_use hook (\`${hookDenial.deniedBy}\`):\n${hookDenial.outputTail || "(no output)"}`,
      });
    }
  }

  // v14.8.11: attachment tools are scoped to the calling chat/session (the
  // store is process-global; unscoped calls leaked other sessions'
  // attachments). Session UUID is the primary key — transport chat ids are
  // remade every app relaunch.
  if (toolName === "read_attachment" || toolName === "list_attachments") {
    executeArgs._scopeChatId = chatId;
    if (streamOpts?.workspaceSessionId) {
      executeArgs._scopeSessionId = streamOpts.workspaceSessionId;
    }
  }

  // MCP consent/auth. mcp_call produces no permission payload, so this context
  // IS the gate. Attended: auth-and-retry (user present to authenticate).
  // Unattended (automation): no human — a prompt-injected run must not drive
  // mcp_call to servers the user didn't pre-approve, so require a standing
  // "always" consent and never trigger OAuth (mirrors the MCP poller policy).
  if (toolName === "mcp_call") {
    executeArgs._mcpInvocationContext = streamOpts?.unattended
      ? {
          requireConsent: async (info: { serverId: number; toolName: string }) =>
            (await getStoredConsent(info.serverId, info.toolName)) === "always",
          requireAuth: async () => false,
        }
      : {
          requireAuth: (info: RequireMcpAuthInfo) => requireMcpAuth(sender, info),
        };
  }

  const result: unknown = await ToolRegistry.execute(toolName, executeArgs);
  if (gateWorkspace) {
    runPostToolUseHooks(gateWorkspace, toolName, executeArgs);
  }
  // Mutation verification (run_command + edits): record the most recent
  // state-changing mutation's outcome so the completion gate can refuse to
  // finish on a failed/unverified one, and enrich a failed command with
  // recovery guidance (mirrors edit_file's near-miss hint).
  // NOTE: run_command returns its real execution result here, so we verify it
  // inline. Edit/write tools return a *permission payload* (the write happens
  // later in the interceptor after approval), so their verification is done in
  // the interceptor's executeOperation (B1), not here.
  if (
    toolName === "run_command" &&
    streamOpts?.turnId &&
    result &&
    typeof result === "object"
  ) {
    const r = result as Record<string, unknown>;
    const cmd =
      typeof executeArgs?.command === "string" ? executeArgs.command : "";
    const guidance = runCommandFailureGuidance(cmd, r);
    if (guidance) {
      if (typeof r.guidance !== "string") r.guidance = guidance;
      recordMutationOutcome(streamOpts.turnId, false, guidance);
    } else {
      recordMutationOutcome(streamOpts.turnId, true);
    }
  }
  return result;
}

/** Optional callback injected into `search` so the UI shows resolved engine (text / semantic-lite / etc.). */
export function attachSearchRoutingActivity(
  execArgs: Record<string, unknown>,
  sender: IpcMainInvokeEvent["sender"],
  chatId: number,
) {
  execArgs._onSearchRouting = (detail: string) => {
    safeSend(sender, "chat:activity", {
      id: `search-route-${chatId}-${Date.now()}`,
      type: "tool_use",
      label: "Search",
      detail,
      status: "done",
      timestamp: Date.now(),
      chatId,
    });
  };
}
