import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/utils";
import { useDeepLink } from "@/contexts/DeepLinkContext";
import { useEffect, useState } from "react";
import { AtlarixProSuccessDialog } from "@/components/AtlarixProSuccessDialog";
import { useTheme } from "@/contexts/ThemeContext";
import { IpcClient } from "@/ipc/ipc_client";

export const TitleBar = () => {
  const { refreshSettings } = useSettings();
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const [showWindowControls, setShowWindowControls] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onWindowFullscreenChanged(
      ({ fullscreen }) => {
        setIsFullscreen(fullscreen);
      },
    );
    return unsub;
  }, []);

  useEffect(() => {
    // Check if we're running on Windows
    const checkPlatform = async () => {
      try {
        const platform = await IpcClient.getInstance().getSystemPlatform();
        setShowWindowControls(platform !== "darwin");
      } catch (error) {
        console.error("Failed to get platform info:", error);
      }
    };

    checkPlatform();
  }, []);

  const showAtlarixProSuccessDialog = () => {
    setIsSuccessDialogOpen(true);
  };

  const { lastDeepLink, clearLastDeepLink } = useDeepLink();
  useEffect(() => {
    const handleDeepLink = async () => {
      if (lastDeepLink?.type === "atlarix-pro-return") {
        await refreshSettings();
        showAtlarixProSuccessDialog();
        clearLastDeepLink();
      }
    };
    handleDeepLink();
  }, [lastDeepLink?.timestamp]);

  return (
    <>
      {/* Fix: Finding 1 — fullscreen: collapse drag region so it does not steal clicks */}
      <div
        className={cn(
          "@container z-11 w-full bg-(--sidebar) absolute top-0 left-0 flex items-center justify-end",
          isFullscreen
            ? "h-0 min-h-0 pointer-events-none overflow-visible"
            : "h-11 app-region-drag",
        )}
      >
        {!isFullscreen ? <div className="flex-1" /> : null}

        {showWindowControls ? (
          <div className={cn("ml-auto", isFullscreen && "pointer-events-auto")}>
            <WindowsControls />
          </div>
        ) : null}
      </div>

      <AtlarixProSuccessDialog
        isOpen={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
      />
    </>
  );
};

function WindowsControls() {
  const { isDarkMode } = useTheme();
  const ipcClient = IpcClient.getInstance();

  const minimizeWindow = () => {
    ipcClient.minimizeWindow();
  };

  const maximizeWindow = () => {
    ipcClient.maximizeWindow();
  };

  const closeWindow = () => {
    ipcClient.closeWindow();
  };

  return (
    <div className="ml-auto flex no-app-region-drag">
      <button
        className="w-10 h-10 flex items-center justify-center hover:bg-accent transition-colors"
        onClick={minimizeWindow}
        aria-label="Minimize"
      >
        <svg
          width="12"
          height="1"
          viewBox="0 0 12 1"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            width="12"
            height="1"
            fill={isDarkMode ? "#ffffff" : "#000000"}
          />
        </svg>
      </button>
      <button
        className="w-10 h-10 flex items-center justify-center hover:bg-accent transition-colors"
        onClick={maximizeWindow}
        aria-label="Maximize"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect
            x="0.5"
            y="0.5"
            width="11"
            height="11"
            stroke={isDarkMode ? "#ffffff" : "#000000"}
          />
        </svg>
      </button>
      <button
        className="w-10 h-10 flex items-center justify-center hover:bg-red-500 transition-colors"
        onClick={closeWindow}
        aria-label="Close"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1 1L11 11M1 11L11 1"
            stroke={isDarkMode ? "#ffffff" : "#000000"}
            strokeWidth="1.5"
          />
        </svg>
      </button>
    </div>
  );
}
