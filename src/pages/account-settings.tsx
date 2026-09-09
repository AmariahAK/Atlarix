/**
 * Account Settings Page
 * =======================
 * User profile, subscription, and team management
 */

import { useAuth } from "@/lib/auth/useAuth";
import { useState } from "react";
import { SignOutDialog } from "@/components/auth/SignOutDialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { showError, showSuccess } from "@/lib/toast";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { SettingsWorkspaceNav } from "@/components/settings/SettingsWorkspaceNav";
import { AtlarixCoreUsageCard } from "@/components/settings/AtlarixCoreUsageCard";
import { EditStatsCard } from "@/components/settings/EditStatsCard";
import { LogOut } from "lucide-react";

function getInvoke():
  | ((channel: string, ...args: unknown[]) => Promise<unknown>)
  | null {
  const electron = (
    window as unknown as {
      electron?: {
        ipcRenderer?: {
          invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        };
      };
    }
  ).electron;
  return electron?.ipcRenderer?.invoke ?? null;
}

export function AccountSettings() {
  const { user, status, loading, refreshStatus } = useAuth();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/sign-in" });
    } else {
      refreshStatus?.();
    }
  }, [loading, user, navigate, refreshStatus]);

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
      await getInvoke()?.("auth:manage-subscription");
    } catch {
      showError("Could not open subscription management.");
    }
  };

  const canCancelSubscription =
    status.subscriptionStatus === "active" ||
    status.subscriptionStatus === "on_trial";

  const handleCancelSubscription = async () => {
    const confirmed = window.confirm(
      "Cancel your subscription? You keep paid features until the end of the current billing period.",
    );
    if (!confirmed) return;
    const result = (await getInvoke()?.("auth:cancel-subscription")) as
      | { success?: boolean; message?: string; error?: string }
      | undefined;
    if (result?.success) {
      showSuccess(result.message ?? "Subscription updated.");
      await refreshStatus?.();
    } else {
      showError(result?.error ?? "Could not cancel subscription.");
    }
  };

  return (
    <div className="min-h-full bg-background p-8 pb-12">
      <div className="max-w-4xl mx-auto space-y-8">
        <SettingsWorkspaceNav />
        <div>
          <h1 className="text-3xl font-bold">Account Settings</h1>
          <p className="text-muted-foreground mt-1">
            Manage your profile, subscription, and team
          </p>
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
                  {user.provider === "google"
                    ? "Google"
                    : user.provider === "discord"
                      ? "Discord"
                      : "GitHub"}
                </Badge>
              </div>
            </div>
            <div className="pt-4 border-t flex justify-end">
              <Button
                onClick={() => setSignOutOpen(true)}
                variant="outline"
                size="sm"
                className="gap-2"
              >
                <LogOut className="h-4 w-4" />
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>

        <EditStatsCard />

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
                <p className="text-2xl font-bold text-primary">
                  {status.plan === "pro" ? "Atlarix Pro" : "Free"}
                </p>
              </div>
              {status.subscriptionStatus && (
                <Badge
                  variant={
                    status.subscriptionStatus === "active" ||
                    status.subscriptionStatus === "on_trial"
                      ? "default"
                      : "secondary"
                  }
                  className="text-sm capitalize"
                >
                  {status.subscriptionStatus.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
            <AtlarixCoreUsageCard showIntro className="mt-2" />
            {status.plan === "pro" &&
              status.subscriptionEndsAt &&
              (() => {
                const end = new Date(status.subscriptionEndsAt);
                const periodEndFuture = !Number.isNaN(+end) && end > new Date();
                return (
                  <>
                    {(status.subscriptionStatus === "active" ||
                      status.subscriptionStatus === "on_trial" ||
                      (!status.subscriptionStatus && periodEndFuture)) && (
                      <p className="text-sm text-muted-foreground">
                        Next payment:{" "}
                        {new Date(status.subscriptionEndsAt).toLocaleDateString(
                          undefined,
                          {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          },
                        )}
                      </p>
                    )}
                    {status.subscriptionStatus === "cancelled" &&
                      periodEndFuture && (
                        <>
                          <p className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">
                              Pro access until:{" "}
                            </span>
                            {new Date(
                              status.subscriptionEndsAt,
                            ).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "long",
                              day: "numeric",
                            })}
                          </p>
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            Subscription cancelled — you keep paid features
                            until that date. Use Subscribe again or Manage
                            billing to resume or update payment.
                          </p>
                        </>
                      )}
                    {status.subscriptionStatus === "cancelled" &&
                      !periodEndFuture && (
                        <p className="text-sm text-muted-foreground">
                          Your paid period has ended. Subscribe again to restore
                          Pro.
                        </p>
                      )}
                    {status.subscriptionStatus &&
                      !["active", "on_trial", "cancelled"].includes(
                        status.subscriptionStatus,
                      ) && (
                        <p className="text-sm text-muted-foreground">
                          Billing period:{" "}
                          {new Date(
                            status.subscriptionEndsAt,
                          ).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                      )}
                  </>
                );
              })()}
            {status.plan === "free" && (
              <div className="pt-4 border-t flex flex-wrap gap-2">
                <Button
                  onClick={() => triggerUpgrade()}
                  size="sm"
                  variant="default"
                >
                  Upgrade to Pro
                </Button>
              </div>
            )}
            {status.plan === "pro" && (
              <div className="pt-4 border-t space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={handleManageSubscription}
                    variant="outline"
                    size="sm"
                  >
                    Manage subscription
                  </Button>
                  {canCancelSubscription && (
                    <Button
                      onClick={handleCancelSubscription}
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                    >
                      Cancel subscription
                    </Button>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="text-center text-xs text-muted-foreground">
          <p>
            Need help? Visit{" "}
            <a
              href="https://atlarix.dev/support"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              atlarix.dev/support
            </a>
          </p>
          <p className="mt-2">© 2025-2026 NorahLabs. All Rights Reserved.</p>
        </div>
      </div>
      <SignOutDialog open={signOutOpen} onOpenChange={setSignOutOpen} />
    </div>
  );
}
