import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  localModelsAtom,
  localModelsLoadingAtom,
  localModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { showWarning } from "@/lib/toast";

let lastOllamaWarning = "";

export function useLocalModels() {
  const [models, setModels] = useAtom(localModelsAtom);
  const [loading, setLoading] = useAtom(localModelsLoadingAtom);
  const [error, setError] = useAtom(localModelsErrorAtom);

  const ipcClient = IpcClient.getInstance();

  /**
   * Load local models from Ollama
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const response = await ipcClient.listLocalOllamaModels();
      if (response.error) {
        if (response.error !== lastOllamaWarning) {
          showWarning(response.error);
          lastOllamaWarning = response.error;
        }
        setModels([]);
        setError(new Error(response.error));
        return [];
      }

      setModels(response.models);
      setError(null);
      lastOllamaWarning = "";

      return response.models;
    } catch (error) {
      console.error("Error loading local Ollama models:", error);
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastOllamaWarning) {
        showWarning(message);
        lastOllamaWarning = message;
      }
      setError(error instanceof Error ? error : new Error(message));
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
