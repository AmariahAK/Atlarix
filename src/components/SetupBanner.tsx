import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  GiftIcon,
  Sparkles,
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  Settings,
  Folder,
} from "lucide-react";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";

import SetupProviderCard from "@/components/SetupProviderCard";

import { useState, useCallback } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { useNodejsStatus } from "@/hooks/useNodejsStatus";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePostHog } from "posthog-js/react";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useScrollAndNavigateTo } from "@/hooks/useScrollAndNavigateTo";
// Use the app icon logo (green/white)
const atlarixLogo = new URL('/logo.png', import.meta.url).href;
import { OnboardingBanner } from "./home/OnboardingBanner";
import { showError } from "@/lib/toast";
import { useSettings } from "@/hooks/useSettings";
import { useAuth } from "@/lib/auth/useAuth";

type NodeInstallStep =
  | "install"
  | "waiting-for-continue"
  | "continue-processing"
  | "finished-checking";

export function SetupBanner() {
  const posthog = usePostHog();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isOnboardingVisible, setIsOnboardingVisible] = useState(true);
  const { isAnyProviderSetup, isLoading: loading } =
    useLanguageModelProviders();
  const {
    data: nodeSystemInfo = null,
    isError: nodeCheckError,
    refetch: refetchNodeStatus,
  } = useNodejsStatus();
  const [nodeInstallStep, setNodeInstallStep] =
    useState<NodeInstallStep>("install");
  const [showManualConfig, setShowManualConfig] = useState(false);
  const [isSelectingPath, setIsSelectingPath] = useState(false);
  const { updateSettings } = useSettings();

  // Add handler for manual path selection
  const handleManualNodeConfig = useCallback(async () => {
    setIsSelectingPath(true);
    try {
      const result = await IpcClient.getInstance().selectNodeFolder();
      if (result.path) {
        await updateSettings({ customNodePath: result.path });
        await IpcClient.getInstance().reloadEnvPath();
        await refetchNodeStatus();
        setNodeInstallStep("finished-checking");
        setShowManualConfig(false);
      } else if (result.path === null && result.canceled === false) {
        showError(
          `Could not find Node.js at the path "${result.selectedPath}"`,
        );
      }
    } catch (error) {
      showError("Error setting Node.js path:" + error);
    } finally {
      setIsSelectingPath(false);
    }
  }, [refetchNodeStatus]);

  const settingsScrollAndNavigateTo = useScrollAndNavigateTo("/settings", {
    behavior: "smooth",
    block: "start",
  });

  const handleGoogleSetupClick = () => {
    posthog.capture("setup-flow:ai-provider-setup:google:click");
    navigate({
      to: providerSettingsRoute.id,
      params: { provider: "google" },
    });
  };

  const handleOpenRouterSetupClick = () => {
    posthog.capture("setup-flow:ai-provider-setup:openrouter:click");
    navigate({
      to: providerSettingsRoute.id,
      params: { provider: "openrouter" },
    });
  };
  const handleAtlarixProSetupClick = async () => {
    posthog.capture("setup-flow:ai-provider-setup:atlarix-pro:click");

    try {
      const ipcRenderer = window.electron?.ipcRenderer;
      if (!ipcRenderer?.invoke) {
        showError("Unable to access upgrade. Please restart the app.");
        return;
      }

      const result = await ipcRenderer.invoke("auth:upgrade") as { success?: boolean; error?: string };

      if (!result.success && result.error) {
        // User needs to sign in first
        showError(result.error);
      }
    } catch (error) {
      showError("Failed to open upgrade page. Please try again.");
    }
  };

  const handleOtherProvidersClick = () => {
    posthog.capture("setup-flow:ai-provider-setup:other:click");
    settingsScrollAndNavigateTo("provider-settings");
  };

  const handleNodeInstallClick = useCallback(async () => {
    posthog.capture("setup-flow:start-node-install-click");
    setNodeInstallStep("waiting-for-continue");
    IpcClient.getInstance().openExternalUrl(nodeSystemInfo!.nodeDownloadUrl);
  }, [nodeSystemInfo, setNodeInstallStep]);

  const finishNodeInstall = useCallback(async () => {
    posthog.capture("setup-flow:continue-node-install-click");
    setNodeInstallStep("continue-processing");
    await IpcClient.getInstance().reloadEnvPath();
    await refetchNodeStatus();
    setNodeInstallStep("finished-checking");
  }, [refetchNodeStatus, setNodeInstallStep]);

  // We only check for node version because pnpm is not required for the app to run.
  const isNodeSetupComplete = Boolean(nodeSystemInfo?.nodeVersion);

  const itemsNeedAction: string[] = [];
  // Language detection is now lazy - only check when trying to run
  // So we don't block the banner with node-setup anymore
  if (!isAnyProviderSetup() && !loading) {
    itemsNeedAction.push("ai-setup");
  }

  if (itemsNeedAction.length === 0) {
    const displayName = user?.name?.trim();
    return (
      <div className="text-center mb-8">
        <h1 className="text-5xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[#10B981] via-[#059669] to-[#F59E0B] tracking-tight">
          {displayName ? `Hello, ${displayName}.` : "Hello."}
        </h1>
        <p className="mt-3 text-lg text-muted-foreground">
          {displayName
            ? "Welcome back. What's on your mind?"
            : "What's on your mind?"}
        </p>
      </div>
    );
  }

  const bannerClasses = cn(
    "w-full mb-6 border rounded-xl shadow-sm overflow-hidden",
    "border-zinc-200 dark:border-zinc-700",
  );

  const getStatusIcon = (isComplete: boolean, hasError: boolean = false) => {
    if (hasError) {
      return <XCircle className="w-5 h-5 text-red-500" />;
    }
    return isComplete ? (
      <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-500" />
    ) : (
      <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-500" />
    );
  };

  return (
    <>
      <p className="text-xl font-medium text-zinc-700 dark:text-zinc-300 p-4">
        Setup Atlarix
      </p>
      <OnboardingBanner
        isVisible={isOnboardingVisible}
        setIsVisible={setIsOnboardingVisible}
      />
      <div className={bannerClasses}>
        <Accordion
          type="multiple"
          className="w-full"
          defaultValue={itemsNeedAction}
        >
          {/* Informational Tips - Not requirements, just helpful info */}
          <div className="p-4 space-y-3">
            {/* Project Languages Tip */}
            <div className="p-3 bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-700 rounded-lg">
              <p className="text-sm text-teal-700 dark:text-teal-400">
                🔧 <strong>Project Languages:</strong> Atlarix auto-detects your project's language (Node.js, Python, Go, Rust, etc.)
                and will prompt you to install any missing runtimes when you try to run your app.
              </p>
            </div>

            {/* Docker Tip for Web Search */}
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg">
              <p className="text-sm text-blue-700 dark:text-blue-400">
                🐳 <strong>Tip:</strong> Web search is free but limited, however with{" "}
                <a
                  onClick={() => {
                    IpcClient.getInstance().openExternalUrl("https://www.docker.com/get-started/");
                  }}
                  className="underline cursor-pointer hover:text-blue-600 dark:hover:text-blue-300"
                >
                  Docker installed
                </a>
                , searches become <strong>unlimited & more private</strong> using local SearxNG.
              </p>
            </div>
          </div>

          <AccordionItem
            value="ai-setup"
            className={cn(
              isAnyProviderSetup()
                ? "bg-green-50 dark:bg-green-900/30"
                : "bg-yellow-50 dark:bg-yellow-900/30",
            )}
          >
            <AccordionTrigger
              className={cn(
                "px-4 py-3 transition-colors w-full hover:no-underline",
              )}
            >
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-3">
                  {getStatusIcon(isAnyProviderSetup())}
                  <span className="font-medium text-sm">
                    Setup AI Access
                  </span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 pt-2 pb-4 bg-white dark:bg-zinc-900 border-t border-inherit">
              <p className="text-[15px] mb-2">
                Atlarix supports multiple AI providers: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Together AI, Mistral, xAI, plus Ollama and LM Studio for local models. OpenRouter is a good first choice for 100+ models with a single API key.
              </p>
              <p className="text-[13px] text-muted-foreground mb-3">
                You can configure <strong>MCP servers</strong> in Settings (or &quot;Manage MCP tools&quot; in the chat config dropdown) and use them in chat with <code className="text-xs bg-muted px-1 rounded">@mcp name</code>.
              </p>
              <SetupProviderCard
                className="w-full"
                variant="openrouter"
                onClick={handleOpenRouterSetupClick}
                tabIndex={0}
                leadingIcon={
                  <Sparkles className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                }
                title="Setup OpenRouter API Key"
                subtitle="Access 100+ models including GPT-4, Claude, Deepseek, Qwen & more"
                chip={<>Free</>}
              />

              <SetupProviderCard
                className="mt-2"
                variant="atlarix"
                onClick={handleAtlarixProSetupClick}
                tabIndex={0}
                leadingIcon={
                  <img
                    src={atlarixLogo}
                    alt="Atlarix Logo"
                    className="w-6 h-6 mr-0.5 opacity-95 contrast-125 dark:opacity-100 dark:contrast-100"
                  />
                }
                title="Setup Atlarix Pro"
                subtitle="Access all AI models with one plan"
                chip={<>Recommended</>}
              />

              {/* OpenRouter Credits Info */}
              <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg">
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  💡 <strong>Note:</strong> Paid OpenRouter models require credits in your OpenRouter account.
                  Free models (like Deepseek, Qwen, Gemma, Mistral, etc) work immediately.
                </p>
              </div>

              {/* TODO: Enable when other providers are fully configured in settings
              <div
                className="mt-2 p-3 bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800/70 transition-colors"
                onClick={handleOtherProvidersClick}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="bg-gray-100 dark:bg-gray-700 p-1.5 rounded-full">
                      <Settings className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </div>
                    <div>
                      <h4 className="font-medium text-[15px] text-gray-800 dark:text-gray-300">
                        Setup other AI providers
                      </h4>
                      <p className="text-xs text-gray-600 dark:text-gray-400">
                        OpenAI, Anthropic and more
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </div>
              </div>
              */}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div >
    </>
  );
}

