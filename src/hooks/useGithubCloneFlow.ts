import { useCallback, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { showError } from "@/lib/toast";

declare const window: Window & {
  electron?: {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

export function useGithubCloneFlow() {
  const [targetParentDir, setTargetParentDir] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState(0);
  const [cloneMessage, setCloneMessage] = useState("");
  const [activeRepo, setActiveRepo] = useState<string | null>(null);

  const resolveTargetPath = useCallback(
    (workspaceName: string): string | null => {
      if (!targetParentDir?.trim() || !workspaceName.trim()) return null;
      return `${targetParentDir.replace(/\/$/, "")}/${workspaceName.trim()}`;
    },
    [targetParentDir],
  );

  const chooseFolder = useCallback(async (): Promise<string | null> => {
    const result = (await window.electron?.ipcRenderer.invoke(
      "dialog:openDirectory",
    )) as { canceled?: boolean; filePaths?: string[] } | undefined;
    if (result?.canceled || !result?.filePaths?.length) return null;
    setTargetParentDir(result.filePaths[0]);
    return result.filePaths[0];
  }, []);

  const ensureFolder = useCallback(async (): Promise<boolean> => {
    if (targetParentDir) return true;
    const picked = await chooseFolder();
    return !!picked;
  }, [targetParentDir, chooseFolder]);

  const cancelClone = useCallback(() => {
    IpcClient.getInstance().cancelGithubClone();
    setCloning(false);
    setActiveRepo(null);
    setCloneProgress(0);
    setCloneMessage("");
  }, []);

  const resetCloneUi = useCallback(() => {
    setCloning(false);
    setActiveRepo(null);
    setCloneProgress(0);
    setCloneMessage("");
  }, []);

  const runClone = useCallback(
    async (params: {
      url: string;
      appName: string;
      installCommand?: string;
      startCommand?: string;
      repoLabel?: string;
    }) => {
      const targetPath = resolveTargetPath(params.appName);
      if (!targetPath) {
        showError("Choose a folder to save the project first.");
        return null;
      }

      setCloning(true);
      setCloneProgress(0);
      setCloneMessage("Starting…");
      if (params.repoLabel) setActiveRepo(params.repoLabel);

      const unsub = IpcClient.getInstance().onGithubCloneProgress((p) => {
        setCloneProgress(p.progress);
        setCloneMessage(p.message);
      });

      try {
        const result = await IpcClient.getInstance().cloneRepoFromUrl({
          url: params.url,
          appName: params.appName,
          targetPath,
          installCommand: params.installCommand,
          startCommand: params.startCommand,
        });
        if ("error" in result) {
          if (result.error !== "Clone cancelled.") {
            showError(result.error);
          }
          return null;
        }
        return result;
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        unsub();
        resetCloneUi();
      }
    },
    [resolveTargetPath, resetCloneUi],
  );

  return {
    targetParentDir,
    setTargetParentDir,
    cloning,
    cloneProgress,
    cloneMessage,
    activeRepo,
    resolveTargetPath,
    chooseFolder,
    ensureFolder,
    cancelClone,
    runClone,
  };
}
