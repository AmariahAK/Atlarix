import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { homeChatInputValueAtom } from "../atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { generateCuteAppName } from "@/lib/utils";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSettings } from "@/hooks/useSettings";
import { SetupBanner } from "@/components/SetupBanner";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { useState, useEffect, useCallback } from "react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { HomeChatInput } from "@/components/chat/HomeChatInput";
import { usePostHog } from "posthog-js/react";
import { PrivacyBanner } from "@/components/TelemetryBanner";
import { useAppVersion } from "@/hooks/useAppVersion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw } from "lucide-react";
import { ImportAppButton } from "@/components/ImportAppButton";
import { TemplateGalleryButton } from "@/components/TemplateGalleryButton";
import { showError } from "@/lib/toast";
import { invalidateAppQuery } from "@/hooks/useLoadApp";
import { useQueryClient } from "@tanstack/react-query";
import { ForceCloseDialog } from "@/components/ForceCloseDialog";

import type { FileAttachment } from "@/ipc/ipc_types";
import { NEON_TEMPLATE_IDS, Template } from "@/shared/templates";
import { neonTemplateHook } from "@/client_logic/template_hook";
import { ProBanner } from "@/components/ProBanner";

// Adding an export for attachments
export interface HomeSubmitOptions {
  attachments?: FileAttachment[];
}

