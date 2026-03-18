import { useEffect, useState } from "react";
import posthog from "posthog-js";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
import { AutoApproveSwitch } from "@/components/AutoApproveSwitch";
import { ProviderSettingsGrid } from "@/components/ProviderSettings";
import { MaxChatTurnsSelector } from "@/components/MaxChatTurnsSelector";
// Hidden: ThinkingBudgetSelector, ReleaseChannelSelector, RuntimeModeSelector, NodePathSelector
import { useSettings } from "@/hooks/useSettings";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AutoFixProblemsSwitch } from "@/components/AutoFixProblemsSwitch";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSetAtom, useAtomValue } from "jotai";
import { activeSettingsSectionAtom, onboardingStepAtom } from "@/atoms/viewAtoms";
import { useNavigate } from "@tanstack/react-router";
import { Server, ChevronRight, GitBranch } from "lucide-react";
import { DbExtensionsSettings } from "@/components/settings/DbExtensionsSettings";
import { useAuth } from "@/lib/auth/useAuth";
import { triggerUpgrade, triggerUpgradeWorkforce } from "@/hooks/useUpgrade";

const ONBOARDING_SKIPPED_AI_KEY = "atlarix.onboarding_skipped_ai_setup";

export default function SettingsPage() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const appVersion = useAppVersion();
  const { settings, updateSettings } = useSettings();
  const router = useRouter();
  const navigate = useNavigate();
  const setActiveSettingsSection = useSetAtom(activeSettingsSectionAtom);
  const onboardingStep = useAtomValue(onboardingStepAtom);
  const setOnboardingStep = useSetAtom(onboardingStepAtom);
  const { status, isAuthenticated } = useAuth();

  useEffect(() => {
    setActiveSettingsSection("general");
    posthog.capture("settings_opened", { section: "general" });
  }, [setActiveSettingsSection]);

  // Onboarding step 5: scroll to AI section when we land on settings
  useEffect(() => {
    if (onboardingStep !== 5) return;
    const el = document.getElementById("ai");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [onboardingStep]);

  const handleResetEverything = async () => {
    setIsResetting(true);
    try {
      const ipcClient = IpcClient.getInstance();
      await ipcClient.resetAll();
      showSuccess("Successfully reset everything. Restart the application.");
    } catch (error) {
      console.error("Error resetting:", error);
      showError(
        error instanceof Error ? error.message : "An unknown error occurred",
      );
    } finally {
      setIsResetting(false);
      setIsResetDialogOpen(false);
    }
  };

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-5xl mx-auto px-8 py-4 pb-20">
        <Button
          onClick={() => router.history.back()}
          variant="outline"
          size="sm"
          className="flex items-center gap-2 mb-4 bg-(--background-lightest) py-5"
        >
          <ArrowLeft className="h-4 w-4" />
          Go Back
        </Button>
        <div className="flex justify-between mb-4">
          <h1 className="text-3xl font-bold text-foreground">
            Settings
          </h1>
        </div>

        <div className="space-y-6">
          <GeneralSettings appVersion={appVersion} />
          <WorkflowSettings />
          {onboardingStep === 5 && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground space-y-3">
              <p>Add your API key to start chatting. Atlarix works with OpenAI, Anthropic, Gemini, Ollama and more.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    setOnboardingStep(6);
                    navigate({ to: "/" });
                  }}
                >
                  Done, start building
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      localStorage.setItem(ONBOARDING_SKIPPED_AI_KEY, "1");
                      const ipc = window.electron?.ipcRenderer;
                      if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", true);
                    } catch {
                      // ignore
                    }
                    setOnboardingStep(null);
                    navigate({ to: "/" });
                  }}
                >
                  Remind me later
                </Button>
              </div>
            </div>
          )}
          <AISettings />

          {/* Search Settings */}
          <div
            id="search"
            className="bg-card rounded-xl shadow-sm p-6 border border-border"
          >
            <h2 className="text-lg font-medium text-foreground mb-4">
              Search Settings
            </h2>
            <SearchSettings />
          </div>

          {/* MCP Servers - clickable card like AI providers */}
          <div id="mcp" className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <McpServersCard />
          </div>

          {/* Workspace — DB Connections & extensions gated: log in first, then Pro */}
          <div id="extensions" className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <h2 className="text-lg font-medium text-foreground mb-4">Workspace</h2>
            {status?.plan === "pro" ? (
              <>
                <p className="text-xs text-muted-foreground mb-4">
                  Workspace extensions give the AI real-time access to external services. Add database connections so the model can read your schema and query data.
                </p>
                <DbExtensionsSettings workspaceId={null} />
                <div className="mt-4 rounded-lg border border-border bg-muted/20 p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <GitBranch className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">GitHub Actions</p>
                      <p className="text-xs text-muted-foreground">View workflow runs and job logs in the left panel. Connect GitHub to enable.</p>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground shrink-0">
                    {settings?.githubAccessToken?.value ? "Connected" : "Connect GitHub"}
                  </span>
                </div>
              </>
            ) : !isAuthenticated ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Log in to use Workspace extensions and DB connections</p>
                <p className="mb-3">Sign in with Google or GitHub to access Workspace extensions and database connections.</p>
                <Button size="sm" onClick={() => navigate({ to: "/sign-in" })}>
                  Log in
                </Button>
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Upgrade to use Workspace extensions & DB</p>
                <p className="mb-3">DB Connections and other extensions are available on Pro. Upgrade to connect your database and let the AI read your schema and run approved queries.</p>
                <Button size="sm" onClick={() => triggerUpgrade()}>
                  Upgrade
                </Button>
              </div>
            )}
          </div>

          {/* Team — only unlocked on Workforce */}
          <div id="team" className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <h2 className="text-lg font-medium text-foreground mb-4">Team</h2>
            {status?.plan === "workforce" ? (
              <>
                <p className="text-xs text-muted-foreground mb-4">
                  Manage your team, invite members, and handle seats. Team features are available on Atlarix Workforce.
                </p>
                <Button variant="outline" size="sm" onClick={() => navigate({ to: "/account" })}>
                  Manage team in Account
                </Button>
              </>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground mb-1">Unlock with Workforce</p>
                <p className="mb-3">Teams, seats, and invites are available on Atlarix Workforce. Upgrade to add your team.</p>
                <Button size="sm" onClick={() => triggerUpgradeWorkforce()}>
                  Upgrade to Workforce
                </Button>
              </div>
            )}
          </div>

          {/* Integrations */}
          <div id="integrations" className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <h2 className="text-lg font-medium text-foreground mb-4">
              Integrations
            </h2>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  id="include-atlarix-co-author"
                  type="checkbox"
                  checked={settings?.includeAtlarixCoAuthor !== false}
                  onChange={(e) => updateSettings({ includeAtlarixCoAuthor: e.target.checked })}
                  className="rounded border-border"
                />
                <label htmlFor="include-atlarix-co-author" className="text-sm text-foreground">
                  Include Atlarix as co-author in commits
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, every commit made through Atlarix will include a Co-authored-by trailer for Atlarix AI Agent.
              </p>
            </div>
          </div>

          {/* Danger Zone */}
          <div
            id="danger-zone"
            className="bg-card rounded-xl shadow-sm p-6 border border-destructive/30"
          >
            <h2 className="text-lg font-medium text-red-600 dark:text-red-400 mb-4">
              Danger Zone
            </h2>

            <div className="space-y-4">
              <div className="flex items-start justify-between flex-col sm:flex-row sm:items-center gap-4">
                <div>
                  <h3 className="text-sm font-medium text-gray-900 dark:text-white">
                    Reset Everything
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    This will delete all your workspaces, diagrams, prompts, and settings. This
                    action cannot be undone.
                  </p>
                </div>
                <button
                  onClick={() => setIsResetDialogOpen(true)}
                  disabled={isResetting}
                  className="rounded-md border border-transparent bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isResetting ? "Resetting..." : "Reset Everything"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <ConfirmationDialog
          isOpen={isResetDialogOpen}
          title="Reset Everything"
          message="Are you sure you want to reset everything? This will delete all your workspaces, diagrams, prompts and settings. This action cannot be undone."
          confirmText="Reset Everything"
          cancelText="Cancel"
          onConfirm={handleResetEverything}
          onCancel={() => setIsResetDialogOpen(false)}
        />
      </div>
    </div>
  );
}

