/**
 * Settings → Community. Both asks live here PERMANENTLY, independent of whether
 * their one-time prompt ever fired — a prompt someone dismissed (or that is
 * still dormant, see CommunityPrompts) must remain reachable on purpose.
 */
import { MessageCircle, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { useSettings } from "@/hooks/useSettings";
import { useAuth } from "@/lib/auth/useAuth";
import { DISCORD_INVITE_URL } from "@/lib/community/discord";
import { PEERPUSH_REVIEW_URL } from "@/lib/community/acquisition";
import { AcquisitionSourceQuestion } from "./AcquisitionSourceQuestion";

export function CommunitySettingsSection() {
  const { settings, refreshSettings } = useSettings();
  const { user } = useAuth();
  // Per ACCOUNT, not per install: a stored answer only counts as *this* user's.
  // Otherwise the second person to sign in on a shared machine would be shown
  // someone else's answer and never get to give their own.
  const stored = settings?.acquisitionSource ?? null;
  const answered = stored && stored.userId === (user?.id ?? null) ? stored : null;

  const openPeerPush = () => {
    void IpcClient.getInstance().recordPeerPushPrompt("clicked");
    void IpcClient.getInstance().openExternalUrl(PEERPUSH_REVIEW_URL);
  };

  return (
    <div id="community" className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <h2 className="text-lg font-medium text-foreground mb-4">Community</h2>

      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => void IpcClient.getInstance().openExternalUrl(DISCORD_INVITE_URL)}
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            Join the Discord
          </Button>
          <Button variant="outline" className="gap-2" onClick={openPeerPush}>
            <Star className="h-4 w-4" aria-hidden />
            Review Atlarix on PeerPush
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Questions, bugs and early builds get discussed in the Discord. A PeerPush review is the
          single most useful thing you can do to help other developers find Atlarix.
        </p>

        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-medium text-foreground mb-1">
            Where did you hear about Atlarix?
          </h3>
          <p className="text-xs text-muted-foreground mb-3">
            Asked once. It's the one thing analytics can't tell us — a download carries no trace of
            the person or post that sent you here.
          </p>
          <AcquisitionSourceQuestion
            answeredSource={answered}
            onAnswered={() => void refreshSettings?.()}
          />
        </div>
      </div>
    </div>
  );
}
