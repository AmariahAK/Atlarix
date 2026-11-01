/**
 * Executes one automation run as a real, unattended agent turn — the headless
 * runner's spine (fake sender + auto-approve + chat:response:end) hosted
 * inside the Electron main process. Transcripts persist as chat_sessions rows
 * with kind="background"; results land on automation_runs for the triage feed.
 */

import { parseAssistantMessageParts } from "@/lib/chat/assistant-message-parts";
import { randomUUID } from "node:crypto";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps, automationRuns, automations, chatSessions } from "@/db/schema";
import {
  bindTransportToSession,
  createStreamTransport,
  deleteStreamTransport,
  getStreamTransport,
} from "@/lib/chat/stream-transport";
import { makeFakeSender } from "@/headless/fake-sender";
import { wrapUntrustedData } from "@/lib/streaming/untrusted-data";
import { automationAutoApprove } from "./auto-approve";
import { PROCESS_OWNER } from "./process-owner";
import type { AutomationRunStatus } from "./types";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import { serializeSessionOrigin } from "@/shared/session-lineage";
import { currentSurface } from "@/lib/stats/usage-stats";

const logger = log.scope("automations");

/** Unattended turns get a hard wall-clock budget. */
export const RUN_TIMEOUT_MS = 10 * 60 * 1000;

const NOTHING_SENTINEL = "NOTHING_TO_REPORT";
const RESULT_SENTINEL = "AUTOMATION_RESULT:";
const SUMMARY_MAX = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerEvent = any;

export interface ExecuteRunDeps {
  chatStream: (event: HandlerEvent, req: ChatStreamParams) => Promise<unknown>;
  executePermission: (
    event: HandlerEvent,
    args: {
      chatId: number;
      operationId: string;
      approvalMode?: "once" | "deny";
    },
  ) => Promise<unknown>;
  cancelStream: (chatId: number) => void;
  timeoutMs?: number;
}

async function resolveProdDeps(): Promise<ExecuteRunDeps> {
  const streamHandlers = await import("@/ipc/handlers/chat_stream_handlers");
  const permissionHandlers = await import(
    "@/ipc/handlers/permissions/handlers"
  );
  const chatStream = streamHandlers.getChatStreamHandler();
  if (!chatStream) {
    throw new Error("chat:stream handler not registered yet");
  }
  return {
    chatStream,
    executePermission: permissionHandlers.getExecutePermissionHandler(),
    cancelStream: streamHandlers.cancelStreamForAutomation,
  };
}

/** Prompt suffix that makes unattended semantics + the outcome contract explicit. */
export function automationPromptSuffix(name: string): string {
  return (
    `\n\n---\n` +
    `You are running UNATTENDED as the scheduled automation "${name}". ` +
    `No human will answer questions, so never wait for input — investigate and conclude. ` +
    `When you finish, end your reply with a line containing only ` +
    `\`${RESULT_SENTINEL} <one-sentence summary of what you found or did>\` — or, if there is ` +
    `genuinely nothing new or actionable to report, a line containing only \`${NOTHING_SENTINEL}\`.`
  );
}

