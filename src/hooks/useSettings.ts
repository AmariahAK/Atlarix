import { useState, useEffect, useCallback } from "react";
import { useAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import { userSettingsAtom, envVarsAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { type UserSettings } from "@/lib/schemas";
import { usePostHog } from "posthog-js/react";
import { useAppVersion } from "./useAppVersion";

const TELEMETRY_CONSENT_KEY = "atlarixTelemetryConsent";
const TELEMETRY_CONSENT_KEY_LEGACY = "dyadTelemetryConsent";
const TELEMETRY_USER_ID_KEY = "atlarixTelemetryUserId";
const TELEMETRY_USER_ID_KEY_LEGACY = "dyadTelemetryUserId";

export function isTelemetryOptedIn() {
  return (
    window.localStorage.getItem(TELEMETRY_CONSENT_KEY) === "opted_in" ||
    window.localStorage.getItem(TELEMETRY_CONSENT_KEY_LEGACY) === "opted_in"
  );
}

let isInitialLoad = false;

export function useSettings() {
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const [settings, setSettingsAtom] = useAtom(userSettingsAtom);
  const [envVars, setEnvVarsAtom] = useAtom(envVarsAtom);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const appVersion = useAppVersion();
  const loadInitialData = useCallback(async () => {
    setLoading(true);
    try {
      const ipcClient = IpcClient.getInstance();
      // Fetch settings and env vars concurrently
      const [userSettings, fetchedEnvVars] = await Promise.all([
        ipcClient.getUserSettings(),
        ipcClient.getEnvVars(),
      ]);
      processSettingsForTelemetry(userSettings);
      if (!isInitialLoad && appVersion) {
        posthog.capture("app_ui_ready", {
          appVersion,
        });
        isInitialLoad = true;
      }
      setSettingsAtom(userSettings);
      setEnvVarsAtom(fetchedEnvVars);
      setError(null);
    } catch (error) {
      console.error("Error loading initial data:", error);
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setLoading(false);
    }
  }, [setSettingsAtom, setEnvVarsAtom, appVersion]);

  useEffect(() => {
    // Only run once on mount, dependencies are stable getters/setters
    loadInitialData();
  }, [loadInitialData]);

  const updateSettings = async (newSettings: Partial<UserSettings>) => {
    setLoading(true);
    try {
      const ipcClient = IpcClient.getInstance();
      const updatedSettings = await ipcClient.setUserSettings(newSettings);
      setSettingsAtom(updatedSettings);
      processSettingsForTelemetry(updatedSettings);

      // Adding or removing a provider API key changes which models exist, but
      // the model lists are cached with a 5-minute staleTime and are only
      // invalidated by explicit events. Saving a key wasn't one of them — so a
      // provider you'd just configured stayed missing from the picker (and a
      // deleted one lingered) until the cache expired or something unrelated
      // refetched. Invalidate here, in the ONE place every provider form goes
      // through, rather than in each of them.
      if (newSettings.providerSettings !== undefined) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["language-models-by-providers"] }),
          queryClient.invalidateQueries({ queryKey: ["languageModelProviders"] }),
        ]);
      }

      setError(null);
      return updatedSettings;
    } catch (error) {
      console.error("Error updating settings:", error);
      setError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      setLoading(false);
    }
  };

  return {
    settings,
    envVars,
    loading,
    error,
    updateSettings,

    refreshSettings: () => {
      return loadInitialData();
    },
  };
}

function processSettingsForTelemetry(settings: UserSettings) {
  if (settings.telemetryConsent) {
    window.localStorage.setItem(
      TELEMETRY_CONSENT_KEY,
      settings.telemetryConsent,
    );
    window.localStorage.removeItem(TELEMETRY_CONSENT_KEY_LEGACY);
  } else {
    window.localStorage.removeItem(TELEMETRY_CONSENT_KEY);
    window.localStorage.removeItem(TELEMETRY_CONSENT_KEY_LEGACY);
  }
  if (settings.telemetryUserId) {
    window.localStorage.setItem(
      TELEMETRY_USER_ID_KEY,
      settings.telemetryUserId,
    );
    window.localStorage.removeItem(TELEMETRY_USER_ID_KEY_LEGACY);
  } else {
    window.localStorage.removeItem(TELEMETRY_USER_ID_KEY);
    window.localStorage.removeItem(TELEMETRY_USER_ID_KEY_LEGACY);
  }
}
