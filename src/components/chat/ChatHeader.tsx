import {
  History,
  PlusCircle,
  GitBranch,
  Info,
  KeyRound,
} from "lucide-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useVersions } from "@/hooks/useVersions";
import { Button } from "../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { IpcClient } from "@/ipc/ipc_client";
import { useRouter } from "@tanstack/react-router";
import {
  selectedChatIdAtom,
  toolIndicatorAtom,
  streamLastActivityAtByChatIdAtom,
  streamSlowWarningByChatIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
  chatErrorByIdAtom,
} from "@/atoms/chatAtoms";
import { useChats } from "@/hooks/useChats";
import { showError, showSuccess } from "@/lib/toast";
import { useCallback, useEffect, useState } from "react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useCurrentBranch } from "@/hooks/useCurrentBranch";
import { useCheckoutVersion } from "@/hooks/useCheckoutVersion";
import { useRenameBranch } from "@/hooks/useRenameBranch";
import { isAnyCheckoutVersionInProgressAtom } from "@/store/appAtoms";
import { LoadingBar } from "../ui/LoadingBar";
import { WorkspaceSnapshotButton } from "../WorkspaceSnapshotButton";
interface ChatHeaderProps {
  isVersionPaneOpen: boolean;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
  onVersionClick: () => void;
}

