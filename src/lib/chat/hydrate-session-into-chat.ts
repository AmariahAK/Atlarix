/**
 * Load one session's history from the DB into a chat's renderer state.
 *
 * Extracted from `WorkspaceSessionList.handleSelectSession`, which was the only
 * code that knew how to do this — and that was the problem. `ChatTabStrip`
 * switched tabs by flipping ids alone, relying on the atoms still holding that
 * chat's messages, so there was no way to free a cold session's state without
 * turning a tab switch into an empty chat. Activation has to be re-loadable
 * before it can be evictable.
 *
 * What stays in the caller: the loading overlay, the busy flag, navigation, the
 * "Restored previous session" toast and tab registration. Those are UI decisions
 * that differ per entry point. What lives here is the part that must be identical
 * everywhere — the read, the shaping, the transport hydration, and the display
 * rehydration that rebuilds frozen tool cards.
 */

import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import type { Message } from "@/ipc/ipc_types";
import type {
  PasteAttachmentMeta,
  StoredFileAttachment,
} from "@/ipc/ipc_types";
import type { DisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import {
  chatMessagesByIdAtom,
  turnSnapshotTurnIdByMessageIdAtom,
} from "@/atoms/chatAtoms";
import { SESSION_LOAD_MESSAGE_LIMIT } from "@/constants/session_constants";
import { buildRevertSnapshotMap } from "@/lib/chat/revert-snapshot-rehydrate";
import {
  attachmentInfoFromStoredFile,
  hydrateAttachmentStoreFromMessages,
} from "@/lib/attachment-persistence";
import { diagSpan, diagSpanSync } from "@/lib/diag/session-load-diag";
import { markChatRehydrated } from "@/lib/chat/clear-chat-atoms";

/**
 * Renderer-only display ids, counting DOWN from a large negative number so they
 * can never collide with the positive ids main assigns.
 */
let displayMessageId = -10000;

type SessionMessageForUi = {
  id: string;
  role: string;
  content: string;
  status?: "complete" | "interrupted" | "waiting";
  createdAt: Date;
  displaySnapshot?: DisplaySnapshotV1 | null;
  modelContent?: string | null;
  pasteAttachments?: PasteAttachmentMeta[] | null;
  fileAttachments?: StoredFileAttachment[] | null;
  maxTokensUsed?: number | null;
};

export function sessionMessagesToUiMessages(
  sessionId: string,
  chatId: number,
  messages: SessionMessageForUi[],
): Message[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      id: displayMessageId--,
      // v12 0.4-C2: keep the DB row UUID — edits target the row directly.
      sessionRowId: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      chatId,
      createdAt: m.createdAt,
      ...(m.status === "interrupted" ? { interrupted: true } : {}),
      ...(m.status === "waiting" ? { waiting: true } : {}),
      ...(m.modelContent ? { modelContent: m.modelContent } : {}),
      // The provider's real token total for this turn — the meter prefers it
      // over its own estimate, so it has to survive the round trip.
      ...(m.maxTokensUsed != null ? { maxTokensUsed: m.maxTokensUsed } : {}),
      ...(m.pasteAttachments?.length
        ? { pasteAttachments: m.pasteAttachments }
        : {}),
      ...(m.fileAttachments?.length
        ? {
            fileAttachments: m.fileAttachments,
            attachments: m.fileAttachments.map(attachmentInfoFromStoredFile),
          }
        : {}),
      ...(m.displaySnapshot ? { displaySnapshot: m.displaySnapshot } : {}),
    }));
}

export type HydratedSession = {
  session: Awaited<ReturnType<IpcClient["getWorkspaceSession"]>>["session"];
  uiMessages: Message[];
  truncated: boolean;
};

/**
 * Read the session and put its history into `chatId`'s renderer state.
 *
 * Never call this for a chat that is currently STREAMING: the read would land on
 * top of live state and clobber the turn in flight. Callers gate on
 * `shouldUseStreamingSessionFastPath` for exactly that reason.
 */
export async function hydrateSessionIntoChat(args: {
  sessionId: string;
  chatId: number;
}): Promise<HydratedSession> {
  const { sessionId, chatId } = args;
  const store = getDefaultStore();

  const { session, messages, truncated } = await diagSpan(
    "renderer: sessions:get IPC (incl. main→renderer clone)",
    () =>
      IpcClient.getInstance().getWorkspaceSession(sessionId, {
        limit: SESSION_LOAD_MESSAGE_LIMIT,
      }),
    { count: (r) => r.messages.length },
  );

  const uiMessages = diagSpanSync(
    "renderer: sessionMessagesToUiMessages",
    () => sessionMessagesToUiMessages(session.id, chatId, messages),
    { count: (m) => m.length },
  );
  hydrateAttachmentStoreFromMessages(uiMessages);

  // Ids only. This used to ship content + modelContent + displaySnapshot BACK to
  // main — bytes main had just read out of SQLite for `sessions:get`. Main joins
  // the bodies from its own rows now; everything the transport needs (including
  // `maxTokensUsed`, the token meter's ground truth on reload) comes from the DB
  // rather than a round trip.
  await diagSpan(
    "renderer: sessions:hydrate-transport IPC (ids only)",
    () =>
      IpcClient.getInstance().hydrateSessionTransport(
        chatId,
        session.id,
        uiMessages.map((m) => ({
          id: m.id,
          sessionRowId: m.sessionRowId ?? null,
        })),
      ),
    { count: (r) => r.hydrated },
  );

  store.set(chatMessagesByIdAtom, (prev) => {
    const next = new Map(prev);
    next.set(chatId, uiMessages);
    return next;
  });

  // Rehydrate revert-turn checkpoints so the affordance survives a restart.
  const restoredSnapshots = buildRevertSnapshotMap(messages, uiMessages);
  if (restoredSnapshots.size > 0) {
    store.set(turnSnapshotTurnIdByMessageIdAtom, (prev) => {
      const next = new Map(prev);
      for (const [id, sid] of restoredSnapshots) next.set(id, sid);
      return next;
    });
  }

  const { replaceDisplayHydrationForChat } = await import(
    "@/lib/chat/apply-stream-display-hydration"
  );
  // Re-parses every assistant message's raw content on top of the snapshot it
  // already has (threadFromSnapshot →
  // buildCompletedStreamThreadFromAssistantContent), then does the snapshot pass
  // a second time in applyStreamDisplayHydration.
  //
  // This is also the ONLY thing that rebuilds the per-message display atoms, and
  // therefore the reason an evicted chat must be reloaded through here rather
  // than left to a background stream: the stream restores messages (main sends
  // the whole list on every chunk) but nothing rebuilds the frozen tool cards, so
  // the history would come back looking complete and rendering bare.
  diagSpanSync("renderer: replaceDisplayHydrationForChat", () =>
    replaceDisplayHydrationForChat(chatId, uiMessages),
  );

  markChatRehydrated(chatId);

  return { session, uiMessages, truncated: Boolean(truncated) };
}