export default function HomePage() {
  const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
  const navigate = useNavigate();
  const search = useSearch({ from: "/" });
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const { refreshApps } = useLoadApps();
  const { settings, updateSettings } = useSettings();
  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const [isLoading, setIsLoading] = useState(false);
  const [forceCloseDialogOpen, setForceCloseDialogOpen] = useState(false);
  const [performanceData, setPerformanceData] = useState<any>(undefined);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const posthog = usePostHog();
  const appVersion = useAppVersion();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseUrl, setReleaseUrl] = useState("");
  const { theme } = useTheme();
  const queryClient = useQueryClient();

  // Template state - fetch from API instead of hardcoded prompts
  const [allTemplates, setAllTemplates] = useState<Template[]>([]);
  const [displayedTemplates, setDisplayedTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  // Fetch templates from API
  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        setTemplatesLoading(true);
        const templates = await IpcClient.getInstance().listTemplates();
        setAllTemplates(templates);
        // Show first 3 templates
        setDisplayedTemplates(templates.slice(0, 3));
      } catch (error) {
        console.error("Failed to fetch templates:", error);
        setAllTemplates([]);
        setDisplayedTemplates([]);
      } finally {
        setTemplatesLoading(false);
      }
    };
    fetchTemplates();
  }, []);

  // Function to get random templates
  const getRandomTemplates = useCallback(() => {
    if (allTemplates.length === 0) return [];
    const shuffled = [...allTemplates].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, 3);
  }, [allTemplates]);

  // Rotate to new random templates
  const handleMoreIdeas = () => {
    setDisplayedTemplates(getRandomTemplates());
  };

  // Listen for force-close events
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onForceCloseDetected((data) => {
      setPerformanceData(data.performanceData);
      setForceCloseDialogOpen(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const updateLastVersionLaunched = async () => {
      if (
        appVersion &&
        settings &&
        settings.lastShownReleaseNotesVersion !== appVersion
      ) {
        const shouldShowReleaseNotes = !!settings.lastShownReleaseNotesVersion;
        await updateSettings({
          lastShownReleaseNotesVersion: appVersion,
        });
        // It feels spammy to show release notes if it's
        // the users very first time.
        if (!shouldShowReleaseNotes) {
          return;
        }

        try {
          const result = await IpcClient.getInstance().doesReleaseNoteExist({
            version: appVersion,
          });

          if (result.exists && result.url) {
            setReleaseUrl(result.url + "?hideHeader=true&theme=" + theme);
            setReleaseNotesOpen(true);
          }
        } catch (err) {
          console.warn(
            "Unable to check if release note exists for: " + appVersion,
            err,
          );
        }
      }
    };
    updateLastVersionLaunched();
  }, [appVersion, settings, updateSettings, theme]);

  // Get the appId from search params
  const appId = search.appId ? Number(search.appId) : null;

  // Redirect to app details page if appId is present
  useEffect(() => {
    if (appId) {
      navigate({ to: "/app-details", search: { appId } });
    }
  }, [appId, navigate]);

  const handleSubmit = async (options?: HomeSubmitOptions) => {
    const attachments = options?.attachments || [];

    if (!inputValue.trim() && attachments.length === 0) return;

    try {
      setIsLoading(true);
      // Create the chat and navigate
      const result = await IpcClient.getInstance().createApp({
        name: generateCuteAppName(),
      });
      if (
        settings?.selectedTemplateId &&
        NEON_TEMPLATE_IDS.has(settings.selectedTemplateId)
      ) {
        await neonTemplateHook({
          appId: result.app.id,
          appName: result.app.name,
        });
      }

      // Stream the message with attachments
      streamMessage({
        prompt: inputValue,
        chatId: result.chatId,
        attachments,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, settings?.isTestMode ? 0 : 2000),
      );

      setInputValue("");
      setSelectedAppId(result.app.id);
      setIsPreviewOpen(false);
      await refreshApps(); // Ensure refreshApps is awaited if it's async
      await invalidateAppQuery(queryClient, { appId: result.app.id });
      posthog.capture("home:chat-submit");
      navigate({ to: "/chat", search: { id: result.chatId } });
    } catch (error) {
      console.error("Failed to create chat:", error);
      showError("Failed to create app. " + (error as any).toString());
      setIsLoading(false); // Ensure loading state is reset on error
    }
    // No finally block needed for setIsLoading(false) here if navigation happens on success
  };

  // Loading overlay for app creation
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center max-w-3xl m-auto p-8">
        <div className="w-full flex flex-col items-center">
          {/* Loading Spinner */}
          <div className="relative w-24 h-24 mb-8">
            <div className="absolute top-0 left-0 w-full h-full border-8 border-gray-200 dark:border-gray-700 rounded-full"></div>
            <div className="absolute top-0 left-0 w-full h-full border-8 border-t-primary rounded-full animate-spin"></div>
          </div>
          <h2 className="text-2xl font-bold mb-2 text-gray-800 dark:text-gray-200">
            Building your app
          </h2>
          <p className="text-gray-600 dark:text-gray-400 text-center max-w-md mb-8">
            We're setting up your app with AI magic. <br />
            This might take a moment...
          </p>
        </div>
      </div>
    );
  }

  // Main Home Page Content
  return (
    <div className="flex flex-col items-center justify-center max-w-3xl w-full m-auto p-8">
      <ForceCloseDialog
        isOpen={forceCloseDialogOpen}
        onClose={() => setForceCloseDialogOpen(false)}
        performanceData={performanceData}
      />
      <SetupBanner />

      <div className="w-full">
        <ImportAppButton />
        <HomeChatInput onSubmit={handleSubmit} />

        <div className="flex flex-col gap-4 mt-2">
          {/* Template cards - dynamic from API with preview images */}
          <div className="flex flex-wrap gap-4 justify-center">
            {templatesLoading ? (
              <div className="text-sm text-muted-foreground">Loading templates...</div>
            ) : displayedTemplates.length > 0 ? (
              displayedTemplates.map((template, index) => (
                <button
                  type="button"
                  key={template.id || index}
                  onClick={() => setInputValue(`Build me a ${template.title}`)}
                  className="flex flex-col items-start gap-2 rounded-xl border border-gray-200
                             bg-white/50 backdrop-blur-sm overflow-hidden
                             transition-all duration-200
                             hover:bg-white hover:shadow-lg hover:border-gray-300 hover:scale-[1.02]
                             active:scale-[0.98]
                             dark:bg-gray-800/50 dark:border-gray-700
                             dark:hover:bg-gray-800 dark:hover:border-gray-600
                             w-[220px]"
                >
                  {/* Preview Image */}
                  <div className="w-full h-[140px] bg-gray-100 dark:bg-gray-900 overflow-hidden">
                    <img
                      src={template.imageUrl}
                      alt={template.title}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.src = "https://via.placeholder.com/220x140?text=Template";
                      }}
                    />
                  </div>

                  {/* Content */}
                  <div className="px-3 pb-3 w-full">
                    <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1">
                      {template.title}
                    </h3>
                    <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-2 mb-2">
                      {template.description || 'No description'}
                    </p>
                    {template.techStack && template.techStack.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {template.techStack.slice(0, 2).map((tech) => (
                          <span
                            key={tech}
                            className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary"
                          >
                            {tech}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))
            ) : (
              <div className="text-sm text-muted-foreground">No templates available</div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 justify-center flex-wrap">
            <button
              type="button"
              onClick={handleMoreIdeas}
              disabled={templatesLoading || allTemplates.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200
                         bg-white/50 backdrop-blur-sm
                         transition-all duration-200
                         hover:bg-white hover:shadow-md hover:border-gray-300
                         active:scale-[0.98]
                         dark:bg-gray-800/50 dark:border-gray-700
                         dark:hover:bg-gray-800 dark:hover:border-gray-600
                         disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-5 h-5 text-gray-700 dark:text-gray-300" />
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                More ideas
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                console.log("Search Templates clicked!");
                // TODO: Open template browser
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200
                         bg-white/50 backdrop-blur-sm
                         transition-all duration-200
                         hover:bg-white hover:shadow-md hover:border-gray-300
                         active:scale-[0.98]
                         dark:bg-gray-800/50 dark:border-gray-700
                         dark:hover:bg-gray-800 dark:hover:border-gray-600"
            >
              <svg className="w-5 h-5 text-gray-700 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Search Templates
              </span>
            </button>
          </div>
        </div>
        <ProBanner />
      </div>
      <PrivacyBanner />

      {/* Release Notes Dialog */}
      <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
        <DialogContent className="max-w-4xl bg-(--docs-bg) pr-0 pt-4 pl-4 gap-1">
          <DialogHeader>
            <DialogTitle>What's new in v{appVersion}?</DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-10 top-2 focus-visible:ring-0 focus-visible:ring-offset-0"
              onClick={() =>
                window.open(
                  releaseUrl.replace("?hideHeader=true&theme=" + theme, ""),
                  "_blank",
                )
              }
            >
              <ExternalLink className="w-4 h-4" />
            </Button>
          </DialogHeader>
          <div className="overflow-auto h-[70vh] flex flex-col ">
            {releaseUrl && (
              <div className="flex-1">
                <iframe
                  src={releaseUrl}
                  className="w-full h-full border-0 rounded-lg"
                  title={`Release notes for v${appVersion}`}
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
