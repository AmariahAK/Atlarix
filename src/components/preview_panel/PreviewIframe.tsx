import {
  selectedAppIdAtom,
  appUrlAtom,
  appOutputAtom,
  previewErrorMessageAtom,
} from "@/atoms/appAtoms";
import { browserErrorsAtom, dismissedErrorSignaturesAtom, getErrorSignature, type BrowserError } from "@/atoms/sourceAtoms";
import { useAtomValue, useSetAtom, useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  ExternalLink,
  Loader2,
  X,
  Sparkles,
  ChevronDown,
  Lightbulb,
  ChevronRight,
  MousePointerClick,
  Power,
  MonitorSmartphone,
  Monitor,
  Tablet,
  Smartphone,
  Pen,
} from "lucide-react";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { CopyErrorMessage } from "@/components/CopyErrorMessage";
import { IpcClient } from "@/ipc/ipc_client";

import { useParseRouter } from "@/hooks/useParseRouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStreamChat } from "@/hooks/useStreamChat";
import {
  selectedComponentsPreviewAtom,
  visualEditingSelectedComponentAtom,
  currentComponentCoordinatesAtom,
  previewIframeRefAtom,
  annotatorModeAtom,
  screenshotDataUrlAtom,
  pendingVisualChangesAtom,
} from "@/atoms/previewAtoms";
import { ComponentSelection } from "@/ipc/ipc_types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRunApp } from "@/hooks/useRunApp";
import { useShortcut } from "@/hooks/useShortcut";
import { cn } from "@/lib/utils";
import { normalizePath } from "../../../shared/normalizePath";
import { showError } from "@/lib/toast";
import { AnnotatorOnlyForPro } from "./AnnotatorOnlyForPro";
import { useAttachments } from "@/hooks/useAttachments";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import { Annotator } from "@/pro/ui/components/Annotator/Annotator";
import { VisualEditingToolbar } from "./VisualEditingToolbar";

interface ErrorBannerProps {
  error: { message: string; source: "preview-app" | "atlarix-app"; stack?: string } | undefined;
  onDismiss: () => void;
  onAIFix: (customNotes?: string) => void;
}

