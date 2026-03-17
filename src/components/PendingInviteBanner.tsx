/**
 * Banner shown when the signed-in user has pending team invites.
 * Renders at top of main content; Accept / Reject per invite.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mail } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";

interface PendingInvite {
  memberId: string;
  teamId: string;
  teamName: string;
  inviterEmail: string | null;
}

function getInvoke(): ((channel: string, ...args: unknown[]) => Promise<unknown>) | null {
  const electron = (window as unknown as { electron?: { ipcRenderer?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } } }).electron;
  return electron?.ipcRenderer?.invoke ?? null;
}

export function PendingInviteBanner() {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const fetchInvites = async () => {
    const invoke = getInvoke();
    if (!invoke) {
      setLoading(false);
      return;
    }
    try {
      const auth = (await invoke("auth:get-current-user")) as { user?: { email?: string } } | undefined;
      if (!auth?.user?.email) {
        setInvites([]);
        setLoading(false);
        return;
      }
      const result = (await invoke("team:get-pending-invites")) as { invites?: PendingInvite[]; error?: string };
      setInvites(result.invites ?? []);
    } catch {
      setInvites([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInvites();
  }, []);

  const handleAccept = async (memberId: string) => {
    const invoke = getInvoke();
    if (!invoke) return;
    setActing(memberId);
    try {
      const result = (await invoke("team:accept-invite", memberId)) as { success?: boolean; error?: string };
      if (result.success) {
        showSuccess("You've joined the team.");
        await fetchInvites();
      } else {
        showError(result.error ?? "Failed to accept invite");
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to accept invite");
    } finally {
      setActing(null);
    }
  };

  const handleReject = async (memberId: string) => {
    const invoke = getInvoke();
    if (!invoke) return;
    setActing(memberId);
    try {
      const result = (await invoke("team:reject-invite", memberId)) as { success?: boolean; error?: string };
      if (result.success) {
        showSuccess("Invite declined.");
        await fetchInvites();
      } else {
        showError(result.error ?? "Failed to decline invite");
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to decline invite");
    } finally {
      setActing(null);
    }
  };

  if (loading || invites.length === 0) {
    return null;
  }

  const inviterLabel = (inv: PendingInvite) =>
    inv.inviterEmail ? inv.inviterEmail.split("@")[0] : "A team owner";

  return (
    <div className="flex flex-col gap-2 px-4 py-3 border-b border-primary/30 bg-primary/5 text-foreground text-sm">
      {invites.map((inv) => (
        <div
          key={inv.memberId}
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Mail className="h-4 w-4 shrink-0 text-primary" />
            <span>
              You&apos;ve been invited to <strong>{inv.teamName}</strong> by{" "}
              <strong>{inviterLabel(inv)}</strong>.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="default"
              size="sm"
              onClick={() => handleAccept(inv.memberId)}
              disabled={acting === inv.memberId}
            >
              {acting === inv.memberId ? "Accepting…" : "Accept"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleReject(inv.memberId)}
              disabled={acting === inv.memberId}
            >
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
