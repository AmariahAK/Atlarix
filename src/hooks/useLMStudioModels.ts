import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  lmStudioModelsAtom,
  lmStudioModelsLoadingAtom,
  lmStudioModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";

export function useLocalLMSModels() {
  const [models, setModels] = useAtom(lmStudioModelsAtom);
  const [loading, setLoading] = useAtom(lmStudioModelsLoadingAtom);
  const [error, setError] = useAtom(lmStudioModelsErrorAtom);

  const ipcClient = IpcClient.getInstance();

  /**
   * Load local models from LM Studio
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await ipcClient.listLocalLMStudioModels();

      // Check if the response contains an error (LM Studio not running, etc.)
      if (response.error) {
        setModels([]);
        setError(new Error(response.error));
        return [];
      }

      setModels(response.models);
      setError(null);

      return response.models;
    } catch (error) {
      console.error("Error loading local LMStudio models:", error);
      setError(error instanceof Error ? error : new Error(String(error)));
      return [];
    } finally {
      setLoading(false);
    }
  }, [ipcClient, setModels, setError, setLoading]);

  return {
    models,
    loading,
    error,
    loadModels,
  };
}