function McpServersCard() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/settings/mcp" })}
      className="w-full text-left flex items-center justify-between p-4 rounded-lg border border-border bg-card/50 hover:bg-card hover:shadow-md transition-all cursor-pointer group"
    >
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-primary/10 text-primary">
          <Server className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-medium text-foreground">MCP Servers</h2>
          <p className="text-sm text-muted-foreground">
            Add and categorize MCP servers. Use @mcp name in chat. Global (5 max) and per-workspace (5 max).
          </p>
        </div>
      </div>
      <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

export function GeneralSettings({ appVersion }: { appVersion: string | null }) {
  const { settings, updateSettings } = useSettings();
  const analyticsOptedIn = settings?.telemetryConsent === "opted_in";
  const setOnboardingStep = useSetAtom(onboardingStepAtom);
  const navigate = useNavigate();

  const handleRestartOnboarding = async () => {
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", false);
    } catch {
      // ignore
    }
    setOnboardingStep(2);
    navigate({ to: "/" });
  };

  return (
    <div
      id="general"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
      data-onboarding="general-settings"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        General Settings
      </h2>
      <div className="flex items-center text-sm text-muted-foreground mb-6">
        <span className="mr-2 font-medium">App Version:</span>
        <span className="bg-muted px-2 py-0.5 rounded text-foreground font-mono">
          {appVersion ? appVersion : "-"}
        </span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <label
              htmlFor="help-improve-atlarix"
              className="text-sm font-medium text-foreground"
            >
              Help improve Atlarix
            </label>
            <p className="text-xs text-muted-foreground">
              Share anonymous usage data (no code, no prompts, no personal info)
              to help us understand which features matter most.
            </p>
          </div>
          <Switch
            id="help-improve-atlarix"
            checked={analyticsOptedIn}
            onCheckedChange={(checked) => {
              updateSettings({
                telemetryConsent: checked ? "opted_in" : "opted_out",
              });
            }}
          />
        </div>
        <div className="pt-4 border-t border-border mt-4">
          <Button variant="outline" size="sm" onClick={handleRestartOnboarding}>
            Restart onboarding guide
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            Show the welcome guide again (Code to Canvas, Blueprint, Ask vs Build, API key).
          </p>
        </div>
      </div>
    </div>
  );
}