export function ChatHeader({
  isVersionPaneOpen,
  isPreviewOpen,
  onTogglePreview,
  onVersionClick,
}: ChatHeaderProps) {
  const appId = useAtomValue(selectedAppIdAtom);
  const { versions, loading: versionsLoading } = useVersions(appId);
  const { navigate } = useRouter();
  const [selectedChatId, setSelectedChatId] = useAtom(selectedChatIdAtom);
  const setToolIndicator = useSetAtom(toolIndicatorAtom);
  const setStreamLastActivity = useSetAtom(streamLastActivityAtByChatIdAtom);
  const setStreamSlowWarning = useSetAtom(streamSlowWarningByChatIdAtom);
  const setChatStreamCount = useSetAtom(chatStreamCountByIdAtom);
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  const setChatErrorById = useSetAtom(chatErrorByIdAtom);
  const { refreshChats } = useChats(appId);
  const { isStreaming } = useStreamChat();
  const isAnyCheckoutVersionInProgress = useAtomValue(
    isAnyCheckoutVersionInProgressAtom,
  );

  const {
    branchInfo,
    isLoading: branchInfoLoading,
    refetchBranchInfo,
  } = useCurrentBranch(appId);

  const { checkoutVersion, isCheckingOutVersion } = useCheckoutVersion();
  const { renameBranch, isRenamingBranch } = useRenameBranch();

  useEffect(() => {
    if (appId) {
      refetchBranchInfo();
    }
  }, [appId, selectedChatId, isStreaming, refetchBranchInfo]);

  const handleCheckoutMainBranch = async () => {
    if (!appId) return;
    await checkoutVersion({ appId, versionId: "main" });
  };

  const handleRenameMasterToMain = async () => {
    if (!appId) return;
    // If this throws, it will automatically show an error toast
    await renameBranch({ oldBranchName: "master", newBranchName: "main" });

    showSuccess("Master branch renamed to main");
  };

  const [vaultServices, setVaultServices] = useState<string[]>([]);

  const refreshVaultServices = useCallback(async () => {
    try {
      const ipc = window.electron?.ipcRenderer;
      if (!ipc?.invoke) return;
      const list = (await ipc.invoke("token-vault:list-services")) as
        | Array<{ name: string }>
        | undefined;
      setVaultServices(Array.isArray(list) ? list.map((s) => s.name) : []);
    } catch {
      setVaultServices([]);
    }
  }, []);

  useEffect(() => {
    void refreshVaultServices();
    const interval = setInterval(() => void refreshVaultServices(), 15000);
    const unsub = window.electron?.ipcRenderer?.on?.("token-vault:connected", () => {
      void refreshVaultServices();
    });
    return () => {
      clearInterval(interval);
      unsub?.();
    };
  }, [refreshVaultServices]);

  const handleNewChat = async () => {
    if (appId) {
        try {
          const previousChatId = selectedChatId;
          try {
            await window.electron?.ipcRenderer?.invoke("token-vault:clear-all-sessions");
          } catch {
            /* non-fatal */
          }
          try {
            if (previousChatId != null) {
              await window.electron?.ipcRenderer?.invoke(
                "workforce:session:clear",
                previousChatId,
              );
            }
          } catch {
            /* non-fatal */
          }
          await refreshVaultServices();
        const chatId = await IpcClient.getInstance().createChat(appId);
        // Fix: Finding 2 — clear per-chat stream / indicator state so the new session has no ghost UI
        if (previousChatId != null) {
          setStreamLastActivity((prev) => {
            const n = new Map(prev);
            n.delete(previousChatId);
            return n;
          });
          setStreamSlowWarning((prev) => {
            const n = new Map(prev);
            n.delete(previousChatId);
            return n;
          });
          setChatStreamCount((prev) => {
            const n = new Map(prev);
            n.delete(previousChatId);
            return n;
          });
          setIsStreamingById((prev) => {
            const n = new Map(prev);
            n.delete(previousChatId);
            return n;
          });
          setChatErrorById((prev) => {
            const n = new Map(prev);
            n.delete(previousChatId);
            return n;
          });
        }
        setToolIndicator({
          active: false,
          toolName: null,
          count: 0,
          activeChatId: null,
          liveOutputLines: [],
          liveErrorLines: [],
          liveProgressLines: [],
          liveViewMode: "error_first",
          phaseLabel: null,
        });
        setSelectedChatId(chatId);
        navigate({
          to: "/chat",
          search: { id: chatId },
        });
        await refreshChats();
      } catch (error) {
        showError(`Failed to create new chat: ${(error as any).toString()}`);
      }
    } else {
      navigate({ to: "/" });
    }
  };

  // REMINDER: KEEP UP TO DATE WITH app_handlers.ts
  const versionPostfix = versions.length === 100_000 ? `+` : "";

  const isNotMainBranch = branchInfo && branchInfo.branch !== "main";

  const currentBranchName = branchInfo?.branch;

  return (
    <div className="flex flex-col w-full @container">
      <LoadingBar isVisible={isAnyCheckoutVersionInProgress} />
      {/* If the version pane is open, it's expected to not always be on the main branch. */}
      {isNotMainBranch && !isVersionPaneOpen && (
        <div className="flex flex-col @sm:flex-row items-center justify-between px-4 py-2 bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2 text-sm">
            <GitBranch size={16} />
            <span>
              {currentBranchName === "<no-branch>" && (
                <>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center  gap-1">
                          {isAnyCheckoutVersionInProgress ? (
                            <>
                              <span>
                                Please wait, switching back to latest version...
                              </span>
                            </>
                          ) : (
                            <>
                              <strong>Warning:</strong>
                              <span>You are not on a branch</span>
                              <Info size={14} />
                            </>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {isAnyCheckoutVersionInProgress
                            ? "Version checkout is currently in progress"
                            : "Checkout main branch, otherwise changes will not be saved properly"}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </>
              )}
              {currentBranchName && currentBranchName !== "<no-branch>" && (
                <span>
                  You are on branch: <strong>{currentBranchName}</strong>.
                </span>
              )}
              {branchInfoLoading && <span>Checking branch...</span>}
            </span>
          </div>
          {currentBranchName === "master" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRenameMasterToMain}
              disabled={isRenamingBranch || branchInfoLoading}
            >
              {isRenamingBranch ? "Renaming..." : "Rename master to main"}
            </Button>
          ) : isAnyCheckoutVersionInProgress && !isCheckingOutVersion ? null : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckoutMainBranch}
              disabled={isCheckingOutVersion || branchInfoLoading}
            >
              {isCheckingOutVersion
                ? "Checking out..."
                : "Switch to main branch"}
            </Button>
          )}
        </div>
      )}

      {/* Why is this pt-0.5? Because the loading bar is h-1 (it always takes space) and we want the vertical spacing to be consistent.*/}
        <div className="@container flex items-center justify-between pb-1.5 pt-0.5">
        <div className="flex items-center space-x-2 min-w-0">
          {vaultServices.length > 0 && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="hidden @2xs:flex items-center gap-1 mr-1 text-muted-foreground shrink-0">
                    <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
                    <div className="flex flex-wrap gap-1 max-w-[140px]">
                      {vaultServices.slice(0, 4).map((name) => (
                        <span
                          key={name}
                          className="text-[10px] px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground truncate max-w-[72px]"
                          title={name}
                        >
                          {name}
                        </span>
                      ))}
                      {vaultServices.length > 4 ? (
                        <span className="text-[10px] text-muted-foreground">+{vaultServices.length - 4}</span>
                      ) : null}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  Token Vault connected: {vaultServices.join(", ")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            onClick={handleNewChat}
            variant="ghost"
            className="flex items-center justify-start gap-2 mx-2 py-3 shrink-0"
          >
            <PlusCircle size={16} />
            <span>New Chat</span>
          </Button>
          <Button
            onClick={onVersionClick}
            variant="ghost"
            className="hidden @6xs:flex cursor-pointer items-center gap-1 text-sm px-2 py-1 rounded-md"
          >
            <History size={16} />
            {versionsLoading
              ? "..."
              : `Version ${versions.length}${versionPostfix}`}
          </Button>
          <WorkspaceSnapshotButton />
        </div>

        <button
          data-testid="toggle-preview-panel-button"
          onClick={onTogglePreview}
          className="cursor-pointer p-2 hover:bg-(--background-lightest) rounded-md"
        >
          {isPreviewOpen ? (
            <ChevronRight size={20} aria-hidden />
          ) : (
            <ChevronLeft size={20} aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