const ErrorBanner = ({ error, onDismiss, onAIFix }: ErrorBannerProps) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [devNotes, setDevNotes] = useState("");
  const { isStreaming } = useStreamChat();

  if (!error) return null;
  const isDockerError = error.message.includes("Cannot connect to the Docker");

  const getTruncatedError = () => {
    const firstLine = error.message.split("\n")[0];
    const snippetLength = 80;
    return firstLine.length > snippetLength
      ? firstLine.substring(0, snippetLength) + "..."
      : firstLine;
  };

  const handleQuickFix = () => {
    onAIFix();
  };

  const handleSendWithNotes = () => {
    onAIFix(devNotes.trim() || undefined);
    setIsEditing(false);
    setDevNotes("");
  };

  // ThinkingCard-style collapsed view
  if (!isEditing) {
    return (
      <div
        className="absolute top-2 left-2 right-2 z-10 bg-red-950/90 backdrop-blur-sm border border-red-800/50 rounded-lg shadow-lg overflow-hidden"
        data-testid="preview-error-banner"
      >
        {/* Header row - always visible */}
        <div className="px-3 py-2 flex items-center gap-2">
          {/* Error icon */}
          <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
            <X size={12} className="text-red-400" />
          </div>

          {/* Error summary */}
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="flex-1 text-left flex items-center gap-1 min-w-0"
          >
            <span className="text-sm font-medium text-red-300 truncate">
              {getTruncatedError()}
            </span>
            <ChevronDown
              size={14}
              className={`text-red-400 flex-shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-180'}`}
            />
          </button>

          {/* Action buttons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {!isDockerError && error.source === "preview-app" && (
              <>
                <button
                  onClick={() => setIsEditing(true)}
                  className="px-2 py-1 text-xs text-red-300 hover:bg-red-800/50 rounded transition-colors"
                  title="Add notes before sending"
                >
                  Edit
                </button>
                <button
                  disabled={isStreaming}
                  onClick={handleQuickFix}
                  className="px-2.5 py-1 bg-red-600 hover:bg-red-500 text-white text-xs rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Sparkles size={12} />
                  <span>Fix with AI</span>
                </button>
              </>
            )}
            <button
              onClick={onDismiss}
              className="p-1 text-red-400 hover:bg-red-800/50 rounded transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {!isCollapsed && (
          <div className="px-3 pb-3 border-t border-red-800/30">
            <pre className="mt-2 text-xs text-red-300/80 font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {error.message}
            </pre>
            {error.stack && (
              <pre className="mt-2 text-xs text-red-400/60 font-mono whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                {error.stack}
              </pre>
            )}

            {/* Tip for internal errors */}
            {error.source === "atlarix-app" && (
              <div className="mt-2 p-2 bg-red-900/30 rounded text-xs text-red-300 flex items-center gap-2">
                <Lightbulb size={14} className="flex-shrink-0" />
                <span>Try restarting the Atlarix app or your computer.</span>
              </div>
            )}

            {isDockerError && (
              <div className="mt-2 p-2 bg-red-900/30 rounded text-xs text-red-300 flex items-center gap-2">
                <Lightbulb size={14} className="flex-shrink-0" />
                <span>Make sure Docker Desktop is running and try restarting the app.</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Editing view with developer notes
  return (
    <div
      className="absolute top-2 left-2 right-2 z-10 bg-red-950/95 backdrop-blur-sm border border-red-800/50 rounded-lg shadow-lg overflow-hidden"
      data-testid="preview-error-banner-editing"
    >
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-red-800/30">
        <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
          <X size={12} className="text-red-400" />
        </div>
        <span className="text-sm font-medium text-red-300">Add Notes for AI</span>
        <div className="flex-1" />
        <button
          onClick={() => { setIsEditing(false); setDevNotes(""); }}
          className="p-1 text-red-400 hover:bg-red-800/50 rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Error preview */}
      <div className="px-3 py-2">
        <pre className="text-xs text-red-300/70 font-mono whitespace-pre-wrap break-words max-h-20 overflow-y-auto bg-red-900/20 rounded p-2">
          {error.message.split("\n").slice(0, 3).join("\n")}
          {error.message.split("\n").length > 3 && "\n..."}
        </pre>
      </div>

      {/* Developer notes textarea */}
      <div className="px-3 pb-2">
        <textarea
          value={devNotes}
          onChange={(e) => setDevNotes(e.target.value)}
          placeholder="Optional: Add context or specific instructions for the AI..."
          className="w-full h-16 p-2 text-sm bg-red-900/30 border border-red-800/30 rounded text-red-100 placeholder-red-400/50 resize-none focus:outline-none focus:border-red-600"
          autoFocus
        />
      </div>

      {/* Action buttons */}
      <div className="px-3 pb-3 flex justify-end gap-2">
        <button
          onClick={() => { setIsEditing(false); setDevNotes(""); }}
          className="px-3 py-1.5 text-xs text-red-300 hover:bg-red-800/50 rounded transition-colors"
        >
          Cancel
        </button>
        <button
          disabled={isStreaming}
          onClick={handleSendWithNotes}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Sparkles size={12} />
          <span>Send to AI</span>
        </button>
      </div>
    </div>
  );
};

// Preview iframe component
export const PreviewIframe = ({ loading }: { loading: boolean }) => {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { appUrl, originalUrl } = useAtomValue(appUrlAtom);
  const setAppOutput = useSetAtom(appOutputAtom);
  // State to trigger iframe reload
  const [reloadKey, setReloadKey] = useState(0);
  const [errorMessage, setErrorMessage] = useAtom(previewErrorMessageAtom);
  const setBrowserErrors = useSetAtom(browserErrorsAtom);
  const setDismissedSignatures = useSetAtom(dismissedErrorSignaturesAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const { streamMessage } = useStreamChat();
  const { routes: availableRoutes } = useParseRouter(selectedAppId);
  const { restartApp } = useRunApp();
  const { userBudget } = useUserBudgetInfo();
  const isProMode = !!userBudget;

  // Navigation state
  const [isComponentSelectorInitialized, setIsComponentSelectorInitialized] =
    useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [navigationHistory, setNavigationHistory] = useState<string[]>([]);
  const [currentHistoryPosition, setCurrentHistoryPosition] = useState(0);
  const setSelectedComponentsPreview = useSetAtom(
    selectedComponentsPreviewAtom,
  );
  const [visualEditingSelectedComponent, setVisualEditingSelectedComponent] =
    useAtom(visualEditingSelectedComponentAtom);
  const setCurrentComponentCoordinates = useSetAtom(
    currentComponentCoordinatesAtom,
  );
  const setPreviewIframeRef = useSetAtom(previewIframeRefAtom);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [annotatorMode, setAnnotatorMode] = useAtom(annotatorModeAtom);
  const [screenshotDataUrl, setScreenshotDataUrl] = useAtom(
    screenshotDataUrlAtom,
  );

  const { addAttachments } = useAttachments();
  const setPendingChanges = useSetAtom(pendingVisualChangesAtom);

  // AST Analysis State
  const [isDynamicComponent, setIsDynamicComponent] = useState(false);
  const [hasStaticText, setHasStaticText] = useState(false);

  // Device mode state
  type DeviceMode = "desktop" | "tablet" | "mobile";
  const [deviceMode, setDeviceMode] = useState<DeviceMode>("desktop");
  const [isDevicePopoverOpen, setIsDevicePopoverOpen] = useState(false);

  // Device configurations
  const deviceWidthConfig = {
    tablet: 768,
    mobile: 375,
  };

  //detect if the user is using Mac
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  const analyzeComponent = async (componentId: string) => {
    if (!componentId || !selectedAppId) return;

    try {
      const result = await IpcClient.getInstance().analyzeComponent({
        appId: selectedAppId,
        componentId,
      });
      setIsDynamicComponent(result.isDynamic);
      setHasStaticText(result.hasStaticText);

      // Automatically enable text editing if component has static text
      if (result.hasStaticText && iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          {
            type: "enable-atlarix-text-editing",
            data: {
              componentId: componentId,
              runtimeId: visualEditingSelectedComponent?.runtimeId,
            },
          },
          "*",
        );
      }
    } catch (err) {
      console.error("Failed to analyze component", err);
      setIsDynamicComponent(false);
      setHasStaticText(false);
    }
  };

  const handleTextUpdated = async (data: any) => {
    const { componentId, text } = data;
    if (!componentId || !selectedAppId) return;

    // Parse componentId to extract file path and line number
    const [filePath, lineStr] = componentId.split(":");
    const lineNumber = parseInt(lineStr, 10);

    if (!filePath || isNaN(lineNumber)) {
      console.error("Invalid componentId format:", componentId);
      return;
    }

    // Store text change in pending changes
    setPendingChanges((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(componentId);

      updated.set(componentId, {
        componentId: componentId,
        componentName:
          existing?.componentName || visualEditingSelectedComponent?.name || "",
        relativePath: filePath,
        lineNumber: lineNumber,
        styles: existing?.styles || {},
        textContent: text,
      });

      return updated;
    });
  };

  // Function to get current styles from selected element
  const getCurrentElementStyles = () => {
    if (!iframeRef.current?.contentWindow || !visualEditingSelectedComponent)
      return;

    try {
      // Send message to iframe to get current styles
      iframeRef.current.contentWindow.postMessage(
        {
          type: "get-atlarix-component-styles",
          data: {
            elementId: visualEditingSelectedComponent.id,
            runtimeId: visualEditingSelectedComponent.runtimeId,
          },
        },
        "*",
      );
    } catch (error) {
      console.error("Failed to get element styles:", error);
    }
  };
  useEffect(() => {
    setAnnotatorMode(false);
  }, []);
  // Reset visual editing state when app changes or component unmounts
  useEffect(() => {
    return () => {
      // Cleanup on unmount or when app changes
      setVisualEditingSelectedComponent(null);
      setPendingChanges(new Map());
      setCurrentComponentCoordinates(null);
    };
  }, [selectedAppId]);

  // Update iframe ref atom
  useEffect(() => {
    setPreviewIframeRef(iframeRef.current);
  }, [iframeRef.current, setPreviewIframeRef]);

  // Send pro mode status to iframe
  useEffect(() => {
    if (iframeRef.current?.contentWindow && isComponentSelectorInitialized) {
      iframeRef.current.contentWindow.postMessage(
        { type: "atlarix-pro-mode", enabled: isProMode },
        "*",
      );
    }
  }, [isProMode, isComponentSelectorInitialized]);

  // Add message listener for iframe errors and navigation events
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only handle messages from our iframe
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      if (event.data?.type === "atlarix-component-selector-initialized") {
        setIsComponentSelectorInitialized(true);
        iframeRef.current?.contentWindow?.postMessage(
          { type: "atlarix-pro-mode", enabled: isProMode },
          "*",
        );
        return;
      }

      if (event.data?.type === "atlarix-text-updated") {
        handleTextUpdated(event.data);
        return;
      }

      if (event.data?.type === "atlarix-text-finalized") {
        handleTextUpdated(event.data);
        return;
      }

      if (event.data?.type === "atlarix-component-selected") {
        console.log("Component picked:", event.data);

        const component = parseComponentSelection(event.data);

        if (!component) return;

        // Store the coordinates
        if (event.data.coordinates && isProMode) {
          setCurrentComponentCoordinates(event.data.coordinates);
        }

        // Add to selected components if not already there
        setSelectedComponentsPreview((prev) => {
          const exists = prev.some((c) => {
            // Check by runtimeId if available otherwise by id
            // Stored components may have lost their runtimeId after re-renders or reloading the page
            if (component.runtimeId && c.runtimeId) {
              return c.runtimeId === component.runtimeId;
            }
            return c.id === component.id;
          });
          if (exists) {
            return prev;
          }
          return [...prev, component];
        });

        if (isProMode) {
          // Set as the highlighted component for visual editing
          setVisualEditingSelectedComponent(component);
          // Trigger AST analysis
          analyzeComponent(component.id);
        }

        return;
      }

      if (event.data?.type === "atlarix-component-deselected") {
        const componentId = event.data.componentId;
        if (componentId) {
          // Disable text editing for the deselected component
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(
              {
                type: "disable-atlarix-text-editing",
                data: { componentId },
              },
              "*",
            );
          }

          setSelectedComponentsPreview((prev) =>
            prev.filter((c) => c.id !== componentId),
          );
          setVisualEditingSelectedComponent((prev) => {
            const shouldClear = prev?.id === componentId;
            if (shouldClear) {
              setCurrentComponentCoordinates(null);
            }
            return shouldClear ? null : prev;
          });
        }
        return;
      }

      if (event.data?.type === "atlarix-component-coordinates-updated") {
        if (event.data.coordinates) {
          setCurrentComponentCoordinates(event.data.coordinates);
        }
        return;
      }

      if (event.data?.type === "atlarix-screenshot-response") {
        if (event.data.success && event.data.dataUrl) {
          setScreenshotDataUrl(event.data.dataUrl);
          setAnnotatorMode(true);
        } else {
          showError(event.data.error);
        }
        return;
      }

      const { type, payload } = event.data as {
        type:
        | "window-error"
        | "unhandled-rejection"
        | "iframe-sourcemapped-error"
        | "build-error-report"
        | "pushState"
        | "replaceState";
        payload?: {
          message?: string;
          stack?: string;
          reason?: string;
          newUrl?: string;
          file?: string;
          frame?: string;
        };
      };

      if (
        type === "window-error" ||
        type === "unhandled-rejection" ||
        type === "iframe-sourcemapped-error"
      ) {
        const stack =
          type === "iframe-sourcemapped-error"
            ? payload?.stack?.split("\n").slice(0, 1).join("\n")
            : payload?.stack;
        const errorMessage = `Error ${payload?.message || payload?.reason
          }\nStack trace: ${stack}`;
        console.error("Iframe error:", errorMessage);
        setErrorMessage({ message: errorMessage, source: "preview-app" });
        setAppOutput((prev) => [
          ...prev,
          {
            message: `Iframe error: ${errorMessage}`,
            type: "client-error",
            appId: selectedAppId!,
            timestamp: Date.now(),
          },
        ]);
        // Also add to browserErrorsAtom so it shows in Errors Tab (re-show if same error was previously dismissed)
        const newError: BrowserError = {
          id: `iframe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'runtime',
          severity: 'error',
          framework: 'browser',
          actionable: true,
          message: payload?.message || payload?.reason || 'Unknown error',
          stack: stack,
          timestamp: Date.now(),
        };
        setDismissedSignatures((prev) => {
          const next = new Set(prev);
          next.delete(getErrorSignature(newError));
          return next;
        });
        setBrowserErrors((prev) => {
          const isDuplicate = prev.some(e => e.message === newError.message && Date.now() - e.timestamp < 5000);
          if (isDuplicate) return prev;
          return [...prev, newError];
        });
      } else if (type === "build-error-report") {
        console.debug(`Build error report: ${payload}`);
        const errorMessage = `${payload?.message} from file ${payload?.file}.\n\nSource code:\n${payload?.frame}`;
        setErrorMessage({ message: errorMessage, source: "preview-app" });
        setAppOutput((prev) => [
          ...prev,
          {
            message: `Build error report: ${JSON.stringify(payload)}`,
            type: "client-error",
            appId: selectedAppId!,
            timestamp: Date.now(),
          },
        ]);
        // Also add to browserErrorsAtom so it shows in Errors Tab (re-show if same error was previously dismissed)
        const newError: BrowserError = {
          id: `build-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: 'build',
          severity: 'error',
          framework: 'vite',
          actionable: true,
          message: payload?.message || 'Build error',
          file: payload?.file,
          rawOutput: payload?.frame,
          timestamp: Date.now(),
        };
        setDismissedSignatures((prev) => {
          const next = new Set(prev);
          next.delete(getErrorSignature(newError));
          return next;
        });
        setBrowserErrors((prev) => {
          const isDuplicate = prev.some(e => e.message === newError.message && Date.now() - e.timestamp < 5000);
          if (isDuplicate) return prev;
          return [...prev, newError];
        });
      } else if (type === "pushState" || type === "replaceState") {
        console.debug(`Navigation event: ${type}`, payload);

        // Update navigation history based on the type of state change
        if (type === "pushState" && payload?.newUrl) {
          // For pushState, we trim any forward history and add the new URL
          const newHistory = [
            ...navigationHistory.slice(0, currentHistoryPosition + 1),
            payload.newUrl,
          ];
          setNavigationHistory(newHistory);
          setCurrentHistoryPosition(newHistory.length - 1);
        } else if (type === "replaceState" && payload?.newUrl) {
          // For replaceState, we replace the current URL
          const newHistory = [...navigationHistory];
          newHistory[currentHistoryPosition] = payload.newUrl;
          setNavigationHistory(newHistory);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    navigationHistory,
    currentHistoryPosition,
    selectedAppId,
    errorMessage,
    setErrorMessage,
    setIsComponentSelectorInitialized,
    setSelectedComponentsPreview,
    setVisualEditingSelectedComponent,
  ]);

  useEffect(() => {
    // Update navigation buttons state
    setCanGoBack(currentHistoryPosition > 0);
    setCanGoForward(currentHistoryPosition < navigationHistory.length - 1);
  }, [navigationHistory, currentHistoryPosition]);

  // Initialize navigation history when iframe loads
  useEffect(() => {
    if (appUrl) {
      setNavigationHistory([appUrl]);
      setCurrentHistoryPosition(0);
      setCanGoBack(false);
      setCanGoForward(false);
    }
  }, [appUrl]);

  // Get current styles when component is selected for visual editing
  useEffect(() => {
    if (visualEditingSelectedComponent) {
      getCurrentElementStyles();
    }
  }, [visualEditingSelectedComponent]);

  // Function to activate component selector in the iframe
  const handleActivateComponentSelector = () => {
    if (iframeRef.current?.contentWindow) {
      const newIsPicking = !isPicking;
      if (!newIsPicking) {
        // Clean up any text editing states when deactivating
        iframeRef.current.contentWindow.postMessage(
          { type: "cleanup-all-text-editing" },
          "*",
        );
      }
      setIsPicking(newIsPicking);
      setVisualEditingSelectedComponent(null);
      iframeRef.current.contentWindow.postMessage(
        {
          type: newIsPicking
            ? "activate-atlarix-component-selector"
            : "deactivate-atlarix-component-selector",
        },
        "*",
      );
    }
  };

  // Function to handle annotator button click
  const handleAnnotatorClick = () => {
    if (annotatorMode) {
      setAnnotatorMode(false);
      return;
    }
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          type: "atlarix-take-screenshot",
        },
        "*",
      );
    }
  };

  // Activate component selector using a shortcut
  useShortcut(
    "c",
    { shift: true, ctrl: !isMac, meta: isMac },
    handleActivateComponentSelector,
    isComponentSelectorInitialized,
    iframeRef,
  );

  // Function to navigate back
  const handleNavigateBack = () => {
    if (canGoBack && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          type: "navigate",
          payload: { direction: "backward" },
        },
        "*",
      );

      // Update our local state
      setCurrentHistoryPosition((prev) => prev - 1);
      setCanGoBack(currentHistoryPosition - 1 > 0);
      setCanGoForward(true);
    }
  };

  // Function to navigate forward
  const handleNavigateForward = () => {
    if (canGoForward && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        {
          type: "navigate",
          payload: { direction: "forward" },
        },
        "*",
      );

      // Update our local state
      setCurrentHistoryPosition((prev) => prev + 1);
      setCanGoBack(true);
      setCanGoForward(
        currentHistoryPosition + 1 < navigationHistory.length - 1,
      );
    }
  };

  // Function to handle reload
  const handleReload = () => {
    setReloadKey((prevKey) => prevKey + 1);
    setErrorMessage(undefined);
    // Reset visual editing state
    setVisualEditingSelectedComponent(null);
    setPendingChanges(new Map());
    setCurrentComponentCoordinates(null);
    // Optionally, add logic here if you need to explicitly stop/start the app again
    // For now, just changing the key should remount the iframe
    console.debug("Reloading iframe preview for app", selectedAppId);
  };

  // Function to navigate to a specific route
  const navigateToRoute = (path: string) => {
    if (iframeRef.current?.contentWindow && appUrl) {
      // Create the full URL by combining the base URL with the path
      const baseUrl = new URL(appUrl).origin;
      const newUrl = `${baseUrl}${path}`;

      // Navigate to the URL
      iframeRef.current.contentWindow.location.href = newUrl;

      // iframeRef.current.src = newUrl;

      // Update navigation history
      const newHistory = [
        ...navigationHistory.slice(0, currentHistoryPosition + 1),
        newUrl,
      ];
      setNavigationHistory(newHistory);
      setCurrentHistoryPosition(newHistory.length - 1);
      setCanGoBack(true);
      setCanGoForward(false);
    }
  };

  // Display loading state
  if (loading) {
    return (
      <div className="flex flex-col h-full relative">
        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-gray-50 dark:bg-gray-950">
          <div className="relative w-5 h-5 animate-spin">
            <div className="absolute top-0 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-primary rounded-full"></div>
            <div className="absolute bottom-0 left-0 w-2 h-2 bg-primary rounded-full opacity-80"></div>
            <div className="absolute bottom-0 right-0 w-2 h-2 bg-primary rounded-full opacity-60"></div>
          </div>
          <p className="text-gray-600 dark:text-gray-300">
            Preparing app preview...
          </p>
        </div>
      </div>
    );
  }

  // Display message if no app is selected
  if (selectedAppId === null) {
    return (
      <div className="p-4 text-gray-500 dark:text-gray-400">
        Select an app to see the preview.
      </div>
    );
  }

  const onRestart = () => {
    restartApp();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Browser-style header - hide when annotator is active */}
      {!annotatorMode && (
        <div className="flex items-center p-2 border-b space-x-2">
          {/* Navigation Buttons */}
          <div className="flex space-x-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleActivateComponentSelector}
                    className={`p-1 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${isPicking
                      ? "bg-purple-500 text-white hover:bg-purple-600 dark:bg-purple-600 dark:hover:bg-purple-700"
                      : " text-purple-700 hover:bg-purple-200  dark:text-purple-300 dark:hover:bg-purple-900"
                      }`}
                    disabled={
                      loading ||
                      !selectedAppId ||
                      !isComponentSelectorInitialized
                    }
                    data-testid="preview-pick-element-button"
                  >
                    <MousePointerClick size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {isPicking
                      ? "Deactivate component selector"
                      : "Select component"}
                  </p>
                  <p>{isMac ? "⌘ + ⇧ + C" : "Ctrl + ⇧ + C"}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleAnnotatorClick}
                    className={`p-1 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed ${annotatorMode
                      ? "bg-purple-500 text-white hover:bg-purple-600 dark:bg-purple-600 dark:hover:bg-purple-700"
                      : " text-purple-700 hover:bg-purple-200  dark:text-purple-300 dark:hover:bg-purple-900"
                      }`}
                    disabled={
                      loading ||
                      !selectedAppId ||
                      isPicking ||
                      !isComponentSelectorInitialized
                    }
                    data-testid="preview-annotator-button"
                  >
                    <Pen size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {annotatorMode
                      ? "Annotator mode active"
                      : "Activate annotator"}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed dark:text-gray-300"
              disabled={!canGoBack || loading || !selectedAppId}
              onClick={handleNavigateBack}
              data-testid="preview-navigate-back-button"
            >
              <ArrowLeft size={16} />
            </button>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed dark:text-gray-300"
              disabled={!canGoForward || loading || !selectedAppId}
              onClick={handleNavigateForward}
              data-testid="preview-navigate-forward-button"
            >
              <ArrowRight size={16} />
            </button>
            <button
              onClick={handleReload}
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed dark:text-gray-300"
              disabled={loading || !selectedAppId}
              data-testid="preview-refresh-button"
            >
              <RefreshCw size={16} />
            </button>
          </div>

          {/* Address Bar with Routes Dropdown - using shadcn/ui dropdown-menu */}
          <div className="relative flex-grow min-w-20">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <div className="flex items-center justify-between px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded text-sm text-gray-700 dark:text-gray-200 cursor-pointer w-full min-w-0">
                  <span className="truncate flex-1 mr-2 min-w-0">
                    {navigationHistory[currentHistoryPosition]
                      ? new URL(navigationHistory[currentHistoryPosition])
                        .pathname
                      : "/"}
                  </span>
                  <ChevronDown size={14} className="flex-shrink-0" />
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-full">
                {availableRoutes.length > 0 ? (
                  availableRoutes.map((route) => (
                    <DropdownMenuItem
                      key={route.path}
                      onClick={() => navigateToRoute(route.path)}
                      className="flex justify-between"
                    >
                      <span>{route.label}</span>
                      <span className="text-gray-500 dark:text-gray-400 text-xs">
                        {route.path}
                      </span>
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>
                    Loading routes...
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Action Buttons */}
          <div className="flex space-x-1">
            <button
              onClick={onRestart}
              className="flex items-center space-x-1 px-3 py-1 rounded-md text-sm hover:bg-[var(--background-darkest)] transition-colors"
              title="Restart App"
            >
              <Power size={16} />
              <span>Restart</span>
            </button>
            <button
              data-testid="preview-open-browser-button"
              onClick={() => {
                if (originalUrl) {
                  IpcClient.getInstance().openExternalUrl(originalUrl);
                }
              }}
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed dark:text-gray-300"
            >
              <ExternalLink size={16} />
            </button>

            {/* Device Mode Button */}
            <Popover open={isDevicePopoverOpen} modal={false}>
              <PopoverTrigger asChild>
                <button
                  data-testid="device-mode-button"
                  onClick={() => {
                    // Toggle popover open/close
                    if (isDevicePopoverOpen) setDeviceMode("desktop");
                    setIsDevicePopoverOpen(!isDevicePopoverOpen);
                  }}
                  className={cn(
                    "p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 dark:text-gray-300",
                    deviceMode !== "desktop" && "bg-gray-200 dark:bg-gray-700",
                  )}
                  title="Device Mode"
                >
                  <MonitorSmartphone size={16} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-2"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onInteractOutside={(e) => e.preventDefault()}
              >
                <TooltipProvider>
                  <ToggleGroup
                    type="single"
                    value={deviceMode}
                    onValueChange={(value) => {
                      if (value) {
                        setDeviceMode(value as DeviceMode);
                        setIsDevicePopoverOpen(false);
                      }
                    }}
                    variant="outline"
                  >
                    {/* Tooltips placed inside items instead of wrapping 
                    to avoid asChild prop merging that breaks highlighting */}
                    <ToggleGroupItem value="desktop" aria-label="Desktop view">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center justify-center">
                            <Monitor size={16} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Desktop</p>
                        </TooltipContent>
                      </Tooltip>
                    </ToggleGroupItem>
                    <ToggleGroupItem value="tablet" aria-label="Tablet view">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center justify-center">
                            <Tablet size={16} className="scale-x-130" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Tablet</p>
                        </TooltipContent>
                      </Tooltip>
                    </ToggleGroupItem>
                    <ToggleGroupItem value="mobile" aria-label="Mobile view">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center justify-center">
                            <Smartphone size={16} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Mobile</p>
                        </TooltipContent>
                      </Tooltip>
                    </ToggleGroupItem>
                  </ToggleGroup>
                </TooltipProvider>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}

      <div className="relative flex-grow overflow-hidden">
        <ErrorBanner
          error={errorMessage}
          onDismiss={() => setErrorMessage(undefined)}
          onAIFix={(customNotes) => {
            if (selectedChatId) {
              // Build comprehensive error context for AI
              const errorContext = `## 🔴 Runtime Error in Live Preview

**Error Message:**
\`\`\`
${errorMessage?.message}
\`\`\`

**Context:**
- Dev server is running at ${appUrl || 'localhost'}
- Error source: ${errorMessage?.source === 'preview-app' ? 'Preview application' : 'Atlarix internal'}
- User is viewing live preview
${customNotes ? `
**Developer Notes:**
> ${customNotes}
` : ''}
Please analyze this error and provide a fix.`;

              streamMessage({
                prompt: errorContext,
                chatId: selectedChatId,
              });
            }
          }}
        />

        {!appUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center space-y-4 bg-gray-50 dark:bg-gray-950">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400 dark:text-gray-500" />
            <p className="text-gray-600 dark:text-gray-300">
              Starting your app server...
            </p>
          </div>
        ) : (
          <div
            className={cn(
              "w-full h-full",
              deviceMode !== "desktop" && "flex justify-center",
            )}
          >
            {annotatorMode && screenshotDataUrl ? (
              <div
                className="w-full h-full bg-white dark:bg-gray-950"
                style={
                  deviceMode == "desktop"
                    ? {}
                    : { width: `${deviceWidthConfig[deviceMode]}px` }
                }
              >
                {userBudget ? (
                  <Annotator
                    screenshotUrl={screenshotDataUrl}
                    onSubmit={addAttachments}
                    handleAnnotatorClick={handleAnnotatorClick}
                  />
                ) : (
                  <AnnotatorOnlyForPro
                    onGoBack={() => setAnnotatorMode(false)}
                  />
                )}
              </div>
            ) : (
              <>
                <iframe
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-orientation-lock allow-pointer-lock allow-presentation allow-downloads"
                  data-testid="preview-iframe-element"
                  onLoad={() => {
                    setErrorMessage(undefined);
                  }}
                  ref={iframeRef}
                  key={reloadKey}
                  title={`Preview for App ${selectedAppId}`}
                  className="w-full h-full border-none bg-white dark:bg-gray-950"
                  style={
                    deviceMode == "desktop"
                      ? {}
                      : { width: `${deviceWidthConfig[deviceMode]}px` }
                  }
                  src={appUrl}
                  allow="clipboard-read; clipboard-write; fullscreen; microphone; camera; display-capture; geolocation; autoplay; picture-in-picture"
                />
                {/* Visual Editing Toolbar */}
                {isProMode &&
                  visualEditingSelectedComponent &&
                  selectedAppId && (
                    <VisualEditingToolbar
                      selectedComponent={visualEditingSelectedComponent}
                      iframeRef={iframeRef}
                      isDynamic={isDynamicComponent}
                      hasStaticText={hasStaticText}
                    />
                  )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

function parseComponentSelection(data: any): ComponentSelection | null {
  if (!data || data.type !== "atlarix-component-selected") {
    return null;
  }

  const component = data.component;
  if (
    !component ||
    typeof component.id !== "string" ||
    typeof component.name !== "string"
  ) {
    return null;
  }

  const { id, name, runtimeId } = component;

  // The id is expected to be in the format "filepath:line:column"
  const parts = id.split(":");
  if (parts.length < 3) {
    console.error(`Invalid component selection id format: "${id}"`);
    return null;
  }

  const columnStr = parts.pop();
  const lineStr = parts.pop();
  const relativePath = parts.join(":");

  if (!columnStr || !lineStr || !relativePath) {
    console.error(`Could not parse component selection from id: "${id}"`);
    return null;
  }

  const lineNumber = parseInt(lineStr, 10);
  const columnNumber = parseInt(columnStr, 10);

  if (isNaN(lineNumber) || isNaN(columnNumber)) {
    console.error(`Could not parse line/column from id: "${id}"`);
    return null;
  }

  return {
    id,
    name,
    runtimeId,
    relativePath: normalizePath(relativePath),
    lineNumber,
    columnNumber,
  };
}