function NodeJsHelpCallout() {
  return (
    <div className="mt-3 p-3 bg-(--background-lighter) border rounded-lg text-sm">
      <p>
        If you run into issues, read our{" "}
        <a
          onClick={() => {
            IpcClient.getInstance().openExternalUrl(
              "https://www.atlarix.dev/docs/help/nodejs",
            );
          }}
          className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
        >
          Node.js troubleshooting guide
        </a>
        .{" "}
      </p>
      <p className="mt-2">
        Still stuck? Click the <b>Help</b> button in the bottom-left corner and
        then <b>Report a Bug</b>.
      </p>
    </div>
  );
}

function NodeInstallButton({
  nodeInstallStep,
  handleNodeInstallClick,
  finishNodeInstall,
}: {
  nodeInstallStep: NodeInstallStep;
  handleNodeInstallClick: () => void;
  finishNodeInstall: () => void;
}) {
  switch (nodeInstallStep) {
    case "install":
      return (
        <Button className="mt-3" onClick={handleNodeInstallClick}>
          Install Node.js Runtime
        </Button>
      );
    case "continue-processing":
      return (
        <Button className="mt-3" onClick={finishNodeInstall} disabled>
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking Node.js setup...
          </div>
        </Button>
      );
    case "waiting-for-continue":
      return (
        <Button className="mt-3" onClick={finishNodeInstall}>
          <div className="flex items-center gap-2">
            Continue | I installed Node.js
          </div>
        </Button>
      );
    case "finished-checking":
      return (
        <div className="mt-3 text-sm text-red-600 dark:text-red-400">
          Node.js not detected. Closing and re-opening Atlarix usually fixes this.
        </div>
      );
    default:
      const _exhaustiveCheck: never = nodeInstallStep;
  }
}

export const OpenRouterSetupBanner = ({
  className,
}: {
  className?: string;
}) => {
  const posthog = usePostHog();
  const navigate = useNavigate();
  return (
    <SetupProviderCard
      className={cn("mt-2", className)}
      variant="openrouter"
      onClick={() => {
        posthog.capture("setup-flow:ai-provider-setup:openrouter:click");
        navigate({
          to: providerSettingsRoute.id,
          params: { provider: "openrouter" },
        });
      }}
      tabIndex={0}
      leadingIcon={
        <Sparkles className="w-4 h-4 text-purple-600 dark:text-purple-400" />
      }
      title="Setup OpenRouter API Key"
      chip={
        <>
          <GiftIcon className="w-3 h-3" />
          Free models available
        </>
      }
    />
  );
};
