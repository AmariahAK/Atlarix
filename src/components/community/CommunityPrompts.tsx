/**
 * The two one-time community asks, as dismissible cards.
 *
 * 1. "Where did you hear about Atlarix?" — first open after signing in.
 * 2. "Review us on PeerPush"            — second active day, once a task has
 *                                         actually been completed.
 *
 * THREE rules hold this together:
 *
 * - **Never ask the same USER twice.** Not per session, not per install — per
 *   account. Answer it, quit, sign out, come back: never asked again. The
 *   stored answer carries the `userId` it was given by and is compared against
 *   the current one, so a DIFFERENT account on the same machine still gets
 *   asked exactly once. (Storing the answer without comparing the id would
 *   silently skip everyone after the first person on a shared machine.)
 * - **At most one card on screen at a time.** Separate from the rule above: it
 *   stops the two asks stacking if their triggers ever coincide. It resets when
 *   the signed-in user changes, so switching accounts asks the new one straight
 *   away rather than making them restart.
 * - **Both live in Settings → Community permanently.** Dismissing here is not
 *   destroying the opportunity, so dismissal can be cheap and guilt-free.
 *
 * DORMANCY IS EXPECTED, NOT A BUG: `activeDayCount` only starts counting from
 * the build that introduced it. Nobody has a second active day until they've
 * used that build on two separate calendar days, so the PeerPush card is
 * silent for a week or more after release. Don't debug it as broken.
 */
import { useEffect, useState } from "react";
import { MessageCircle, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { useAuth } from "@/lib/auth/useAuth";
import { PEERPUSH_REVIEW_URL } from "@/lib/community/acquisition";
import { DISCORD_INVITE_URL } from "@/lib/community/discord";
import { AcquisitionSourceQuestion } from "./AcquisitionSourceQuestion";

/** Only one card on screen at a time; reset when the signed-in user changes. */
let cardShownFor: string | null = null;

type Ask = "acquisition" | "peerpush" | null;

export function CommunityPrompts() {
  const { settings, refreshSettings } = useSettings();
  const { user } = useAuth();
  const [ask, setAsk] = useState<Ask>(null);
  const [dismissed, setDismissed] = useState(false);

  // Switching accounts is a fresh slate: the new user has their own answer
  // state and must not inherit the previous one's dismissal.
  useEffect(() => {
    if (cardShownFor !== null && cardShownFor !== (user?.id ?? null)) {
      cardShownFor = null;
      setAsk(null);
      setDismissed(false);
    }
  }, [user?.id]);

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    if (cardShownFor !== null || ask || dismissed || !settings) return;

    // Ask 1 — needs a signed-in user, because "already answered" is per ACCOUNT.
    // Comparing the stored userId is the whole point: without it, the first
    // person to answer on a machine would silence the question for everyone
    // who signs in after them.
    const stored = settings.acquisitionSource;
    const answeredByThisUser = !!stored?.source && stored.userId === currentUserId;
    if (currentUserId && !answeredByThisUser) {
      cardShownFor = currentUserId;
      setAsk("acquisition");
      return;
    }

    // Ask 2 — second active day AND at least one completed task, so we only ask
    // people who have actually got something out of the product.
    const secondDay = (settings.activeDayCount ?? 0) >= 2;
    const didWork = !!settings.firstTaskCompletedAt;
    const peerPushSettled =
      !!settings.peerPushPrompt?.askedAt || !!settings.peerPushPrompt?.clickedThroughAt;
    if (secondDay && didWork && !peerPushSettled) {
      cardShownFor = currentUserId ?? "anonymous";
      setAsk("peerpush");
      void IpcClient.getInstance().recordPeerPushPrompt("shown");
    }
  }, [settings, user?.id, ask, dismissed]);

  if (!ask || dismissed) return null;

  const close = () => {
    setDismissed(true);
    setAsk(null);
  };

  const dismissPeerPush = () => {
    void IpcClient.getInstance().recordPeerPushPrompt("dismissed");
    close();
  };

  return (
    <div className="fixed bottom-4 right-4 z-[9998] w-[22rem] rounded-xl border border-border bg-card p-4 shadow-lg animate-in slide-in-from-bottom-5">
      <button
        type="button"
        onClick={ask === "peerpush" ? dismissPeerPush : close}
        aria-label="Dismiss"
        className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      {ask === "acquisition" ? (
        <>
          <h3 className="text-sm font-medium text-foreground mb-1 pr-6">
            Where did you hear about Atlarix?
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            One tap, asked once. It genuinely helps us know where to show up.
          </p>
          <AcquisitionSourceQuestion
            compact
            onAnswered={() => {
              void refreshSettings?.();
              close();
            }}
          />
        </>
      ) : (
        <>
          <h3 className="text-sm font-medium text-foreground mb-1 pr-6">
            Enjoying Atlarix?
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            A PeerPush review is the single most useful thing you can do to help other developers
            find it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="gap-2"
              onClick={() => {
                void IpcClient.getInstance().recordPeerPushPrompt("clicked");
                void IpcClient.getInstance().openExternalUrl(PEERPUSH_REVIEW_URL);
                close();
              }}
            >
              <Star className="h-4 w-4" aria-hidden />
              Review on PeerPush
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => {
                void IpcClient.getInstance().openExternalUrl(DISCORD_INVITE_URL);
                close();
              }}
            >
              <MessageCircle className="h-4 w-4" aria-hidden />
              Discord
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
