/**
 * Main-process wiring for sessions that message each other (peers.ts): which
 * sessions this process runs, and what "deliver" means here.
 *
 * Shared by the desktop app and the CLI — both run these handlers in their main
 * process (the CLI through the Electron stub).
 */
import { eq } from "drizzle-orm";
import log from "electron-log";
import { db, getDb } from "@/db";
import { apps, chatSessions } from "@/db/schema";
import {
  isPlaceholderTitle,
  noteLiveSession,
  noteSessionModel,
  publishPeerState,
  setDefaultModelLabel,
  startPeerInbox,
  type Surface,
} from "./peers";
import { isChatStreamLive, isChatUserStopped, onStreamLiveChange } from "@/ipc/handlers/chat_stream/stream-state";
import { listPendingUserInterjections, recordUserInterjection } from "@/lib/agent/user-interjections";
import { broadcastToAllWindows } from "@/ipc/utils/broadcast_all_windows";
import { readSettings } from "@/main/settings";
import { parseSessionModel, serializeSessionModel } from "@/lib/session-choices";

const logger = log.scope("peers");

/** Register a session this process has open (on start, open and rename). */
export async function noteSessionOpen(
  sessionId: string,
  chatId: number,
): Promise<void> {
  try {
    const session = await db.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
    });
    if (!session) return;
    const app = session.workspaceId
      ? await db.query.apps.findFirst({
          where: eq(apps.id, session.workspaceId),
        })
      : undefined;
    noteLiveSession({
      sessionId,
      chatId,
      name:
        (session.title?.trim() && !isPlaceholderTitle(session.title)
          ? session.title.trim()
          : "") ||
        `New ${process.env.ATLARIX_PEER_SURFACE === "editor" ? "editor " : process.env.ATLARIX_SURFACE === "cli" ? "CLI " : ""}session (${(app?.path ?? "").split(/[\\/]/).pop() || "no folder"})`,
      workspace: app?.path ?? "",
    });
    noteAppChatModel(sessionId, parseSessionModel(session.model));
  } catch (e) {
    logger.debug(
      `could not register session ${sessionId}: ${(e as Error).message}`,
    );
  }
}

/**
 * A handoff from the CLI: show `sessionId` in the app and carry on there. The
 * window already showing its workspace if there is one, else the front window;
 * the renderer selects the workspace and opens the session (layout.tsx).
 * `quiet`: no "Continued from the terminal" line (a notification's click).
 */
export async function openSessionInApp(
  sessionId: string,
  opts: { quiet?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
  });
  if (!session) return { ok: false, error: "no such session" };
  const app = session.workspaceId
    ? await db.query.apps.findFirst({ where: eq(apps.id, session.workspaceId) })
    : undefined;
  const { getPrimaryWindow, sendToWorkspaceWindow } = await import(
    "@/main/workspace-window-manager"
  );
  const payload = { sessionId, workspaceId: session.workspaceId, ...(opts.quiet ? { quiet: true } : {}) };
  if (
    app?.path &&
    sendToWorkspaceWindow(app.path, "session:handoff-open", payload)
  ) {
    return { ok: true };
  }
  const win = getPrimaryWindow();
  if (!win) return { ok: false, error: "the app has no window open" };
  const { deliverToWindow } = await import("@/main/create-app-browser-window");
  deliverToWindow(win, "session:handoff-open", payload);
  try {
    const { app: electronApp } = await import("electron");
    electronApp.focus?.({ steal: true });
  } catch {
    /* focusing is a nicety */
  }
  return { ok: true };
}

let unhookLive: (() => void) | null = null;

/**
 * Another session sets this one's mode and/or model (item 9): checked here,
 * the mode stored on the session as a mode picked in it is, and the change
 * told to the windows (the app's, the CLI's and the editors' sessions), which
 * use it from the next turn and show `notice`.
 */
