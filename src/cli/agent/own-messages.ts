import { splitPeerMessages } from "@/lib/peers/peer-message";

/**
 * Your own messages, newest first: what /undo, esc esc and the editor's "go
 * back" offer. Not your answers to the agent's questions, and never a
 * teammate's message (another Atlarix session's, stored as a user row): it is
 * not yours to go back to and resend (owner). A row with both keeps only your
 * words.
 */
export function ownMessages(messages: ReadonlyArray<{ id: string | number; role: string; content: string }>): Array<{ id: number; text: string }> {
  return messages
    .filter((m) => m.role === "user" && m.content.trim() && !/^\*\*\*Q:\*\*\*/.test(m.content))
    .flatMap((m) => {
      const peers = splitPeerMessages(m.content);
      const text = peers ? peers.filter((s) => s.kind === "text").map((s) => s.text.trim()).join("\n\n") : m.content.trim();
      return text ? [{ id: Number(m.id), text }] : [];
    })
    .reverse();
}
