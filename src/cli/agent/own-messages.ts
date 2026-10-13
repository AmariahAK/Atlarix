import { splitPeerMessages } from "@/lib/peers/peer-message";
import { BUILD_FROM_PLAN_PROMPT } from "@/lib/work-mode";

/**
 * Your own messages, newest first: what /undo, esc esc and the editor's "go
 * back" offer. Not your answers to the agent's questions, and never a
 * teammate's message (another Atlarix session's, stored as a user row): it is
 * not yours to go back to and resend (owner). A row with both keeps only your
 * words.
 */
export function ownMessages(messages: ReadonlyArray<{ id: string | number; role: string; content: string }>): Array<{ id: number; text: string }> {
  return messages
    // Nor "Build it": Atlarix sends that turn for you (QA: it was offered as your
    // latest message, to edit and resend).
    .filter((m) => m.role === "user" && m.content.trim() && !/^\*\*\*Q:\*\*\*/.test(m.content) && m.content.trim() !== BUILD_FROM_PLAN_PROMPT)
    .flatMap((m) => {
      const peers = splitPeerMessages(m.content);
      const text = peers ? peers.filter((s) => s.kind === "text").map((s) => s.text.trim()).join("\n\n") : m.content.trim();
      return text ? [{ id: Number(m.id), text }] : [];
    })
    .reverse();
}

/**
 * Your edited words for a row, with any teammate's messages it held kept in
 * front of them, as they were. Going back to your part of such a row must not
 * drop what the teammate said.
 */
export function withTeammateMessages(original: string, edited: string): string {
  const theirs = original.match(/<atlarix-peer-message[^>]*>[\s\S]*?<\/atlarix-peer-message>/g) ?? [];
  return theirs.length ? `${theirs.join("\n\n")}\n\n${edited}` : edited;
}