async function applyPeerSettings(
  target: { chatId: number; sessionId: string; name?: string },
  set: { mode?: string; model?: string; plan?: string; planText?: string; approval?: { operationId: string; mode: "once" | "deny" } },
  from: { name: string },
): Promise<{ ok: boolean; error?: string; notice?: string; startTurn?: string }> {
  const s = await import("./session-settings");
  // A peer-reviewed permission approval (0aa): answer it first, before any mode/model change.
  if (set.approval) {
    const { operationId, mode: approvalMode } = set.approval;
    if (!operationId) return { ok: false, error: "approval needs an operationId" };
    if (approvalMode !== "once" && approvalMode !== "deny")
      return { ok: false, error: `approval mode must be "once" or "deny"` };
    const name = target.name ?? "that session";
    // Judged against the request itself, as main's permission layer holds it:
    // one that can't be found can't be checked, so it isn't answered.
    const { getInterceptorForChat, answerPermissionInMain } = await import("@/ipc/handlers/permissions/handlers");
    const op = getInterceptorForChat(target.chatId)?.getPendingOperations().find((o) => o.id === operationId);
    if (!op) return { ok: false, error: `${name} has no pending request ${operationId} (answered already, or never asked)` };
    const { summarizePermissionRequest, isPeerApprovableSummary } = await import("./approval-summary");
    const summary = summarizePermissionRequest(operationId, op.request);
    // Security: high-risk requests need the owner, never a peer (dynamic signals only).
    if (approvalMode !== "deny" && !isPeerApprovableSummary(summary)) {
      return {
        ok: false,
        error: `Permission request ${operationId} is high-risk (${summary.operation ?? "unknown"}: ${summary.summary}) — it needs the owner to approve, not a peer session.`,
      };
    }
    const result = await answerPermissionInMain(target.chatId, operationId, approvalMode);
    if (result.error) return { ok: false, error: `not answered: ${result.error}` };
    const verb = approvalMode === "once" ? "approved" : "denied";
    return { ok: true, notice: `Permission ${verb} by ${from.name}.` };
  }
  // Its plan awaiting approval (item 11): checked first, so nothing else
  // changes when the plan part is refused.
  let plan: { action: import("./session-settings").PeerPlanAction; id: string } | undefined;
  if (set.plan) {
    const action = s.parsePlanAction(set.plan);
    if (!action) return { ok: false, error: `no plan action "${set.plan}": approve, reject or update` };
    const name = target.name || "that session";
    // As the user's own Build/edit: not while a turn runs, which may be writing it.
    if (isChatStreamLive(target.chatId)) return { ok: false, error: `${name} is busy; answer its plan when its turn ends` };
    if (action === "approve" && set.mode) return { ok: false, error: "approve builds the plan in Build; send it without a mode" };
    if (action === "update" && !set.planText?.trim()) return { ok: false, error: "update needs plan_text: the whole new plan" };
    const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");
    const latest = await getLatestPlanArtifact(target.sessionId, "plan").catch(() => null);
    if (!latest) return { ok: false, error: `${name} has no plan awaiting approval` };
    plan = { action, id: latest.id };
  }
  let mode: import("./session-settings").PeerMode | undefined;
  if (set.mode) {
    const parsed = s.parseMode(set.mode);
    if (!parsed) return { ok: false, error: `no mode "${set.mode}": build, explore, plan, debug or review` };
    mode = parsed;
  }
  const row = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, target.sessionId) });
  let model: { provider: string; name: string; label: string } | undefined;
  if (set.model) {
    const { settableModelOptions } = await import("@/cli/agent/models");
    const options = await settableModelOptions().catch(() => []);
    const hit = s.matchModel(set.model, options);
    if ("error" in hit) return { ok: false, error: hit.error };
    // The name list_sessions shows: "label (provider)" when two share a label.
    const shown = s.modelNames(options).find((n) => n.option === hit)?.name ?? hit.label;
    model = { provider: hit.provider, name: hit.name, label: shown };
  }
  // Approve: exactly the user's Build (the plan card's and /build): the plan
  // goes to building, the session to Build, and the build turn starts.
  let startTurn: string | undefined;
  if (plan) {
    const handlers = await import("@/ipc/handlers/plan_artifact_handlers");
    if (plan.action === "approve") {
      await handlers.setPlanStatusAndAnnounce(plan.id, "building");
      mode = "build";
      startTurn = (await import("@/lib/work-mode")).BUILD_FROM_PLAN_PROMPT;
    } else if (plan.action === "update") {
      const text = set.planText!.trim();
      await handlers.updatePlanAndAnnounce(plan.id, text, s.planTitleOf(text));
    }
  }
  if (mode && row) {
    await db.update(chatSessions).set({ workMode: mode }).where(eq(chatSessions.id, target.sessionId));
  }
  if (model && row) {
    // That chat's own model from now on (15.11.1), stored like a pick made in it.
    // Its effort stays only if the model is the same one: levels belong to a model.
    const was = parseSessionModel(row.model);
    const same = was?.provider === model.provider && was?.name === model.name;
    await db
      .update(chatSessions)
      .set({
        model: serializeSessionModel({
          provider: model.provider,
          name: model.name,
          ...(same && was?.effort ? { effort: was.effort } : {}),
          ...(same && was?.deepThinking !== undefined ? { deepThinking: was.deepThinking } : {}),
        }),
      })
      .where(eq(chatSessions.id, target.sessionId));
  }
  if (model) noteSessionModel(target.sessionId, model.label);
  const notice = [
    set.mode || set.model ? s.settingsNotice({ mode: set.mode ? mode : undefined, model: model?.label }, from.name) : "",
    plan ? s.planNotice(plan.action, from.name) : "",
  ]
    .filter(Boolean)
    .join(" ");
  broadcastToAllWindows("session:peer-settings", {
    chatId: target.chatId,
    sessionId: target.sessionId,
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(plan ? { plan: plan.action, planId: plan.id } : {}),
    notice,
  });
  return { ok: true, notice, ...(startTurn ? { startTurn } : {}) };
}