export function WorkflowSettings() {
  return (
    <div
      id="workflow"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        Workflow Settings
      </h2>

      <div className="space-y-1 opacity-50">
        <div className="flex items-center gap-2 pointer-events-none">
          <AutoApproveSwitch showToast={false} />
          <span className="text-xs bg-muted px-2 py-0.5 rounded">Coming Soon</span>
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically approve code changes and run them.
        </div>
      </div>

      <div className="space-y-1 mt-4 opacity-50">
        <div className="flex items-center gap-2 pointer-events-none">
          <AutoFixProblemsSwitch />
          <span className="text-xs bg-muted px-2 py-0.5 rounded">Coming Soon</span>
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically fix TypeScript errors.
        </div>
      </div>
    </div>
  );
}
export function AISettings() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { settings, updateSettings } = useSettings();
  const { data: providers } = useLanguageModelProviders();

  const handleRefreshModels = async () => {
    setIsRefreshing(true);
    try {
      const result = await IpcClient.getInstance().refreshModelsDev();
      if (result.success) {
        await queryClient.invalidateQueries({
          queryKey: ["language-models-by-providers"],
        });
        showSuccess("Model list refreshed");
      } else {
        showError("Failed to refresh model list");
      }
    } catch {
      showError("Failed to refresh model list");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div
      id="ai"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        AI Settings
      </h2>

      {/* Hidden for cleaner UI: ThinkingBudgetSelector */}

      <div className="mt-4">
        <MaxChatTurnsSelector />
      </div>

      {/* v3.6: Auto Routing options */}
      <div className="mt-4 space-y-3">
        <h3 className="text-sm font-medium text-foreground">Auto Routing</h3>
        <div className="flex items-center gap-2">
          <input
            id="auto-routing-show-reasoning"
            type="checkbox"
            checked={settings?.autoRoutingShowReasoning !== false}
            onChange={(e) =>
              updateSettings({ autoRoutingShowReasoning: e.target.checked })
            }
            className="rounded border-border"
          />
          <label
            htmlFor="auto-routing-show-reasoning"
            className="text-sm text-muted-foreground"
          >
            Show routing reasoning in Activity Stream
          </label>
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="auto-routing-exchange-threshold"
            className="text-sm text-muted-foreground whitespace-nowrap"
          >
            Exchange threshold for fallback:
          </label>
          <input
            id="auto-routing-exchange-threshold"
            type="number"
            min={3}
            max={20}
            value={settings?.autoRoutingExchangeThreshold ?? 6}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (!Number.isNaN(n) && n >= 3 && n <= 20) {
                updateSettings({ autoRoutingExchangeThreshold: n });
              }
            }}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-2">
        Token budget caps are configured per provider in each provider&apos;s
        settings.
      </p>

      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-900 dark:text-white">
            Model Providers
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshModels}
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh model list"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Configure API keys for OpenRouter and other model providers. Models
          are fetched from models.dev (refreshed hourly).
        </p>
        <ProviderSettingsGrid />
      </div>
    </div>
  );
}
