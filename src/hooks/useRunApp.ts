import { useCallback } from "react";
import { atom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import {
  appOutputAtom,
  appUrlAtom,
  currentAppAtom,
  previewErrorMessageAtom,
  selectedAppIdAtom,
} from "@/atoms/appAtoms";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AppOutput } from "@/ipc/ipc_types";
import { showInputRequest } from "@/lib/toast";

const useRunAppLoadingAtom = atom(false);

export function useRunApp() {
  const [loading, setLoading] = useAtom(useRunAppLoadingAtom);
  const [app, setApp] = useAtom(currentAppAtom);
  const setAppOutput = useSetAtom(appOutputAtom);
  const [, setAppUrlObj] = useAtom(appUrlAtom);
  const appId = useAtomValue(selectedAppIdAtom);
  const setPreviewErrorMessage = useSetAtom(previewErrorMessageAtom);

  const processProxyServerOutput = (output: AppOutput) => {
    const matchesProxyServerStart = output.message.includes(
      "[atlarix-preview-proxy]started=[",
    );
    if (matchesProxyServerStart) {
      // Extract both proxy URL and original URL using regex
      const proxyUrlMatch = output.message.match(
        /\[atlarix-preview-proxy\]started=\[(.*?)\]/,
      );
      const originalUrlMatch = output.message.match(/original=\[(.*?)\]/);

      if (proxyUrlMatch && proxyUrlMatch[1]) {
        const proxyUrl = proxyUrlMatch[1];
        const originalUrl = originalUrlMatch && originalUrlMatch[1];
        setAppUrlObj({
          appUrl: proxyUrl,
          appId: output.appId,
          originalUrl: originalUrl!,
        });
      }
    }
  };

  const processAppOutput = useCallback(
    (output: AppOutput) => {
      // Handle input requests specially
      if (output.type === "input-requested") {
        showInputRequest(output.message, async (response) => {
          try {
            const ipcClient = IpcClient.getInstance();
            await ipcClient.respondToAppInput({
              appId: output.appId,
              response,
            });
          } catch (error) {
            console.error("Failed to respond to app input:", error);
          }
        });
        return; // Don't add to regular output
      }

      // Add to regular app output
      setAppOutput((prev) => [...prev, output]);

      // Process proxy server output
      processProxyServerOutput(output);
    },
    [setAppOutput],
  );
  const restartApp = useCallback(
    async ({
      removeNodeModules = false,
    }: { removeNodeModules?: boolean } = {}) => {
      if (appId === null) {
        return;
      }
      setLoading(true);
      try {
        const ipcClient = IpcClient.getInstance();
        console.debug(
          "Restarting app",
          appId,
          removeNodeModules ? "with node_modules cleanup" : "",
        );

        // Clear the URL and add restart message
        setAppUrlObj({ appUrl: null, appId: null, originalUrl: null });
        setAppOutput((prev) => [
          ...prev,
          {
            message: "Restarting app...",
            type: "stdout",
            appId,
            timestamp: Date.now(),
          },
        ]);

        const app = await ipcClient.getApp(appId);
        setApp(app);
        await ipcClient.restartApp(appId, processAppOutput, removeNodeModules);
      } catch (error) {
        console.error(`Error restarting app ${appId}:`, error);
        setPreviewErrorMessage(
          error instanceof Error
            ? { message: error.message, source: "atlarix-app" }
            : {
                message: error?.toString() || "Unknown error",
                source: "atlarix-app",
              },
        );
      } finally {
        setLoading(false);
      }
    },
    [appId, setApp, setAppOutput, setAppUrlObj, processAppOutput],
  );

  return {
    loading,
    restartApp,
    app,
  };
}