/** Start the inbox for this process. Never throws. */
/**
 * The app's selected model, as people see it, for its chats' list_sessions
 * lines (a chat another session set a model for shows that one instead).
 * Read on each publish, so a pick shows within one heartbeat; the label is
 * looked up once per model.
 */
let appDefault: { key: string; label: string } | null = null;
function appDefaultModelLabel(): string | undefined {
  const sel = readSettings().selectedModel;
  if (!sel?.provider || !sel.name) return undefined;
  const key = `${sel.provider}/${sel.name}`;
  if (appDefault?.key !== key) {
    const mine = { key, label: sel.name };
    appDefault = mine;
    void import("@/cli/agent/models")
      .then((m) => m.loadModelOptions())
      .then((opts) => {
        const o = opts.find((x) => x.provider === sel.provider && x.name === sel.name);
        if (o) mine.label = o.label;
      })
      .catch(() => {});
  }
  return appDefault.label;
}

/** This process's surface ("app" once the app's inbox starts). */
let hostSurface: Surface | null = null;

/** "label" for a model as the pickers name it (its id when the list doesn't have it). */
async function modelLabel(m: { provider: string; name: string }): Promise<string> {
  try {
    const { loadModelOptions } = await import("@/cli/agent/models");
    const o = (await loadModelOptions()).find((x) => x.provider === m.provider && x.name === m.name);
    return o?.label ?? m.name;
  } catch {
    return m.name;
  }
}

/** An app chat's own model, as list_sessions shows it (15.11.1: each chat has one). */
export function noteAppChatModel(sessionId: string, m: { provider: string; name: string } | null): void {
  if (hostSurface !== "app" || !m) return;
  void modelLabel(m).then((label) => noteSessionModel(sessionId, label));
}

export async function startPeerMessaging(surface: Surface): Promise<void> {
  hostSurface = surface;
  // The CLI and the editors report each session's own model; the app's chats
  // report theirs as they open (noteAppChatModel), the default covers the rest.
  if (surface === "app") setDefaultModelLabel(appDefaultModelLabel);
  try {
    await startPeerInbox({
      surface,
      database: () => {
        try {
          return getDb().$client as never;
        } catch {
          return null;
        }
      },
      host: {
        isBusy: (chatId) => {
          try {
            return isChatStreamLive(chatId);
          } catch {
            return false;
          }
        },
        userStopped: (chatId) => isChatUserStopped(chatId),
        enqueue: (chatId, id, text) => {
          recordUserInterjection(
            chatId,
            { id: `peer-${id}`, text },
            { cap: null },
          );
        },
        wake: (chatId) => {
          // The same signal a finished background job uses; the app and the CLI
          // answer `peer_message` by opening a turn with what is queued.
          broadcastToAllWindows("chat:background-job-update", {
            chatId,
            source: "peer",
            status: "peer_message",
          });
        },
        // Another surface following this session: the user's own words for the
        // turn (the path a message typed here mid-turn takes), and Stop, which
        // the surface running the chat presses for itself, as its own Stop
        // button would (the app's window, the CLI: `chat:remote-stop`).
        steer: (chatId, id, text) => {
          recordUserInterjection(chatId, { id: `remote-${id}`, text });
        },
        stop: (chatId) => {
          broadcastToAllWindows("chat:remote-stop", { chatId });
        },
        pending: (chatId, id) => listPendingUserInterjections(chatId).some((m) => m.id === `peer-${id}`),
        ...(surface === "app" ? { openSession: (id: string) => openSessionInApp(id) } : {}),
        applySettings: applyPeerSettings,
        inbound: () => {
          try {
            const v = (readSettings() as { peerMessages?: string })
              .peerMessages;
            return v === "refuse" ? "refuse" : "accept";
          } catch {
            return "accept";
          }
        },
      },
    });
    // `busy` as a turn starts and ends, not on the next heartbeat: a surface
    // following the session would otherwise see it up to 15 s late.
    unhookLive ??= onStreamLiveChange(() => publishPeerState());
  } catch (e) {
    logger.warn(`messaging between sessions is off: ${(e as Error).message}`);
  }
}
