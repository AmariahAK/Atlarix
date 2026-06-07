/**
 * v12 Tier 2.3 — background agents.
 *
 * A background agent is a normal chat turn run DETACHED: it drives the same
 * `chat:stream` engine through a synthetic recording sender (no foreground
 * renderer), into its own dedicated workspace session, and surfaces the
 * result as a session the user opens afterwards. Design spike:
 * docs/background-agents.md.
 *
 * V1 (read-only) and V2 (write-capable + approval gate) coexist via `mode`:
 *  - mode "ask" (default): read-only exploration; the V1 behavior.
 *  - mode "build": write-capable. A detached turn has no human to approve
 *    writes mid-turn, so the synthetic sender AUTO-APPROVES each
 *    `permission-request` (via `executeBufferedPermission` — the production
 *    approval path; microtask-deferred so the interceptor's `waitForApproval`
 *    promise registers first). The shadow-git snapshot captures every write
 *    automatically; the human reviews the AGGREGATE diff afterward and can
 *    `keep` or `revert` (resolveBackgroundAgent).
 *
 * Status is persisted on the session row (kind="background", status=…) so a
 * finished/failed agent survives a restart. The approval-gate fields
 * (mode, snapshotTurnId, changedFiles, reverted) persist alongside as the
 * row's `agent_meta` JSON (S16) so keep/revert still works after a restart;
 * the in-memory map adds only the truly live field (chatId, for cancel).
 */

import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps, chatSessions } from "@/db/schema";
import { getAtlarixAppPath } from "@/paths/paths";
import { getChatStreamHandler } from "@/ipc/handlers/chat_stream_handlers";
import {
  createBackgroundWorkspaceSession,
  addSessionMessageDirect,
} from "@/ipc/handlers/workspace_session_handlers";
import { setBackgroundAutoApprove } from "@/ipc/handlers/permissions/handlers";
import { listSnapshotFiles } from "@/lib/snapshot/snapshot-manager";
import type { ChatResponseEnd } from "@/ipc/ipc_types";

const logger = log.scope("background-agent");

export type BackgroundAgentStatus = "running" | "done" | "error";
export type BackgroundAgentMode = "ask" | "build";

export interface BackgroundAgentRecord {
  sessionId: string;
  appId: number;
  title: string;
  prompt: string;
  mode: BackgroundAgentMode;
  status: BackgroundAgentStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** The background stream's chatId — target for cancel. */
  chatId?: number;
  /** Snapshot/ledger turn id — target for the approval-gate revert. */
  snapshotTurnId?: string;
  /** Workspace-relative files this turn changed (write mode). */
  changedFiles?: string[];
  /** True once the user reverted the turn's writes. */
  reverted?: boolean;
}

const agents = new Map<string, BackgroundAgentRecord>();

/** Snapshot of all known background agents (newest first), for the UI. */
export function listBackgroundAgents(): BackgroundAgentRecord[] {
  return [...agents.values()].sort((a, b) => b.startedAt - a.startedAt);
}

async function persistStatus(
  sessionId: string,
  status: BackgroundAgentStatus,
  statusError?: string,
): Promise<void> {
  try {
    await db
      .update(chatSessions)
      .set({ status, statusError: statusError ?? null, updatedAt: new Date() })
      .where(eq(chatSessions.id, sessionId));
  } catch (e) {
    logger.warn(`persistStatus(${sessionId}) failed: ${String(e)}`);
  }
}

/** Approval-gate fields persisted on the session row (`agent_meta` JSON, S16). */
interface PersistedAgentMeta {
  mode?: BackgroundAgentMode;
  snapshotTurnId?: string;
  changedFiles?: string[];
  reverted?: boolean;
}

async function persistAgentMeta(rec: BackgroundAgentRecord): Promise<void> {
  const meta: PersistedAgentMeta = {
    mode: rec.mode,
    snapshotTurnId: rec.snapshotTurnId,
    changedFiles: rec.changedFiles,
    reverted: rec.reverted,
  };
  try {
    await db
      .update(chatSessions)
      .set({ agentMeta: JSON.stringify(meta), updatedAt: new Date() })
      .where(eq(chatSessions.id, rec.sessionId));
  } catch (e) {
    logger.warn(`persistAgentMeta(${rec.sessionId}) failed: ${String(e)}`);
  }
}

function parseAgentMeta(raw: string | null): PersistedAgentMeta {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as PersistedAgentMeta;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Rebuild the in-memory map from persisted background sessions on boot.
 * A row still "running" at boot was interrupted by the restart (its turn is
 * gone) — mark it error so the UI doesn't show a stuck spinner.
 */
export async function hydrateBackgroundAgentsFromDb(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.kind, "background"));
    for (const row of rows) {
      let status = (row.status ?? "done") as BackgroundAgentStatus;
      let error = row.statusError ?? undefined;
      if (status === "running") {
        status = "error";
        error = "interrupted by restart";
        void persistStatus(row.id, "error", error);
      }
      // S16: restore the approval-gate fields so keep/revert survives restart.
      const meta = parseAgentMeta(row.agentMeta);
      agents.set(row.id, {
        sessionId: row.id,
        appId: row.workspaceId,
        title: row.title.replace(/^🤖\s*/, ""),
        prompt: "",
        mode: meta.mode ?? "ask",
        status,
        startedAt: row.createdAt.getTime(),
        finishedAt: row.updatedAt.getTime(),
        error,
        snapshotTurnId: meta.snapshotTurnId,
        changedFiles: meta.changedFiles,
        reverted: meta.reverted,
      });
    }
    logger.log(`Hydrated ${rows.length} background agent(s) from DB`);
  } catch (e) {
    logger.warn(`hydrateBackgroundAgentsFromDb failed: ${String(e)}`);
  }
}

