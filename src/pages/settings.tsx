import { useEffect, useState } from "react";
import { useTheme } from "../contexts/ThemeContext";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
import { AutoApproveSwitch } from "@/components/AutoApproveSwitch";
import { ProviderSettingsGrid } from "@/components/ProviderSettings";
import { MaxChatTurnsSelector } from "@/components/MaxChatTurnsSelector";
import { ThinkingBudgetSelector } from "@/components/ThinkingBudgetSelector";
import { useSettings } from "@/hooks/useSettings";
import { useAppVersion } from "@/hooks/useAppVersion";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AutoFixProblemsSwitch } from "@/components/AutoFixProblemsSwitch";
import { AutoUpdateSwitch } from "@/components/AutoUpdateSwitch";
import { ReleaseChannelSelector } from "@/components/ReleaseChannelSelector";
import { RuntimeModeSelector } from "@/components/RuntimeModeSelector";
import { NodePathSelector } from "@/components/NodePathSelector";
import { ZoomSelector } from "@/components/ZoomSelector";
import { SearchSettings } from "@/components/settings/SearchSettings";
import { useSetAtom } from "jotai";
import { activeSettingsSectionAtom } from "@/atoms/viewAtoms";

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
                    This will delete all your apps, chats, and settings. This
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
          message="Are you sure you want to reset everything? This will delete all your apps, chats, and settings. This action cannot be undone."
          confirmText="Reset Everything"
          cancelText="Cancel"
          onConfirm={handleResetEverything}
          onCancel={() => setIsResetDialogOpen(false)}
        />
      </div>
    </div>
  );
}

export function GeneralSettings({ appVersion }: { appVersion: string | null }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      id="general"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        General Settings
      </h2>

      <div className="space-y-4 mb-4">
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-muted-foreground">
            Theme
          </label>

          <div className="relative bg-muted rounded-lg p-1 flex">
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setTheme(option)}
                className={`
                px-4 py-1.5 text-sm font-medium rounded-md
                transition-all duration-200
                ${theme === option
                    ? "bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm"
                    : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                  }
`}
              >
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <ZoomSelector />
      </div>

      <div className="space-y-1 mt-4">
        <AutoUpdateSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically update the app when new versions are
          available.
        </div>
      </div>

      <div className="mt-4">
        <ReleaseChannelSelector />
      </div>

      <div className="mt-4">
        <RuntimeModeSelector />
      </div>
      <div className="mt-4">
        <NodePathSelector />
      </div>

      <div className="flex items-center text-sm text-muted-foreground mt-4">
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

      <div className="space-y-1">
        <AutoApproveSwitch showToast={false} />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically approve code changes and run them.
        </div>
      </div>

      <div className="space-y-1 mt-4">
        <AutoFixProblemsSwitch />
        <div className="text-sm text-gray-500 dark:text-gray-400">
          This will automatically fix TypeScript errors.
        </div>
      </div>
    </div>
  );
}
export function AISettings() {
  return (
    <div
      id="ai"
      className="bg-card rounded-xl shadow-sm p-6 border border-border"
    >
      <h2 className="text-lg font-medium text-foreground mb-4">
        AI Settings
      </h2>

      <div className="mt-4">
        <ThinkingBudgetSelector />
      </div>

      <div className="mt-4">
        <MaxChatTurnsSelector />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
          Model Providers
        </h3>
        <p className="text-xs text-muted-foreground mb-4">
          Configure API keys for OpenRouter and other model providers
        </p>
        <ProviderSettingsGrid />
      </div>
    </div>
  );
}
