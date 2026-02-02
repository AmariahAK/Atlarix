import { useEffect, useState } from "react";
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
import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AutoFixProblemsSwitch } from "@/components/AutoFixProblemsSwitch";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { AutoProviderOrderList } from "@/components/settings/AutoProviderOrderList";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSetAtom } from "jotai";
import { activeSettingsSectionAtom } from "@/atoms/viewAtoms";
import { useNavigate } from "@tanstack/react-router";
import { Server, ChevronRight } from "lucide-react";

export default function SettingsPage() {
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const appVersion = useAppVersion();
  const { settings, updateSettings } = useSettings();
  const router = useRouter();
  const setActiveSettingsSection = useSetAtom(activeSettingsSectionAtom);

  useEffect(() => {
    setActiveSettingsSection("general");
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
  return (
    <div
      id="general"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        General Settings
      </h2>
      <div className="flex items-center text-sm text-muted-foreground">
        <span className="mr-2 font-medium">App Version:</span>
        <span className="bg-muted px-2 py-0.5 rounded text-foreground font-mono">
          {appVersion ? appVersion : "-"}
        </span>
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

      <p className="text-xs text-muted-foreground mt-2">
        Token budget caps are configured per provider in each provider&apos;s
        settings.
      </p>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-2">
          Auto provider order
        </h3>
        <AutoProviderOrderList
          order={settings?.autoProviderOrder ?? []}
          onOrderChange={(order) => updateSettings({ autoProviderOrder: order })}
          allProviderIds={providers?.map((p: { id: string }) => p.id) ?? []}
        />
      </div>

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
