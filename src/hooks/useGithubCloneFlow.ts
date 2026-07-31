import { useCallback, useEffect, useRef, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { showError } from "@/lib/toast";

declare const window: Window & {
  electron?: {
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
  };
};

/**
 * Windows paths need a backslash separator in the destination PREVIEW; the actual
 * clone path is normalized by `path.resolve` in the main process either way.
 */
function joinPath(parentDir: string, name: string): string {
  const sep = /^[A-Za-z]:[\\/]/.test(parentDir) || parentDir.includes("\\") ? "\\" : "/";
  return `${parentDir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function useGithubCloneFlow() {
  /** Raw text in the "Save to" field. Starts empty — the destination is never guessed. */
  const [parentDirInput, setParentDirInput] = useState("");
  /** Validated absolute parent dir. Null until the typed/picked path checks out. */
  const [targetParentDir, setTargetParentDir] = useState<string | null>(null);
  const [parentDirError, setParentDirError] = useState<string | null>(null);
  const [validatingParentDir, setValidatingParentDir] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneProgress, setCloneProgress] = useState(0);
  const [cloneMessage, setCloneMessage] = useState("");
  const [activeRepo, setActiveRepo] = useState<string | null>(null);

  // Debounced validation of whatever is in the field, so a half-typed path doesn't
  // flash an error on every keystroke.
  const validationSeq = useRef(0);
  useEffect(() => {
    const input = parentDirInput.trim();
    const seq = ++validationSeq.current;
    if (!input) {
      setTargetParentDir(null);
      setParentDirError(null);
      setValidatingParentDir(false);
      return;
    }
    setValidatingParentDir(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await IpcClient.getInstance().validateParentDir(input);
          if (seq !== validationSeq.current) return;
          if (result.ok && result.path) {
            setTargetParentDir(result.path);
            setParentDirError(null);
          } else {
            setTargetParentDir(null);
            setParentDirError(result.error ?? "That folder can't be used.");
          }
        } catch (e) {
          if (seq !== validationSeq.current) return;
          setTargetParentDir(null);
          setParentDirError(e instanceof Error ? e.message : String(e));
        } finally {
          if (seq === validationSeq.current) setValidatingParentDir(false);
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [parentDirInput]);

  const resolveTargetPath = useCallback(
    (workspaceName: string): string | null => {
      if (!targetParentDir?.trim() || !workspaceName.trim()) return null;
      return joinPath(targetParentDir, workspaceName.trim());
    },
    [targetParentDir],
  );

  /**
   * Native directory picker. A CANCEL is silent; a FAILURE is not — on some Linux
   * desktops the picker never opens, and swallowing that left users with a dead
   * Clone button and no explanation. Typing a path always remains available.
   */
  const chooseFolder = useCallback(async (): Promise<string | null> => {
    const bridge = window.electron?.ipcRenderer;
    if (!bridge) {
      showError("Couldn't open the folder picker — type the folder path instead.");
      return null;
    }
    try {
      const result = (await bridge.invoke("dialog:openDirectory")) as
        | { canceled?: boolean; filePaths?: string[] }
        | undefined;
      if (result?.canceled) return null;
      const picked = result?.filePaths?.[0];
      if (!picked) {
        showError("Couldn't open the folder picker — type the folder path instead.");
        return null;
      }
      setParentDirInput(picked);
      return picked;
    } catch (e) {
      showError(
        `Couldn't open the folder picker — type the folder path instead. (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
      return null;
    }
  }, []);

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
    parentDirInput,
    setParentDirInput,
    parentDirError,
    validatingParentDir,
    targetParentDir,
    cloning,
    cloneProgress,
    cloneMessage,
    activeRepo,
    resolveTargetPath,
    chooseFolder,
    cancelClone,
    runClone,
  };
}
