import { useState, useEffect } from "react";
import { useSetAtom } from "jotai";
import { providerKeyCheckAtom } from "@/atoms/viewAtoms";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {} from "@/components/ui/accordion";

import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import {
  UserSettings,
  AzureProviderSetting,
  VertexProviderSetting,
} from "@/lib/schemas";

import { COMPASS_PROVIDER_ID } from "@/ipc/shared/compass_constants";
import { ProviderSettingsHeader } from "./ProviderSettingsHeader";
import { ApiKeyConfiguration } from "./ApiKeyConfiguration";
import { CompassProviderSettings } from "./CompassProviderSettings";
import { ModelsSection } from "./ModelsSection";
import { TokenBudgetInput } from "./TokenBudgetInput";
import { LocalProviderModelSelector } from "./LocalProviderModelSelector";
import { UseProviderAsDefaultPrompt } from "./UseProviderAsDefaultPrompt";

/**
 * A token budget applies to any BYOK cloud provider — the user pays per token, so
 * capping spend is meaningful. This was a 19-entry allowlist, which meant every
 * catalog provider silently lacked the control; it's now derived from the provider's
 * own type. Core (`compass`) is excluded because its spend is metered by the wallet,
 * and local runtimes because their tokens are free.
 */
function supportsTokenBudget(
  providerId: string,
  providerData: { type?: string } | undefined,
): boolean {
  if (providerId === COMPASS_PROVIDER_ID) return false;
  return providerData?.type === "cloud";
}

interface ProviderSettingsPageProps {
  provider: string;
}

