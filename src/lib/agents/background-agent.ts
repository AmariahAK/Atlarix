/**
 * v12 Tier 2.3 — background agents (V1, read-only).
 *
 * A background agent is a normal chat turn run DETACHED: it drives the same
 * `chat:stream` engine through a synthetic recording sender (no foreground
 * renderer), into its own dedicated workspace session, and surfaces the
 * result as a session the user opens afterwards. Design spike:
 * docs/background-agents.md.
 *
 * V1 scope (deliberately small — this is the riskiest new surface):
 *  - READ-ONLY: forced to ask-mode (no writes, no run_command), so a detached
 *    turn can never mutate the workspace without a human watching. Worktrees
 *    and write-capable background agents are a separate, later decision.
 *  - The engine persists the USER message at dispatch; since no renderer fires
 *    `messages:add` on response:end, the runner persists the ASSISTANT message
 *    itself (captured from the stream buffer) via `addSessionMessageDirect`.
 *  - Status lives in an in-memory map (running/done/error) surfaced to an
 *    "agents" view; it does not survive a restart (a finished agent is just
 *    its session, which does persist).
 */

import log from "electron-log";
import { getChatStreamHandler } from "@/ipc/handlers/chat_stream_handlers";
import {
  createBackgroundWorkspaceSession,
  addSessionMessageDirect,
} from "@/ipc/handlers/workspace_session_handlers";
import type { ChatResponseEnd } from "@/ipc/ipc_types";

const logger = log.scope("background-agent");

export type BackgroundAgentStatus = "running" | "done" | "error";

export interface BackgroundAgentRecord {
  sessionId: string;
  appId: number;
  title: string;
  prompt: string;
  status: BackgroundAgentStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const agents = new Map<string, BackgroundAgentRecord>();

/** Snapshot of all known background agents (newest first), for the UI. */
export function listBackgroundAgents(): BackgroundAgentRecord[] {
  return [...agents.values()].sort((a, b) => b.startedAt - a.startedAt);
}

interface StartInput {
  appId: number;
  prompt: string;
  title?: string;
  /** Injected by callers/tests; defaults to wall-clock at start. */
  startedAt: number;
}

/**
 * Spawn a detached read-only turn. Returns the new session id immediately-ish
 * (after the turn completes — callers run this without awaiting for true
 * fire-and-forget, or await it in tests). Never throws to the caller: a failed
 * turn is recorded as status "error" on the agent record.
 */
export async function startBackgroundAgent(
  input: StartInput,
): Promise<{ sessionId: string }> {
  const handler = getChatStreamHandler();
  if (!handler) {
    throw new Error("chat:stream handler not registered");
  }

  const title =
    input.title?.trim() ||
    input.prompt.trim().slice(0, 60) ||
    "Background agent";
  const { sessionId, chatId } = await createBackgroundWorkspaceSession(
    input.appId,
    `🤖 ${title}`,
  );

  const record: BackgroundAgentRecord = {
    sessionId,
    appId: input.appId,
    title,
    prompt: input.prompt,
    status: "running",
    startedAt: input.startedAt,
  };
  agents.set(sessionId, record);

  // Synthetic sender: capture the streamed message buffer + the turn envelope
  // so we can persist the assistant message the renderer normally would. The
  // handler returns immediately (`void runStream()`); the turn's real terminal
  // signal is `chat:response:end` on this sender — await that.
  let lastMessages: Array<{ role: string; content?: string }> = [];
  let assistantModelContent: string | undefined;
  let resolveEnd: () => void = () => {};
  const ended = new Promise<void>((r) => {
    resolveEnd = r;
  });
  const sender = {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, payload: unknown) => {
      if (channel === "chat:response:chunk") {
        const p = payload as {
          messages?: Array<{ role: string; content?: string }>;
        };
        if (Array.isArray(p.messages)) lastMessages = p.messages;
      } else if (channel === "chat:response:end") {
        const p = payload as ChatResponseEnd;
        assistantModelContent = p.assistantModelContent;
        resolveEnd();
      }
    },
  };
  const event = { sender } as unknown as Electron.IpcMainInvokeEvent;

  try {
    await handler(event, {
      chatId,
      appId: input.appId,
      prompt: input.prompt,
      workspaceSessionId: sessionId,
      // V1: read-only. ask-mode = exploration tool surface, no writes/run.
      workModeOverride: "ask",
    });
    await ended; // wait for the detached stream to reach response:end

    // Persist the assistant message (no renderer did it). Take the last
    // assistant turn from the captured buffer.
    const assistant = [...lastMessages]
      .reverse()
      .find((m) => m.role === "assistant");
    const content = (assistant?.content ?? "").trim();
    if (content) {
      await addSessionMessageDirect(
        sessionId,
        "assistant",
        content,
        undefined,
        assistantModelContent
          ? { modelContent: assistantModelContent }
          : undefined,
      );
    }
    record.status = "done";
    record.finishedAt = input.startedAt + 1; // monotonic-ish; real ts stamped by caller
    logger.log(
      `Background agent ${sessionId} finished (${content.length} chars)`,
    );
  } catch (e) {
    record.status = "error";
    record.error = String(e);
    record.finishedAt = input.startedAt + 1;
    logger.error(`Background agent ${sessionId} failed: ${String(e)}`);
  }

  return { sessionId };
}

/** Test seam: clear the in-memory status map. */
export function _resetBackgroundAgents(): void {
  agents.clear();
}
