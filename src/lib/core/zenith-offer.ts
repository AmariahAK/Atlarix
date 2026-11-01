/**
 * Atlarix Auto's top rung kept failing (`X-Atlarix-Ladder: top`, Auto only):
 * offer Atlarix Zenith, once per chat (owner, 2026-10-29).
 *
 * A QUALITY signal, not an HTTP one (ai-34): the session is already on the top
 * model of both providers and keeps failing (the same tool calls again, an edit
 * that errors, the user's Retry), so the header comes on a normal 200 reply.
 * The Core fetch wrapper notes it; the turn's end takes it (safe_sender.ts, the
 * one place every end passes), or the turn's error when the turn failed. Taken
 * once: a chat is not offered Zenith again in this process.
 */
import { getCoreZenith } from "@/ipc/shared/core-model-override-store";

const pending = new Set<number>();
const offered = new Set<number>();

/** From the Core fetch wrapper: an Auto reply said the top of the ladder failed. */
export function noteLadderTop(chatId: number | undefined, headers: Headers): void {
  if (chatId == null || offered.has(chatId)) return;
  if (headers.get("x-atlarix-ladder") === "top") pending.add(chatId);
}

/** From the turn's error handler: true once per chat, when Zenith is offered at all. */
export function takeZenithOffer(chatId: number | undefined): boolean {
  if (chatId == null || !pending.has(chatId)) return false;
  pending.delete(chatId);
  if (offered.has(chatId) || !getCoreZenith()) return false;
  offered.add(chatId);
  return true;
}

/** Test-only. */
export function __resetZenithOfferForTests(): void {
  pending.clear();
  offered.clear();
}
