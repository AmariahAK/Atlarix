/**
 * The sessions that handed a conversation a task, newest last — the only ones
 * the side-panel agent's `send_message` may reach (tools/dispatch.ts). Read
 * from the conversation's own rows, so nothing the model says can add to it.
 */
import { splitPeerMessages } from "@/lib/peers/peer-message";
import type { CoreMessage } from "../core/client";

export function peerSendersOf(
  history: CoreMessage[],
): { sessionId: string; name: string }[] {
  const out = new Map<string, { sessionId: string; name: string }>();
  for (const m of history) {
    if (m.role !== "user" || typeof m.content !== "string") continue;
    for (const seg of splitPeerMessages(m.content) ?? []) {
      if (seg.kind !== "peer" || !seg.replyTo) continue;
      out.delete(seg.replyTo); // re-inserted last: newest last
      out.set(seg.replyTo, { sessionId: seg.replyTo, name: seg.from || seg.replyTo });
    }
  }
  return [...out.values()];
}