interface StartInput {
  appId: number;
  prompt: string;
  title?: string;
  /** v12 2.3 V2: "build" = write-capable (auto-approved). Default read-only. */
  mode?: BackgroundAgentMode;
  /** Injected by callers/tests. */
  startedAt: number;
}

/**
 * Spawn a detached turn. Awaits the turn (callers fire-and-forget for true
 * background). Never throws to the caller: a failed turn is recorded as
 * status "error".
 */
export async function startBackgroundAgent(
  input: StartInput,
): Promise<{ sessionId: string }> {
  const handler = getChatStreamHandler();
  if (!handler) {
    throw new Error("chat:stream handler not registered");
  }

  const mode: BackgroundAgentMode = input.mode ?? "ask";
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
    mode,
    status: "running",
    startedAt: input.startedAt,
    chatId,
  };
  agents.set(sessionId, record);

  // Synthetic sender: capture the streamed buffer + the turn envelope, and —
  // in write mode — auto-approve permission requests.
  let lastMessages: Array<{ role: string; content?: string }> = [];
  let assistantModelContent: string | undefined;
  let snapshotTurnId: string | undefined;
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
        snapshotTurnId = p.snapshotTurnId;
        resolveEnd();
      }
      // NOTE: `permission-request` is broadcast to BrowserWindows by the
      // interceptor, NOT to this sender — write-mode auto-approval is wired at
      // the interceptor via setBackgroundAutoApprove(chatId) below.
    },
  };
  const event = { sender } as unknown as Electron.IpcMainInvokeEvent;

  // v12 2.3 V2: a detached write agent has no human to approve mid-turn — flag
  // its chat for in-process auto-approval (the human reviews the diff after).
  if (mode === "build") setBackgroundAutoApprove(chatId, true);

  try {
    await handler(event, {
      chatId,
      appId: input.appId,
      prompt: input.prompt,
      workspaceSessionId: sessionId,
      workModeOverride: mode,
    });
    await ended; // wait for the detached stream to reach response:end
    record.snapshotTurnId = snapshotTurnId;

    // Persist the assistant message (no renderer did it).
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

    // Write mode: gather changed files from the snapshot manifest for the gate.
    if (mode === "build" && snapshotTurnId) {
      try {
        const [appRow] = await db
          .select({ path: apps.path })
          .from(apps)
          .where(eq(apps.id, input.appId))
          .limit(1);
        if (appRow?.path) {
          const { filesChanged } = await listSnapshotFiles(
            getAtlarixAppPath(appRow.path),
            snapshotTurnId,
          );
          record.changedFiles = filesChanged;
        }
      } catch (e) {
        logger.warn(
          `changed-files gather failed for ${sessionId}: ${String(e)}`,
        );
      }
    }

    record.status = "done";
    record.finishedAt = input.startedAt + 1;
    await persistStatus(sessionId, "done");
    await persistAgentMeta(record); // S16: keep/revert survives restart
    logger.log(
      `Background agent ${sessionId} finished (${content.length} chars, ${record.changedFiles?.length ?? 0} files)`,
    );
  } catch (e) {
    record.status = "error";
    record.error = String(e);
    record.finishedAt = input.startedAt + 1;
    await persistStatus(sessionId, "error", String(e));
    await persistAgentMeta(record); // S16: a failed write turn may still revert
    logger.error(`Background agent ${sessionId} failed: ${String(e)}`);
  } finally {
    if (mode === "build") setBackgroundAutoApprove(chatId, false);
  }

  return { sessionId };
}

/**
 * v12 2.3 V2 approval gate: keep the writes (no-op) or revert the turn's
 * shadow-git snapshot. Returns whether a revert happened.
 */
export async function resolveBackgroundAgent(
  sessionId: string,
  decision: "keep" | "revert",
): Promise<{
  success: boolean;
  reverted: boolean;
  restoredFiles?: number;
  error?: string;
}> {
  const rec = agents.get(sessionId);
  if (!rec)
    return { success: false, reverted: false, error: "Agent not found" };
  if (decision === "keep") return { success: true, reverted: false };
  if (!rec.snapshotTurnId) {
    return { success: false, reverted: false, error: "No snapshot to revert" };
  }
  const [appRow] = await db
    .select({ path: apps.path })
    .from(apps)
    .where(eq(apps.id, rec.appId))
    .limit(1);
  if (!appRow?.path) {
    return { success: false, reverted: false, error: "Workspace not found" };
  }
  const { revertSnapshot } = await import("@/lib/snapshot/snapshot-manager");
  const result = await revertSnapshot({
    workspacePath: getAtlarixAppPath(appRow.path),
    turnId: rec.snapshotTurnId,
  });
  rec.reverted = result.success;
  if (result.success) await persistAgentMeta(rec); // S16
  return {
    success: result.success,
    reverted: result.success,
    restoredFiles: result.restoredFiles,
  };
}

/** v12 2.3: cancel a running background agent (aborts its stream). */
export async function cancelBackgroundAgent(
  sessionId: string,
): Promise<{ success: boolean }> {
  const rec = agents.get(sessionId);
  if (!rec?.chatId) return { success: false };
  const { abortChatStream } = await import(
    "@/ipc/handlers/chat_stream_handlers"
  );
  return { success: abortChatStream(rec.chatId) };
}

/** Test seam: clear the in-memory status map. */
export function _resetBackgroundAgents(): void {
  agents.clear();
}
