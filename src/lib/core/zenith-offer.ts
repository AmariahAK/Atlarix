/**
 * Atlarix Auto's top rung failed too (`X-Atlarix-Ladder: top` on the proxy's
 * reply, Auto only): offer Atlarix Zenith, once per chat (owner, 2026-10-29).
 *
 * The header arrives in the Core fetch wrapper, which knows the chat but not the
 * outcome; the turn's error handler knows the outcome but not the header. So
 * the wrapper notes it here and the error handler takes it, which also makes it
 * once: a taken offer is not offered again for that chat in this process.
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
