import { useCallback, useEffect, useState } from "react";
import posthog from "posthog-js";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
import { MaxChatTurnsSelector } from "@/components/MaxChatTurnsSelector";
// Hidden: ThinkingBudgetSelector, ReleaseChannelSelector, RuntimeModeSelector, NodePathSelector
import { useSettings } from "@/hooks/useSettings";
import { useAppVersion } from "@/hooks/useAppVersion";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsWorkspaceNav } from "@/components/settings/SettingsWorkspaceNav";
import { useTheme } from "@/contexts/ThemeContext";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { UpdateDiagnostics } from "@/components/settings/UpdateDiagnostics";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { WorkspaceTerminalPermissions } from "@/components/settings/WorkspaceTerminalPermissions";
import { WorkspaceFilePermissions } from "@/components/settings/WorkspaceFilePermissions";
import { GitHubIntegration } from "@/components/GitHubIntegration";
import { useSetAtom, getDefaultStore } from "jotai";
import {
  activeSettingsSectionAtom,
  pendingSettingsScrollAtom,
} from "@/atoms/viewAtoms";
import { useNavigate } from "@tanstack/react-router";
import { Server, ChevronRight, Sparkles } from "lucide-react";
import { useAuth } from "@/lib/auth/useAuth";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { ProviderSettingsGrid } from "@/components/ProviderSettings";


export default function SettingsPage() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const appVersion = useAppVersion();
  const { settings, updateSettings } = useSettings();
  const setActiveSettingsSection = useSetAtom(activeSettingsSectionAtom);

  useEffect(() => {
    // Honor a one-shot deep-link target (e.g. ChatErrorBox → "ai", MCP prompts →
    // "mcp"): consume it and scroll the section into view. Otherwise default to
    // the top (general). Without this, the deep-link atom set just before
    // navigation was clobbered here and nothing scrolled.
    const pending = getDefaultStore().get(pendingSettingsScrollAtom);
    if (pending) {
      getDefaultStore().set(pendingSettingsScrollAtom, null); // one-shot consume
      setActiveSettingsSection(pending);
      posthog.capture("settings_opened", { section: pending });
      // Sections are rendered at mount, but content above (provider grids) can
      // load async and shift layout — poll briefly until the element exists,
      // scroll, then do one settle pass.
      let tries = 0;
      let settled = false;
      const tryScroll = () => {
        const el = document.getElementById(pending);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          if (!settled) {
            settled = true;
            window.setTimeout(() => {
              document
                .getElementById(pending)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 250);
          }
          return;
        }
        if (tries++ < 8) window.setTimeout(tryScroll, 120);
      };
      requestAnimationFrame(tryScroll);
    } else {
      setActiveSettingsSection("general");
      posthog.capture("settings_opened", { section: "general" });
    }
  }, [setActiveSettingsSection]);

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
        <SettingsWorkspaceNav className="mb-4" />
        <div className="flex justify-between mb-4">
          <h1 className="text-3xl font-bold text-foreground">
            Settings
          </h1>
        </div>

        <div className="space-y-6">
          <GeneralSettings appVersion={appVersion} />
          <WorkflowSettings />
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

          {/* Skills - clickable card like MCP */}
          <div id="skills" className="bg-card rounded-xl shadow-sm p-6 border border-border">
            <SkillsCard />
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
                When enabled, every commit made through Atlarix will include a Co-authored-by trailer for atlarix-agent.
              </p>
            </div>
              <GitHubIntegration />
              <p className="text-xs text-muted-foreground">
                GitHub sign-in is saved on this Mac until you disconnect. Use disconnect to connect a different GitHub account.
              </p>
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
            MCP servers for the current workspace (10 max). Use @mcp name in chat.
          </p>
        </div>
      </div>
      <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-foreground" />
    </button>
  );
}

