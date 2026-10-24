/**
 * The model + effort the chat in front runs on (15.11.1: each chat has its own).
 *
 * In order: a model another session set for this chat (item 9), the session's
 * stored choice, then the app's default (`settings.selectedModel` / `effort`),
 * which is what a chat with nothing stored, or no session, runs on. Every chip,
 * label and menu that names "the model" reads this, so none of them can show
 * the app-wide pick for a chat that runs on another one.
 */
import { getDefaultStore, useAtomValue } from "jotai";
import { peerModelByChatIdAtom } from "@/atoms/chatAtoms";
import { activeSessionModelAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { useSettings } from "@/hooks/useSettings";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import { modelOfChoice, type SessionModelChoice } from "@/lib/session-choices";

export type ChatModel = {
  model: LargeLanguageModel | undefined;
  effort: string | undefined;
  deepThinking: boolean;
};

export function resolveChatModel(params: {
  settings: Pick<UserSettings, "selectedModel" | "effort" | "deepThinking"> | null | undefined;
  session: SessionModelChoice | null | undefined;
  peer: { provider: string; name: string } | undefined;
}): ChatModel {
  const { settings, session, peer } = params;
  if (peer) {
    // Its effort is the session's when the peer set the model it already had.
    const same = session?.provider === peer.provider && session?.name === peer.name;
    return {
      model: { provider: peer.provider, name: peer.name },
      effort: same ? session?.effort : undefined,
      deepThinking: same ? !!session?.deepThinking : false,
    };
  }
  if (session) {
    return { model: modelOfChoice(session), effort: session.effort, deepThinking: !!session.deepThinking };
  }
  return {
    model: settings?.selectedModel,
    effort: settings?.effort,
    deepThinking: !!settings?.deepThinking,
  };
}

/** `chatId`: the chat the control belongs to (the composer's). */
export function useChatModel(chatId?: number | null): ChatModel {
  const { settings } = useSettings();
  const session = useAtomValue(activeSessionModelAtom);
  const peer = useAtomValue(peerModelByChatIdAtom).get(chatId ?? -1);
  return resolveChatModel({ settings, session, peer });
}

/**
 * The active session's choice at the moment of a send, outside React: what the
 * turn is dispatched with. `null` when no session is in front or nothing is stored.
 */
export function activeSessionChoiceFor(workspaceSessionId: string | null | undefined): SessionModelChoice | null {
  if (!workspaceSessionId) return null;
  const store = getDefaultStore();
  if (store.get(activeWorkspaceSessionIdAtom) !== workspaceSessionId) return null;
  return store.get(activeSessionModelAtom);
}
