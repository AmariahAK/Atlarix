/**
 * The single tool-execution funnel (permission ruleset + plugin/user hooks + MCP consent +
 * mutation verification) and the search-routing activity shim — extracted from
 * chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

import log from "electron-log";
import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  evaluateRuleset,
  loadEffectiveRuleset,
} from "@/lib/tools/permissions/ruleset";
import {
  getStoredConsent,
  requestMcpToolConsent,
} from "@/ipc/utils/mcp_consent";
import {
  requireMcpAuth,
  type RequireMcpAuthInfo,
} from "@/ipc/utils/mcp_auth_wait";
import { ToolRegistry } from "@/lib/tools";
import { runCommandFailureGuidance } from "@/lib/tools/run-command-guidance";
import { recordMutationOutcome } from "@/lib/agent/mutation-verify";
import { safeSend } from "@/ipc/utils/safe_sender";
import { runPostToolUseHooks, runPreToolUseHooks } from "@/lib/plugins/hooks";

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

  // Which WINDOW asked. `sender` is the requesting window's webContents, so this
  // is the one place that can answer it for every tool — the native and
  // text-tool paths both funnel through here. Window-scoped tools (the browser)
  // resolve their state from it; everything else ignores it.
  //
  // Injected here rather than at the branch call sites that add `_chatSessionId`,
  // so it cannot be forgotten on one path.
  try {
    const ownerWindow = BrowserWindow.fromWebContents(sender);
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      executeArgs._ownerWindowId = ownerWindow.id;
    }
  } catch {
    // Synthetic/destroyed sender (background agents) — the tools fall back to
    // the focused window, which is the pre-existing behaviour.
  }

  // v12 2.2: unified permission ruleset + blocking pre_tool_use hooks at the
  // SINGLE execution funnel — covers ask+build, native AND text-tool paths
  // uniformly (the legacy mode/category gates in the wrappers continue to
  // apply on top). No rules/hooks files ⇒ behavior identical to pre-2.2.
  const gateWorkspace =
    typeof executeArgs.workspace === "string"
      ? executeArgs.workspace
      : undefined;
  if (gateWorkspace) {
    // v14.41: EVALUATE BOTH THE AS-CALLED NAME AND THE CANONICAL ONE.
    //
    // `ToolRegistry.execute` resolves a retired name to its current tool, but it
    // does so BELOW this gate — so the gate only ever saw the name the model
    // typed. With browser 6→2 that became a bypass with five doors: a user rule
    // denying `browser` did nothing against `browser({action:"navigate"})` called
    // by its retired name `browser_navigate`, because the strings differ.
    //
    // Checking both directions also keeps rules written against the OLD names
    // working (`browser_*` still matches `browser_navigate` as called), which a
    // plain canonicalise-then-check would have silently broken.
    //
    // The `??` cannot fail open, and the reason is the TYPE, not the order:
    // `RulesetDecision` is `{kind:"deny"} | null` — there is no allow decision, so
    // a rule cannot produce a non-null value that short-circuits the canonical
    // check. (Precisely, "first non-null decision wins"; with a deny-only type
    // that is the same as "first deny wins". If an allow/ask decision is ever
    // added to the ruleset, THIS composition has to be revisited before it is.)
    // The first operand is byte-identical to the old single call, so the deny set
    // is a strict superset: adding a name can only tighten the gate.
    const ruleset = loadEffectiveRuleset(gateWorkspace);
    const canonicalName = ToolRegistry.resolveName(toolName);
    const decision =
      evaluateRuleset(ruleset, toolName, executeArgs) ??
      (canonicalName !== toolName
        ? evaluateRuleset(ruleset, canonicalName, executeArgs)
        : null);
    if (decision?.kind === "deny") {
      logger.warn(
        `[ruleset] ${toolName} blocked by permission rule: ${decision.rule}`,
      );
      return JSON.stringify({
        success: false,
        error: `Blocked by permission rule \`${decision.rule}\` (.atlarix/permissions.json — workspace or global ~/.atlarix). Do not retry this exact call; choose a different approach or ask the user to adjust the rule.`,
      });
    }
  }

  // Hooks: the person's hooks.json and installed plugins, never a workspace's
  // (lib/plugins/hooks.ts). A pre_tool_use hook can only deny.
  const hookCtx = {
    workspacePath: gateWorkspace ?? null,
    sessionId: streamOpts?.workspaceSessionId,
  };
  const hookDenial = await runPreToolUseHooks(hookCtx, toolName, executeArgs);
  if (hookDenial) {
    logger.warn(`[hooks] ${toolName} denied by ${hookDenial.deniedBy}`);
    return JSON.stringify({
      success: false,
      error: `Blocked by a pre_tool_use hook (${hookDenial.deniedBy}):\n${hookDenial.reason}`,
    });
  }
  // Mods with the `tool` capability can deny too (lib/plugins/mod-host.ts).
  // Loaded lazily: QuickJS is only started when a verified plugin has a mod.
  const { modsToolCall } = await import("@/lib/plugins/mod-host");
  const modDenial = await modsToolCall(hookCtx, toolName, executeArgs);
  if (modDenial) {
    logger.warn(`[mods] ${toolName} denied by ${modDenial.plugin}`);
    return JSON.stringify({
      success: false,
      error: `Blocked by the ${modDenial.plugin} mod:\n${modDenial.reason}`,
    });
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

  // Read-before-edit scope (`lib/tools/file-read-log.ts`): `read_file` records what it
  // served and `edit_file` refuses to work from a stale view. Both need the SAME scope key
  // or the record is written under one identity and looked up under another — which is
  // exactly how the previous attempt at this failed silently: it read a chat id that was
  // only ever injected for the two attachment tools above, so it was permanently
  // undefined here and the check never fired.
  if (toolName === "read_file" || toolName === "edit_file") {
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
  // mcp_servers suggest: a card for the user (none in an unattended run), and
  // a Stop answers a suggestion the model is waiting on.
  if (toolName === "mcp_servers") {
    executeArgs._mcpSuggestContext = {
      unattended: !!streamOpts?.unattended,
      signal: streamOpts?.abortController?.signal,
    };
  }
  if (toolName === "mcp_call") {
    executeArgs._mcpInvocationContext = streamOpts?.unattended
      ? {
          requireConsent: async (info: {
            serverId: number;
            toolName: string;
          }) =>
            (await getStoredConsent(info.serverId, info.toolName)) === "always",
          requireAuth: async () => false,
        }
      : {
          // C7: attended runs gate every MCP tool call on stored/interactive
          // consent (was previously unwired — tools ran with no confirmation).
          requireConsent: (info: {
            serverId: number;
            serverName: string;
            toolName: string;
            toolDescription?: string;
            inputPreview?: string;
          }) =>
            requestMcpToolConsent(
              sender,
              info,
              streamOpts?.abortController?.signal,
            ),
          requireAuth: (info: RequireMcpAuthInfo) =>
            requireMcpAuth(sender, info, streamOpts?.abortController?.signal),
        };
  }

  const result: unknown = await ToolRegistry.execute(toolName, executeArgs);
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
  // An edit returns its permission payload here; its post_tool_use hooks fire
  // in the interceptor once the approved write has landed.
  if (!PAYLOAD_TOOLS.has(toolName)) {
    runPostToolUseHooks(hookCtx, toolName, executeArgs, result);
  }
  return result;
}

const PAYLOAD_TOOLS = new Set(["edit_file", "delete_file", "rename_file"]);

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
