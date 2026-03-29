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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BlueprintInjectionModePreference } from "@/lib/schemas";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AutoFixProblemsSwitch } from "@/components/AutoFixProblemsSwitch";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSetAtom, useAtomValue } from "jotai";
import { activeSettingsSectionAtom, onboardingStepAtom } from "@/atoms/viewAtoms";
import { useNavigate } from "@tanstack/react-router";
import { Server, ChevronRight } from "lucide-react";
import { useAuth } from "@/lib/auth/useAuth";
import { triggerUpgradeWorkforce } from "@/hooks/useUpgrade";

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

  // Onboarding step 3: scroll to AI section when we land on settings
  useEffect(() => {
    if (onboardingStep !== 3) return;
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
          {onboardingStep === 3 && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground space-y-3">
              <p>
                Compass is already on. To use other cloud or local models, add your own API keys under{" "}
                <strong>AI Settings</strong> below.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      const ipc = window.electron?.ipcRenderer;
                      if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", true);
                    } catch {
                      // ignore
                    }
                    setOnboardingStep(null);
                    navigate({ to: "/" });
                  }}
                >
                  Done
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
      localStorage.removeItem("atlarix.onboarding_skipped");
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

      <div className="mt-6 space-y-3 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">
          Blueprint context (Diagram tab)
        </h3>
        <p className="text-xs text-muted-foreground max-w-2xl">
          Controls how much Blueprint detail is injected into the AI system prompt.
          Auto uses chat mode (Ask/Build) and message heuristics; other values force
          that tier.
        </p>
        <div className="space-y-2 max-w-md">
          <Label htmlFor="blueprint-injection-mode">Injection tier</Label>
          <Select
            value={settings?.blueprintInjectionModePreference ?? "auto"}
            onValueChange={(v) =>
              updateSettings({
                blueprintInjectionModePreference:
                  v as BlueprintInjectionModePreference,
              })
            }
          >
            <SelectTrigger
              id="blueprint-injection-mode"
              className="w-full max-w-sm"
            >
              <SelectValue placeholder="Auto" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="ask">Ask</SelectItem>
              <SelectItem value="plan">Plan</SelectItem>
              <SelectItem value="build">Build</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-3 max-w-xl">
          <div className="space-y-1">
            <Label htmlFor="blueprint-debug-trace">
              Debug tier — stack trace / error (optional)
            </Label>
            <Textarea
              id="blueprint-debug-trace"
              value={settings?.blueprintDebugTrace ?? ""}
              onChange={(e) =>
                updateSettings({ blueprintDebugTrace: e.target.value })
              }
              placeholder="Paste error output or stack trace"
              className="min-h-24 font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="blueprint-debug-file">
              Debug tier — primary file path (optional)
            </Label>
            <Input
              id="blueprint-debug-file"
              value={settings?.blueprintDebugFile ?? ""}
              onChange={(e) =>
                updateSettings({ blueprintDebugFile: e.target.value })
              }
              placeholder="e.g. src/components/App.tsx"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            These fields apply only when the effective Blueprint injection tier is
            Debug (forced Debug above, or Auto when your message matches debug
            heuristics). If empty, the model uses your chat message.
          </p>
        </div>
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
          Compass is built in (no API key). Add keys for other providers as needed.
          Models are fetched from models.dev (refreshed hourly).
        </p>
        <ProviderSettingsGrid />
      </div>
    </div>
  );
}