/** Pure outcome parser — exported for tests. */
export function parseAutomationOutcome(finalText: string | null): {
  status: Extract<AutomationRunStatus, "ok" | "nothing-to-report">;
  summary: string | null;
} {
  const lines = (finalText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (last === NOTHING_SENTINEL) {
    return { status: "nothing-to-report", summary: null };
  }
  if (last.startsWith(RESULT_SENTINEL)) {
    return {
      status: "ok",
      summary:
        last.slice(RESULT_SENTINEL.length).trim().slice(0, SUMMARY_MAX) || null,
    };
  }
  // Defensive default: a run that forgot the contract still surfaces.
  const tail = lines.slice(-3).join(" ").slice(0, SUMMARY_MAX);
  return { status: "ok", summary: tail || null };
}

/**
 * What the agent SAID, without its tool calls and their raw results: a run
 * that skipped the result line had its summary taken from the last lines,
 * which were a tool's JSON ('{"success":false,"error":"Command fail…', video
 * session).
 */
export function replyProse(content: string): string {
  return parseAssistantMessageParts(content, false)
    .filter((p): p is Extract<typeof p, { type: "markdown" }> => p.type === "markdown")
    .map((p) => p.content)
    .join("\n\n");
}

function lastAssistantText(chatId: number): string | null {
  const transport = getStreamTransport(chatId);
  if (!transport) return null;
  for (let i = transport.messages.length - 1; i >= 0; i--) {
    const m = transport.messages[i] as { role?: string; content?: string };
    if (
      m.role === "assistant" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      return replyProse(m.content);
    }
  }
  return null;
}

async function broadcastRunUpdate(runId: string): Promise<void> {
  try {
    const { broadcastAutomationRunUpdate } = await import("./notify");
    await broadcastAutomationRunUpdate(runId);
  } catch (e) {
    logger.warn("automation run-update broadcast failed:", e);
  }
}

/**
 * Hand a finished run to the agent — but ONLY if this automation is set to
 * notify it.
 *
 * The whole point of `notifyAgent` lives on this line: an automation the user
 * chose not to share cannot reach the model, so it cannot cost tokens however
 * often it fires. The user still gets the feed row and the OS notification
 * either way; that is what they act on, and what lets them say "there's a new
 * Slack message, deal with it" in their own time.
 */
async function maybeTellTheAgent(
  automation: {
    id: string;
    name: string;
    notifyAgent: boolean;
    workspaceId: number | null;
  },
  status: "ok" | "nothing-to-report" | "error",
  body: string,
  /**
   * A MANUAL run — the agent asked for this one explicitly, so it is told the
   * outcome whatever `notifyAgent` says.
   *
   * `notifyAgent` governs UNATTENDED fires; its whole point is that an
   * automation the user did not choose to share cannot spend tokens while nobody
   * is watching. A run the agent just requested is neither unattended nor
   * silent, and withholding the result would make "run it and see" useless for
   * exactly the automations the user triages themselves.
   */
  forceNotifyAgent = false,
  runId?: string,
): Promise<void> {
  if (
    (!automation.notifyAgent && !forceNotifyAgent) ||
    automation.workspaceId == null
  )
    return;
  if (!forceNotifyAgent) {
    // An unattended run: one chat in that folder, in the app, the CLI or an
    // editor, claims it (agent-delivery.ts) and wakes to act on it (owner).
    // Nothing is queued here: the claim is what keeps it to one chat.
    return;
  }
  // The agent asked for this run: its result goes back to that call, so no
  // other chat claims it too.
  if (runId) {
    const { markRunDelivered } = await import("./agent-delivery");
    const { PROCESS_OWNER } = await import("./process-owner");
    markRunDelivered(runId, PROCESS_OWNER);
  }
  // Nothing to report is not news. Delivering it would train the model to treat
  // automation results as noise, which is exactly what makes a real one get
  // skimmed.
  if (status === "nothing-to-report") return;
  try {
    const { recordAutomationResult } = await import(
      "@/lib/agent/automation-results"
    );
    recordAutomationResult(automation.workspaceId, {
      automationId: automation.id,
      automationName: automation.name,
      status,
      body,
      finishedAt: Date.now(),
    });
  } catch (e) {
    logger.warn("could not queue automation result for the agent:", e);
  }
}

/**
 * Why the run's agent turn failed, if it did (no model available, a refused
 * key, an unreachable provider), from what the turn sent. Such a run used to
 * read the empty reply and be recorded "ok" with nothing in it (video session).
 */
export function turnFailure(
  sends: ReadonlyArray<{ channel: string; payload?: { chatId?: number; error?: unknown; detail?: unknown } | null }>,
  chatId: number,
): string | null {
  const failed = sends.find(
    (x) =>
      (x.channel === "chat:response:error" || x.channel === "chat:stream:disconnected") &&
      (x.payload?.chatId == null || x.payload.chatId === chatId),
  );
  if (!failed) return null;
  // A lost connection's detail is raw transport text ("fetch failed"): say
  // what happened around it, as the chat does (ai-e9).
  if (failed.channel === "chat:stream:disconnected") {
    const detail = String(failed.payload?.detail ?? "").trim();
    return detail ? `Couldn't reach the model provider: ${detail}` : "Couldn't reach the model provider.";
  }
  return String(failed.payload?.error ?? "").trim() || "The agent's turn failed.";
}

export async function executeAutomationRun(
  automationId: string,
  triggerContext: string | null,
  deps?: ExecuteRunDeps,
  /** Set for an agent-requested run: report the outcome regardless of notifyAgent. */
  opts?: { forceNotifyAgent?: boolean },
): Promise<{ runId: string } | null> {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (!automation || !automation.enabled) return null;
  if (automation.workspaceId == null) {
    logger.warn(`automation ${automationId} has no workspace — skipping`);
    return null;
  }
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, automation.workspaceId),
  });
  if (!app) {
    logger.warn(
      `automation ${automationId}: workspace ${automation.workspaceId} missing`,
    );
    return null;
  }

  // notify-only (the default): the fired trigger IS the payload — write the
  // feed row + notification with ZERO model involvement. The user presents it
  // to the model on demand via the feed's "Send to chat".
  if (automation.runMode === "notify-only") {
    const runId = randomUUID();
    const now = new Date();
    const headline =
      triggerContext?.split("\n").find((l) => l.trim()) ??
      `"${automation.name}" fired on schedule`;
    await db.insert(automationRuns).values({
      id: runId,
      automationId,
      sessionId: null,
      status: "ok",
      summary: headline.slice(0, SUMMARY_MAX),
      triggerContext,
      unread: true,
      startedAt: now,
      finishedAt: now,
    });
    await db
      .update(automations)
      .set({ lastRunAt: now, updatedAt: now })
      .where(eq(automations.id, automationId));
    await broadcastRunUpdate(runId);
    try {
      const { notifyRunFinished } = await import("./notify");
      await notifyRunFinished(runId);
    } catch (e) {
      logger.warn("automation notification failed:", e);
    }
    await maybeTellTheAgent(
      automation,
      "ok",
      triggerContext ?? headline,
      opts?.forceNotifyAgent,
      runId,
    );
    logger.info(`automation "${automation.name}" fired (notify-only)`);
    return { runId };
  }

  const resolvedDeps = deps ?? (await resolveProdDeps());
  const timeoutMs = resolvedDeps.timeoutMs ?? RUN_TIMEOUT_MS;
  const runId = randomUUID();
  const sessionId = randomUUID();
  const now = new Date();

  await db.insert(chatSessions).values({
    id: sessionId,
    workspaceId: automation.workspaceId,
    title: `Automation: ${automation.name}`,
    kind: "background",
    status: "running",
    agentMeta: JSON.stringify({ automationId, runId }),
    // Under the chat whose agent set the automation up (none from the UI).
    parentSessionId: automation.sessionId ?? null,
    origin: serializeSessionOrigin({ via: "automation", automationId, surface: currentSurface() }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationRuns).values({
    id: runId,
    automationId,
    sessionId,
    status: "running",
    triggerContext,
    startedAt: now,
    // Which process runs it, beating while it does (runner.ts): another
    // Atlarix starting up must not take this live run for an interrupted one.
    owner: PROCESS_OWNER,
    heartbeatAt: now,
  });
  await db
    .update(automations)
    .set({ lastRunAt: now, updatedAt: now })
    .where(eq(automations.id, automationId));
  await broadcastRunUpdate(runId);

  const chatId = createStreamTransport(automation.workspaceId);
  bindTransportToSession(chatId, sessionId);
  await db
    .update(chatSessions)
    .set({ streamChatId: chatId })
    .where(eq(chatSessions.id, sessionId));

  const sender = makeFakeSender();
  const model = automation.model
    ? (JSON.parse(automation.model) as { provider: string; name: string })
    : null;
  const prompt =
    automation.prompt +
    // Trigger context (PR titles, MCP payloads) is attacker-influenceable — an
    // unattended agent must treat it as data, never as instructions.
    (triggerContext
      ? `\n\n## Trigger context\n${wrapUntrustedData("automation-trigger", triggerContext)}`
      : "") +
    automationPromptSuffix(automation.name);

  let status: AutomationRunStatus = "error";
  let summary: string | null = null;
  let runError: string | null = null;

  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    try {
      resolvedDeps.cancelStream(chatId);
    } catch {
      /* stream may already be gone */
    }
  }, timeoutMs);
  timeoutTimer.unref?.();

  try {
    const req: ChatStreamParams = {
      chatId,
      appId: automation.workspaceId,
      prompt,
      workspaceSessionId: sessionId,
      ...(model ? { modelOverride: model } : {}),
      // Every surviving run mode is read-only: notify-only never reaches here
      // with a prompt to run, and read-only is exactly that. (worktree-write
      // was removed in v14.21.0 along with the sub-agent worktree.)
      streamChatModeOverride: "ask",
      workModeOverride: "ask" as ChatStreamParams["workModeOverride"],
      automation: {
        runId,
        unattended: true,
      },
    };
    const dispatch = await resolvedDeps.chatStream(sender.event, req);
    if (
      dispatch &&
      typeof dispatch === "object" &&
      "error" in dispatch &&
      dispatch.error
    ) {
      throw new Error(String(dispatch.error));
    }

    await automationAutoApprove({
      sender,
      executePermission: resolvedDeps.executePermission,
      chatId,
      timeoutMs,
    });

    const failure = turnFailure(sender.sends, chatId);
    if (timedOut) {
      runError = `timed out after ${Math.round(timeoutMs / 60000)} min`;
    } else if (failure) {
      runError = failure;
    } else {
      const outcome = parseAutomationOutcome(lastAssistantText(chatId));
      status = outcome.status;
      summary = outcome.summary;
    }
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (runError) {
    status = "error";
    summary = summary ?? null;
  }

  const finished = new Date();
  const nothing = status === "nothing-to-report";
  await db
    .update(automationRuns)
    .set({
      status,
      summary,
      error: runError,
      unread: !nothing,
      archived: nothing,
      finishedAt: finished,
    })
    .where(eq(automationRuns.id, runId));
  await db
    .update(chatSessions)
    .set({
      status: status === "error" ? "error" : "done",
      statusError: runError,
      updatedAt: finished,
    })
    .where(eq(chatSessions.id, sessionId));

  deleteStreamTransport(chatId);
  await maybeTellTheAgent(
    automation,
    status,
    runError ?? summary ?? "",
    opts?.forceNotifyAgent,
    runId,
  );
  await broadcastRunUpdate(runId);
  try {
    const { notifyRunFinished } = await import("./notify");
    await notifyRunFinished(runId);
  } catch (e) {
    logger.warn("automation notification failed:", e);
  }

  logger.info(
    `automation "${automation.name}" run ${runId} finished: ${status}${runError ? ` (${runError})` : ""}`,
  );
  return { runId };
}
