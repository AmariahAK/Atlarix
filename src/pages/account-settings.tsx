/**
 * Account Settings Page
 * =======================
 * User profile, subscription, and team management
 */

import { useAuth } from '@/lib/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useCallback } from 'react';
import { showError, showSuccess } from '@/lib/toast';
import { triggerUpgrade, triggerUpgradeWorkforce } from '@/hooks/useUpgrade';
import { Users, LogOut } from 'lucide-react';

interface TeamInfo {
  id: string;
  name: string;
  owner_user_id: string;
  seat_limit: number;
  extra_seats: number;
}

interface TeamMemberRow {
  id: string;
  email: string;
  status: string;
  role: string;
  user_id: string | null;
}

function getInvoke(): ((channel: string, ...args: unknown[]) => Promise<unknown>) | null {
  const electron = (window as unknown as { electron?: { ipcRenderer?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } } }).electron;
  return electron?.ipcRenderer?.invoke ?? null;
}

export function AccountSettings() {
  const { user, status, loading, signOut, refreshStatus } = useAuth();
  const navigate = useNavigate();
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const isOwner = user && team && team.owner_user_id === user.id;

  const loadTeam = useCallback(async () => {
    const invoke = getInvoke();
    if (!invoke || !user) return;
    try {
      const res = (await invoke('team:get')) as { team: TeamInfo | null; error?: string };
      if (res.team) {
        setTeam(res.team);
        const listRes = (await invoke('team:list-members', res.team.id)) as { members: TeamMemberRow[] };
        setMembers(listRes.members ?? []);
      } else {
        setTeam(null);
        setMembers([]);
      }
    } catch {
      setTeam(null);
      setMembers([]);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      navigate({ to: '/sign-in' });
    } else {
      refreshStatus?.();
      if (status?.plan === 'workforce') loadTeam();
    }
  }, [user, navigate, refreshStatus, status?.plan, loadTeam]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full border-4 border-border border-t-primary animate-spin" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user || !status) {
    return null;
  }

  const handleManageSubscription = async () => {
    try {
      await getInvoke()?.('auth:manage-subscription');
    } catch {
      showError('Could not open subscription management.');
    }
  };

  const handleInvite = async () => {
    if (!team || !inviteEmail.trim()) return;
    setInviting(true);
    try {
      const res = (await getInvoke()?.('team:invite', team.id, inviteEmail.trim())) as { success?: boolean; error?: string };
      if (res?.success) {
        showSuccess('Invite sent.');
        setInviteEmail('');
        await loadTeam();
      } else {
        showError(res?.error ?? 'Failed to send invite');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to send invite');
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!team || !window.confirm('Remove this member from the team?')) return;
    setRemoving(memberId);
    try {
      const res = (await getInvoke()?.('team:remove-member', team.id, memberId)) as { success?: boolean; error?: string };
      if (res?.success) {
        showSuccess('Member removed.');
        await loadTeam();
      } else {
        showError(res?.error ?? 'Failed to remove member');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to remove member');
    } finally {
      setRemoving(null);
    }
  };

  const handleLeaveTeam = async () => {
    if (!window.confirm('Leave this team? You will lose access to team features until you are re-invited.')) return;
    setLeaving(true);
    try {
      const res = (await getInvoke()?.('team:leave')) as { success?: boolean; error?: string };
      if (res?.success) {
        showSuccess('You left the team.');
        await loadTeam();
        refreshStatus?.();
      } else {
        showError(res?.error ?? 'Failed to leave team');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Failed to leave team');
    } finally {
      setLeaving(false);
    }
  };

  const handleAddSeats = async () => {
    const res = (await getInvoke()?.('team:add-seats')) as { success?: boolean; error?: string };
    if (res?.error) showError(res.error);
    else if (res?.success) showSuccess('Opened billing.');
  };

  const activeCount = members.filter((m) => m.status === 'active').length;
  const totalSeats = team ? team.seat_limit + (team.extra_seats ?? 0) : 0;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Account Settings</h1>
            <p className="text-muted-foreground mt-1">
              Manage your profile, subscription, and team
            </p>
          </div>
          <Button onClick={() => navigate({ to: '/' })} variant="outline">
            Back to Home
          </Button>
        </div>

        {/* Profile Card */}
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Your Atlarix account information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.name}
                  className="w-20 h-20 rounded-full border-2 border-primary"
                />
              ) : (
                <div className="w-20 h-20 rounded-full border-2 border-primary bg-primary/10 flex items-center justify-center text-2xl font-bold">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="text-xl font-semibold">{user.name}</h3>
                <p className="text-muted-foreground">{user.email}</p>
                <Badge variant="secondary" className="mt-2">
                  {user.provider === 'google' ? 'Google' : 'GitHub'}
                </Badge>
              </div>
            </div>
            <div className="pt-4 border-t flex justify-end">
              <Button onClick={signOut} variant="outline" size="sm" className="gap-2">
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Subscription Card */}
        <Card>
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            <CardDescription>Your current plan and billing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h4 className="font-semibold">Current Plan</h4>
                <p className="text-2xl font-bold text-primary capitalize">{status.plan}</p>
              </div>
              {status.subscriptionStatus && (
                <Badge
                  variant={status.subscriptionStatus === 'active' ? 'default' : 'secondary'}
                  className="text-sm capitalize"
                >
                  {status.subscriptionStatus}
                </Badge>
              )}
            </div>
            {(status.plan === 'pro' || status.plan === 'workforce') && status.subscriptionEndsAt && (
              <p className="text-sm text-muted-foreground">
                Next payment: {new Date(status.subscriptionEndsAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            )}
            {status.subscriptionStatus === 'cancelled' && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Your subscription is cancelled. You keep access until the end of the current period.
              </p>
            )}
            {status.plan === 'free' && (
              <div className="pt-4 border-t flex flex-wrap gap-2">
                <Button onClick={() => triggerUpgrade()} size="sm">
                  Upgrade to Pro
                </Button>
                <Button onClick={() => triggerUpgradeWorkforce()} variant="outline" size="sm">
                  Upgrade to Workforce
                </Button>
              </div>
            )}
            {(status.plan === 'pro' || status.plan === 'workforce') && (
              <div className="pt-4 border-t">
                <Button onClick={handleManageSubscription} variant="outline" size="sm">
                  Manage subscription
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Team Card — Workforce */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Team
            </CardTitle>
            <CardDescription>
              {status.plan === 'workforce'
                ? 'Invite members and manage your team (Workforce)'
                : 'Upgrade to Workforce to create a team and invite members'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status.plan !== 'workforce' ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-sm text-muted-foreground mb-3">
                  Teams, seats, and invites are available on Atlarix Workforce.
                </p>
                <Button size="sm" onClick={() => triggerUpgradeWorkforce()}>
                  Upgrade to Workforce
                </Button>
              </div>
            ) : team ? (
              <>
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="font-medium">{team.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {activeCount} of {totalSeats || '—'} seats used
                  </p>
                </div>
                {isOwner && (
                  <>
                    <div className="flex gap-2 flex-wrap">
                      <input
                        type="email"
                        placeholder="Email to invite"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        className="flex-1 min-w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                      <Button size="sm" onClick={handleInvite} disabled={inviting || !inviteEmail.trim()}>
                        {inviting ? 'Sending…' : 'Invite'}
                      </Button>
                    </div>
                    {totalSeats > 0 && activeCount >= totalSeats && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        All seats are in use. Add more seats to invite additional members.
                      </p>
                    )}
                    <Button variant="outline" size="sm" onClick={handleAddSeats}>
                      Add seats (via billing)
                    </Button>
                  </>
                )}
                <div className="border-t pt-4 space-y-2">
                  <h4 className="text-sm font-medium">Members</h4>
                  <ul className="space-y-2">
                    {members.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between gap-2 py-2 px-3 rounded-lg border border-border bg-muted/20"
                      >
                        <div>
                          <span className="font-medium">{m.email}</span>
                          <span className="text-xs text-muted-foreground ml-2 capitalize">{m.status}</span>
                          {m.role && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              {m.role}
                            </Badge>
                          )}
                        </div>
                        {isOwner && m.user_id !== user.id && m.status === 'active' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleRemoveMember(m.id)}
                            disabled={removing === m.id}
                          >
                            {removing === m.id ? 'Removing…' : 'Remove'}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
                {!isOwner && (
                  <div className="pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/30 hover:bg-destructive/10"
                      onClick={handleLeaveTeam}
                      disabled={leaving}
                    >
                      {leaving ? 'Leaving…' : 'Leave team'}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                You are not in a team yet. Accept an invite from a team owner or upgrade to Workforce to create your own team.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="text-center text-xs text-muted-foreground">
          <p>
            Need help? Visit{' '}
            <a href="https://atlarix.dev/support" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              atlarix.dev/support
            </a>
          </p>
          <p className="mt-2">© 2024-2025 NorahLabs. All Rights Reserved.</p>
        </div>
      </div>
    </div>
  );
}
