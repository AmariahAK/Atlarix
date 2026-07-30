import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { LanguageModelProvider } from "@/ipc/ipc_types";
import { useConfiguredProviders } from "./useConfiguredProviders";
import { useSettings } from "./useSettings";
import { VertexProviderSetting, AzureProviderSetting } from "@/lib/schemas";

export function useLanguageModelProviders() {
  const ipcClient = IpcClient.getInstance();
  const { settings, envVars } = useSettings();

  const { data: dbConfiguredProviders = [] } = useConfiguredProviders();
  const [compassBuildOk, setCompassBuildOk] = useState(false);

  const queryResult = useQuery<LanguageModelProvider[], Error>({
    queryKey: ["languageModelProviders"],
    queryFn: async () => {
      return ipcClient.getLanguageModelProviders();
    },
  });

  useEffect(() => {
    const run = async () => {
      try {
        const ok = await ipcClient.isCompassBuildConfigured();
        setCompassBuildOk(ok);
      } catch {
        setCompassBuildOk(false);
      }
    };
    void run();
  }, [ipcClient]);

  const isProviderSetup = (provider: string) => {
    const providerSettings = settings?.providerSettings[provider];
    if (queryResult.isLoading) {
      return false;
    }
    // Ollama & LM Studio don't need API keys - always "ready"
    if (provider === "ollama" || provider === "lmstudio") {
      return true;
    }
    if (provider === "compass") {
      return compassBuildOk;
    }
    // Vertex uses service account credentials instead of an API key
    if (provider === "vertex") {
      const vertexSettings = providerSettings as VertexProviderSetting;
      if (
        vertexSettings?.serviceAccountKey?.value &&
        vertexSettings?.projectId &&
        vertexSettings?.location
      ) {
        return true;
      }
      return false;
    }
    if (provider === "azure") {
      const azureSettings = providerSettings as AzureProviderSetting;
      const hasSavedSettings = Boolean(
        (azureSettings?.apiKey?.value ?? "").trim() &&
        (azureSettings?.resourceName ?? "").trim(),
      );
      if (hasSavedSettings) {
        return true;
      }
      if (envVars["AZURE_API_KEY"] && envVars["AZURE_RESOURCE_NAME"]) {
        return true;
      }
      return false;
    }
    // Check settings
    if (providerSettings?.apiKey?.value) {
      return true;
    }
    // Check env vars
    const providerData = queryResult.data?.find((p) => p.id === provider);
    if (providerData?.envVarName && envVars[providerData.envVarName]) {
      return true;
    }
    // Check database (provider_api_keys table)
    if (dbConfiguredProviders.includes(provider)) {
      return true;
    }
    return false;
  };

  const isAnyProviderSetup = () => {
    // Check if a local provider is selected (ollama, lmstudio don't need API keys)
    const localProviders = ['ollama', 'lmstudio'];
    const selectedProvider = settings?.selectedModel?.provider;
    if (selectedProvider && localProviders.includes(selectedProvider)) {
      return true;
    }

    // Check EVERY cloud provider the app knows about — overlaid first-class ones and
    // the models.dev long tail alike. This used to read a closed 21-entry tuple in
    // `schemas.ts`, so a user whose only key was for a catalog-only provider read as
    // "no provider configured" and got sent back to the setup wizard.
    if (
      queryResult.data?.some(
        (provider) => provider.type === "cloud" && isProviderSetup(provider.id),
      )
    ) {
      return true;
    }

    // Check custom providers
    const customProviders = queryResult.data?.filter(
      (provider) => provider.type === "custom",
    );
    return (
      customProviders?.some((provider) => isProviderSetup(provider.id)) ?? false
    );
  };

  return {
    ...queryResult,
    isProviderSetup,
    isAnyProviderSetup,
  };
}