export function ProviderSettingsPage({ provider }: ProviderSettingsPageProps) {
  const {
    settings,
    envVars,
    loading: settingsLoading,
    error: settingsError,
    updateSettings,
  } = useSettings();

  // Fetch all providers
  const {
    data: allProviders,
    isLoading: providersLoading,
    error: providersError,
  } = useLanguageModelProviders();

  // A20/L-5: warn when provider keys / OAuth tokens are stored WITHOUT OS
  // encryption (no keystore) — persistent, since it's a real at-rest exposure.
  const [secretsEncrypted, setSecretsEncrypted] = useState(true);
  useEffect(() => {
    let cancelled = false;
    IpcClient.getInstance()
      .getSecretEncryptionAvailable()
      .then((ok) => {
        if (!cancelled) setSecretsEncrypted(ok);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Find the specific provider data from the fetched list
  const providerData = allProviders?.find((p) => p.id === provider);
  useEffect(() => {
    const layoutMainContentContainer = document.getElementById(
      "layout-main-content-container",
    );
    if (layoutMainContentContainer) {
      layoutMainContentContainer.scrollTo(0, 0);
    }
  }, [providerData?.id]);

  const supportsCustomModels =
    providerData?.type === "custom" || providerData?.type === "cloud";

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Shown after a key save when chats would still go to Core. */
  const [offerDefaultSwitch, setOfferDefaultSwitch] = useState(false);
  const router = useRouter();

  const providerDisplayName = providerData?.name ?? "Unknown Provider";
  const providerWebsiteUrl = providerData?.websiteUrl;
  const hasFreeTier = providerData?.hasFreeTier;
  const envVarName = providerData?.envVarName;

  // Use provider ID (which is the 'provider' prop)
  const userApiKey = settings?.providerSettings?.[provider]?.apiKey?.value;

  // --- Configuration Logic --- Updated Priority ---
  const isValidUserKey =
    !!userApiKey &&
    !userApiKey.startsWith("Invalid Key") &&
    userApiKey !== "Not Set";
  const hasEnvKey = !!(envVarName && envVars[envVarName]);

  const azureSettings = settings?.providerSettings?.azure as
    | AzureProviderSetting
    | undefined;
  const azureApiKeyFromSettings = (azureSettings?.apiKey?.value ?? "").trim();
  const azureResourceNameFromSettings = (
    azureSettings?.resourceName ?? ""
  ).trim();
  const azureHasSavedSettings = Boolean(
    azureApiKeyFromSettings && azureResourceNameFromSettings,
  );
  const azureHasEnvConfiguration = Boolean(
    envVars["AZURE_API_KEY"] && envVars["AZURE_RESOURCE_NAME"],
  );

  const vertexSettings = settings?.providerSettings?.vertex as
    | VertexProviderSetting
    | undefined;
  const isVertexConfigured = Boolean(
    vertexSettings?.projectId &&
      vertexSettings?.location &&
      vertexSettings?.serviceAccountKey?.value,
  );

  const elasticSettings = settings?.providerSettings?.elastic as
    | { baseUrl?: string; apiKey?: { value?: string } }
    | undefined;
  const isElasticConfigured = Boolean(
    elasticSettings?.baseUrl?.trim() && elasticSettings?.apiKey?.value,
  );

  const isAzureConfigured =
    provider === "azure"
      ? azureHasSavedSettings || azureHasEnvConfiguration
      : false;

  const isConfigured =
    provider === "azure"
      ? isAzureConfigured
      : provider === "vertex"
        ? isVertexConfigured
        : provider === "elastic"
          ? isElasticConfigured
          : isValidUserKey || hasEnvKey; // Configured if either is set

  // Check the saved key with the provider: on opening the page, and after a
  // save. Any saved key used to read "Setup Complete", unchecked (QA #24).
  const savedKey = settings?.providerSettings?.[provider]?.apiKey?.value;
  const setKeyChecks = useSetAtom(providerKeyCheckAtom);
  const [keyCheck, setKeyCheck] = useState<{
    status: string;
    detail: string;
  } | null>(null);
  const isCustomProvider = provider.startsWith("custom::");
  useEffect(() => {
    setKeyCheck(null);
    // A provider the user added is checked keyless too (a local server needs
    // no key; QA #25).
    if ((!savedKey || savedKey === "none") && !isCustomProvider) return;
    let live = true;
    void IpcClient.getInstance()
      .checkProviderKey(provider)
      .then((r) => {
        if (!live) return;
        setKeyCheck(r);
        if (r) setKeyChecks((prev) => ({ ...prev, [provider]: r.status }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [provider, savedKey, isCustomProvider]);

  // --- Save Handler ---
  const handleSaveKey = async (value: string) => {
    if (!value.trim()) {
      setSaveError("API Key cannot be empty.");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const settingsUpdate: Partial<UserSettings> = {
        providerSettings: {
          ...settings?.providerSettings,
          [provider]: {
            ...settings?.providerSettings?.[provider],
            apiKey: {
              value,
            },
          },
        },
      };
      await updateSettings(settingsUpdate);
      setApiKeyInput(""); // Clear input on success
      /*
       * A saved key does not change which model runs — the default is Atlarix Core
       * and nothing in the app moves it. Offer the switch here, while the user is
       * still looking at the provider they just configured, rather than letting them
       * find out by watching Core credit drain. Only when they are actually ON Core;
       * if they have already picked a BYOK model there is nothing to fix.
       */
      if (settings?.selectedModel?.provider === COMPASS_PROVIDER_ID) {
        setOfferDefaultSwitch(true);
      }
    } catch (error: any) {
      console.error("Error saving API key:", error);
      setSaveError(error.message || "Failed to save API key.");
    } finally {
      setIsSaving(false);
    }
  };

  // --- Delete Handler ---
  const handleDeleteKey = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({
        providerSettings: {
          ...settings?.providerSettings,
          [provider]: {
            ...settings?.providerSettings?.[provider],
            apiKey: undefined,
          },
        },
      });
      // Optionally show a success message
    } catch (error: any) {
      console.error("Error deleting API key:", error);
      setSaveError(error.message || "Failed to delete API key.");
    } finally {
      setIsSaving(false);
    }
  };

  // Effect to clear input error when input changes
  useEffect(() => {
    if (saveError) {
      setSaveError(null);
    }
  }, [apiKeyInput]);

  // --- Loading State for Providers ---
  if (providersLoading) {
    return (
      <div className="min-h-screen px-8 py-4">
        <div className="max-w-4xl mx-auto">
          <Skeleton className="h-8 w-24 mb-4" />
          <Skeleton className="h-10 w-1/2 mb-6" />
          <Skeleton className="h-10 w-48 mb-4" />
          <div className="space-y-4 mt-6">
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </div>
    );
  }

  // --- Error State for Providers ---
  if (providersError) {
    return (
      <div className="min-h-screen px-8 py-4">
        <div className="max-w-4xl mx-auto">
          <Button
            onClick={() => router.history.back()}
            variant="outline"
            size="sm"
            className="flex items-center gap-2 mb-4 bg-(--background-lightest) py-5"
          >
            <ArrowLeft className="h-4 w-4" />
            Go Back
          </Button>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mr-3 mb-6">
            Configure Provider
          </h1>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error Loading Provider Details</AlertTitle>
            <AlertDescription>
              Could not load provider data: {providersError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  // Handle case where provider is not found (e.g., invalid ID in URL)
  if (!providerData) {
    return (
      <div className="min-h-screen px-8 py-4">
        <div className="max-w-4xl mx-auto">
          <Button
            onClick={() => router.history.back()}
            variant="outline"
            size="sm"
            className="flex items-center gap-2 mb-4 bg-(--background-lightest) py-5"
          >
            <ArrowLeft className="h-4 w-4" />
            Go Back
          </Button>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mr-3 mb-6">
            Provider Not Found
          </h1>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              The provider with ID "{provider}" could not be found.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-4 pb-20">
        <ProviderSettingsHeader
          providerDisplayName={providerDisplayName}
          isConfigured={
            // Atlarix Core (pay-as-you-go, no API key) and local runtimes are
            // always "set up" — there's nothing for the user to configure.
            provider === "ollama" ||
            provider === "lmstudio" ||
            provider === "compass"
              ? true
              : isConfigured || keyCheck?.status === "works"
          }
          keyCheck={keyCheck}
          isLoading={settingsLoading}
          hasFreeTier={hasFreeTier}
          providerWebsiteUrl={providerWebsiteUrl}
          onBackClick={() => router.history.back()}
        />

        {!secretsEncrypted && (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Keys stored without encryption</AlertTitle>
            <AlertDescription>
              No OS keystore is available, so provider API keys and sign-in
              tokens are saved unencrypted on this device. Install a system
              keyring (e.g. gnome-keyring / libsecret on Linux) and restart —
              Atlarix will re-encrypt them automatically.
            </AlertDescription>
          </Alert>
        )}

        {settingsLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : settingsError ? (
          <Alert variant="destructive">
            <AlertTitle>Error Loading Settings</AlertTitle>
            <AlertDescription>
              Could not load configuration data: {settingsError.message}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Ollama / LM Studio: Favorites only (no API key) */}
            {provider === "ollama" || provider === "lmstudio" ? (
              <div className="mt-6 space-y-4">
                <div>
                  <h3 className="font-medium mb-1">Models</h3>
                  <p className="text-sm text-muted-foreground">
                    Pick the model to use for chat.
                  </p>
                </div>
                <LocalProviderModelSelector
                  providerId={provider as "ollama" | "lmstudio"}
                />
              </div>
            ) : provider === "compass" ? (
              <CompassProviderSettings />
            ) : (
              <>
                <ApiKeyConfiguration
                  provider={provider}
                  providerDisplayName={providerDisplayName}
                  settings={settings}
                  envVars={envVars}
                  envVarName={envVarName}
                  isSaving={isSaving}
                  saveError={saveError}
                  apiKeyInput={apiKeyInput}
                  onApiKeyInputChange={setApiKeyInput}
                  onSaveKey={handleSaveKey}
                  onDeleteKey={handleDeleteKey}
                  updateSettings={updateSettings}
                />
                {/* Not for a key the provider just refused (QA #40). */}
                {offerDefaultSwitch &&
                  keyCheck?.status !== "rejected" &&
                  keyCheck?.status !== "unreachable" && (
                  <UseProviderAsDefaultPrompt
                    providerId={provider}
                    providerName={providerDisplayName}
                    onDismiss={() => setOfferDefaultSwitch(false)}
                  />
                )}
                {supportsTokenBudget(provider, providerData) && (
                  <TokenBudgetInput providerId={provider} />
                )}
              </>
            )}
          </>
        )}

        {supportsCustomModels && providerData && provider !== "compass" && (
          <ModelsSection providerId={providerData.id} />
        )}
        <div className="h-24"></div>
      </div>
    </div>
  );
}
