/**
 * The window's session rating and /feedback (lib/feedback/session-rating.ts),
 * sent from main like every other surface's (main/lib/session-feedback.ts).
 */
import { ipcMain } from "electron";
import {
  forceRating,
  noteRatingAsked,
  ratingAskedAt,
  sendSessionFeedback,
  type FeedbackSession,
} from "../../main/lib/session-feedback";

export function registerFeedbackHandlers(): void {
  ipcMain.handle("feedback:state", () => ({ askedAt: ratingAskedAt() ?? null, force: forceRating() }));
  ipcMain.handle("feedback:rate", async (_e, { rating, session }: { rating: number; session: FeedbackSession }) => {
    noteRatingAsked();
    if (rating !== 1 && rating !== 2 && rating !== 3) return { ok: true };
    return sendSessionFeedback({ kind: "rating", rating }, session ?? {});
  });
  ipcMain.handle("feedback:send", (_e, { text, session }: { text: string; session: FeedbackSession }) =>
    sendSessionFeedback({ kind: "text", body: String(text ?? "") }, session ?? {}),
  );
}
