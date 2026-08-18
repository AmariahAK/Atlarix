/**
 * A sub-agent's `run_command`, routed through the interceptor of the turn that
 * spawned it (v14.34).
 *
 * WHY THIS EXISTS
 * ---------------
 * Sub-agents run with no permission interceptor of their own. That reads as a
 * safety property and is actually why they could not run commands at all: a
 * worker with no way to ask is either mute or unsupervised, and both are worse
 * than the sandbox plus an ask. Claude Code hit the same wall and fixed it the
 * same way — surface the prompt in the MAIN session, labelled with which agent is
 * asking, instead of auto-denying.
 *
 * WHY BORROWING THE PARENT'S INTERCEPTOR IS SOUND
 * ----------------------------------------------
 * A sub-agent executes inside the parent turn's tool call — strictly between
 * `registerInterceptor` and the turn's end — and nothing ever unregisters. So the
 * parent's interceptor is live and correct for the whole run, and borrowing it
 * inherits, correctly and for free: the approval card, the danger gate, the OS
 * sandbox, escalation-on-denial, the terminal tab, output buffering, background
 * promotion and Stop-cancellation. None of that is reimplemented here.
 *
 * The alternative — a second interceptor for the worker — is wrong: it would not
 * be in `activeInterceptors`, so its cards could never be approved, and
 * registering it would clobber the parent's entry for that chat.
 *
 * WHY IT IS STILL READ-ONLY
 * -------------------------
 * Borrowing the parent's interceptor would otherwise inherit the parent's work
 * mode, so a worker spawned from a Build turn would get workspace-write. Every
 * command from here forces `preview.readOnly`, which the sandbox builder treats as
 * a NARROWING it cannot widen. Writes to the workspace are denied by the OS while
 * caches, `/tmp` and the network stay available — the observe-and-iterate profile.
 */

import log from "electron-log";
import { getInterceptorForChat } from "@/ipc/handlers/permissions/handlers";
import { enrichRunCommandPermissionRequest } from "@/ipc/handlers/chat_stream/permission-ui";
import { runCommandCategoryPreflight } from "@/ipc/handlers/command_permission_handlers";
import type { PermissionRequest } from "@/lib/tools/permissions/schema";

const logger = log.scope("subagent-command");

/** Shape the model sees back. Deliberately the same fields a main-agent run returns. */
export interface SubagentCommandOutcome {
  success: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  error?: string;
  denied?: boolean;
}

/**
 * Execute a sub-agent's `run_command` envelope through the parent turn's
 * interceptor. `envelope` is whatever `ToolRegistry.execute("run_command", …)`
 * returned — a `__permission_required` object.
 */
export async function runSubagentCommandViaParent(opts: {
  /** Parent chat id — the key the interceptor is registered under. */
  chatId: number | undefined;
  /** Display name of the asking worker, for the card's attribution chip. */
  agentName: string;
  workspaceId: number | null | undefined;
  workspacePath: string;
  envelope: unknown;
  abortSignal?: AbortSignal;
}): Promise<SubagentCommandOutcome> {
  const { chatId, agentName, workspaceId, workspacePath, envelope, abortSignal } =
    opts;

  if (chatId == null) {
    return {
      success: false,
      error:
        "No parent session for this sub-agent, so a command cannot be approved. Report what you needed to run instead of retrying.",
    };
  }
  const interceptor = getInterceptorForChat(chatId);
  if (!interceptor) {
    // The parent turn ended (cancelled, or this worker outlived it). Fail with a
    // reason the model can act on rather than hanging on an approval nobody will
    // ever see.
    return {
      success: false,
      error:
        "The parent turn is no longer active, so commands cannot be approved. Summarise what you have and finish.",
    };
  }

  const request = interceptor.parsePermissionRequest(envelope);
  if (!request || request.operation !== "run_command") {
    return {
      success: false,
      error: "That command could not be prepared for approval.",
    };
  }

  const preview = request.preview as {
    command?: string;
    readOnly?: boolean;
    requestedByAgent?: string;
    systemScopeInteractive?: boolean;
  };
  const command = preview.command ?? "";

  // Narrow to the observe-only profile, and say who is asking. Both must be set
  // BEFORE buffering: `bufferOperation` emits the request as-is, so anything
  // added afterwards would not reach the card.
  preview.readOnly = true;
  preview.requestedByAgent = agentName;
  // Never set by a worker: it is the flag that lets a HUMAN-approved system-scope
  // command run unsandboxed. A sub-agent must not be able to drop the sandbox.
  delete preview.systemScopeInteractive;

  const enriched = enrichRunCommandPermissionRequest(
    request as { operation: string; preview: unknown },
    workspaceId ?? null,
    workspacePath,
  ) as PermissionRequest;

  const verdict = runCommandCategoryPreflight(
    command,
    workspaceId ?? null,
    workspacePath,
  );

  if (verdict.type === "auto_deny") {
    return {
      success: false,
      denied: true,
      error: `A workspace rule blocks \`${verdict.category}\` commands. Work around it or report it — do not retry.`,
    };
  }

  // auto_allow → run silently, exactly as the main agent's Build path does: the
  // OS sandbox is the boundary, so a non-dangerous command needs no card.
  // Anything else raises the ask in the parent session.
  const autoAllow = verdict.type === "auto_allow";
  const operationId = interceptor.generateOperationId();
  interceptor.bufferOperation(operationId, enriched, autoAllow);

  try {
    if (autoAllow) {
      await interceptor.executeOperation(operationId);
    } else {
      logger.info(
        `[subagent-command] ${agentName} is asking to run: ${command.slice(0, 120)}`,
      );
      // The interceptor's own 'permission-request' listener already sent the card
      // to every window when bufferOperation was called non-silently, so there is
      // nothing to emit here. Approval in the UI runs the operation.
      const outcome = await interceptor.waitForApproval(operationId, {
        abortSignal,
      });
      // "undecided" is treated as a decline here on purpose: a worker must not
      // proceed on the assumption of consent it never received.
      if (outcome !== "approved") {
        // Denying affects THIS call only — the worker keeps running and can try a
        // different approach.
        return {
          success: false,
          denied: true,
          error:
            "The user declined this command. Do not retry it; try another approach or report that you could not verify this.",
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: `Command could not be run: ${String(err).slice(0, 300)}`,
    };
  }

  const result = interceptor.getExecutionResult(operationId);
  return {
    success: result.success,
    command: result.command ?? command,
    output: result.output,
    exitCode: result.exitCode,
    ...(result.error ? { error: result.error } : {}),
  };
}