function SkillsCard() {
  const navigate = useNavigate();
  const { status, loading } = useAuth();
  const plan = status?.plan ?? "free";
  const isPaid = plan === "pro";
  return (
    <button
      type="button"
      onClick={() => {
        if (loading) return;
        if (!isPaid) {
          void triggerUpgrade();
          return;
        }
        navigate({ to: "/settings/skills" });
      }}
      className="w-full text-left flex items-center justify-between p-4 rounded-lg border border-border bg-card/50 hover:bg-card hover:shadow-md transition-all cursor-pointer group"
    >
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-medium text-foreground">Skills</h2>
          <p className="text-sm text-muted-foreground">
            {isPaid
              ? "Browse the registry and install skills for the current workspace (10 max)."
              : "Upgrade to Pro to unlock Skills."}
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
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  // v10: restart re-opens the first-run wizard (legacy overlay removed).
  const handleRestartOnboarding = async () => {
    try {
      localStorage.removeItem("atlarix.onboarding_skipped");
      localStorage.removeItem("atlarix_onboarding_done");
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", false);
    } catch {
      // ignore
    }
    await updateSettings({ firstRunWizardCompleted: false });
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
        <div className="flex items-center justify-between gap-4 pt-4 border-t border-border mt-4">
          <div className="space-y-0.5">
            <label className="text-sm font-medium text-foreground">
              Appearance
            </label>
            <p className="text-xs text-muted-foreground">
              Choose light, dark, or follow your system setting.
            </p>
          </div>
          <Select
            value={theme}
            onValueChange={(v) => setTheme(v as "system" | "light" | "dark")}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <CliLauncherSettings />
        <UpdateDiagnostics />
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

function CliLauncherSettings() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [cliPath, setCliPath] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await IpcClient.getInstance().checkCliInstalled();
      setInstalled(status.installed);
      setCliPath(status.path);
    } catch {
      setInstalled(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = async () => {
    setBusy(true);
    try {
      const result = await IpcClient.getInstance().installCli();
      if (result.success) {
        showSuccess(
          result.message ?? "Installed — open a new terminal and try `atlarix .`",
        );
      } else if (result.cancelled) {
        /* user dismissed admin prompt */
      } else if (result.sudoCommand) {
        await navigator.clipboard.writeText(result.sudoCommand);
        showError("Administrator access required — install command copied to clipboard");
      } else {
        showError(result.error ?? "Could not install the atlarix command");
      }
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      const result = await IpcClient.getInstance().uninstallCli();
      if (result.success) {
        showSuccess(result.message ?? "Removed atlarix from PATH");
      } else if (result.cancelled) {
        /* user dismissed admin prompt */
      } else if (result.sudoCommand) {
        await navigator.clipboard.writeText(result.sudoCommand);
        showError(
          "Administrator access required — remove command copied to clipboard",
        );
      } else {
        showError(result.error ?? "Could not uninstall");
      }
      await refresh();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-4 border-t border-border mt-4 space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium text-foreground">Shell command</p>
        <p className="text-xs text-muted-foreground">
          Install <code className="text-[11px]">atlarix</code> in PATH, then run{" "}
          <code className="text-[11px]">atlarix .</code> in any project folder — opens that workspace
          if registered, or adds it automatically.
        </p>
        {cliPath ? (
          <p className="text-[11px] text-muted-foreground font-mono truncate">{cliPath}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {installed ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleUninstall()}>
            Uninstall from PATH
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void handleInstall()}>
            Install atlarix in PATH
          </Button>
        )}
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

      <p className="text-sm text-muted-foreground mb-6">
        File and command approvals are reviewed inline in chat. Terminal command categories can be
        managed per workspace below when a workspace is selected.
      </p>

      <WorkspaceTerminalPermissions />
      <WorkspaceFilePermissions />
    </div>
  );
}

function HooksSettings() {
  return (
    <div className="mt-6 space-y-8 border-t border-border pt-6">
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">Hooks</h3>
        <p className="text-xs text-muted-foreground max-w-2xl">
          Hooks are configured per workspace in{" "}
          <code className="text-[11px]">.atlarix/hooks/hooks.json</code> — blocking{" "}
          <code className="text-[11px]">pre_tool_use</code>, advisory{" "}
          <code className="text-[11px]">post_tool_use</code>, and a{" "}
          <code className="text-[11px]">stop</code> gate on task completion, all enforced
          at the tool-execution funnel. The file is committable, so hooks travel with
          the repo. See the workspace contract docs for the format.
        </p>
      </div>
    </div>
  );
}

export function AISettings() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { settings, updateSettings } = useSettings();
  useLanguageModelProviders();

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

      {/* v13.1: the "Auto-fix from LSP" switch was removed with the LSP feature —
          verification is the project's own checks/tests via run_command. */}

      {/* Pass 7: Blueprint context tier selector removed with the Blueprint subsystem. */}

      <div className="mt-6 space-y-4 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Build and automation</h3>
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="build-verify-enabled" className="text-sm">
            Build verification after autonomous task complete
          </Label>
          <Switch
            id="build-verify-enabled"
            checked={settings?.buildVerification?.enabled !== false}
            onCheckedChange={(checked) =>
              updateSettings({
                buildVerification: { ...settings?.buildVerification, enabled: checked },
              })
            }
          />
        </div>
      </div>

      <div className="mt-6 space-y-4 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-foreground">Notifications</h3>
        <div className="flex items-center justify-between max-w-md gap-4">
          <Label htmlFor="notif-sound-enabled" className="text-sm">
            Play a sound when Atlarix needs you (approval / questions)
          </Label>
          <Switch
            id="notif-sound-enabled"
            checked={settings?.notificationSound?.enabled !== false}
            onCheckedChange={(checked) =>
              updateSettings({
                notificationSound: {
                  ...settings?.notificationSound,
                  enabled: checked,
                },
              })
            }
          />
        </div>
        {settings?.notificationSound?.enabled !== false && (
          <div className="flex items-center justify-between max-w-md gap-4">
            <Label htmlFor="notif-sound-volume" className="text-sm">
              Volume
            </Label>
            <input
              id="notif-sound-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings?.notificationSound?.volume ?? 0.7}
              onChange={(e) =>
                updateSettings({
                  notificationSound: {
                    ...settings?.notificationSound,
                    volume: Number(e.target.value),
                  },
                })
              }
              className="w-40 accent-primary"
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground max-w-md">
          When the app is in the background, an OS notification is shown too
          (respects your system Do Not Disturb).
        </p>
      </div>

      <HooksSettings />

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
