/**
 * Models & providers — the first thing a new user actually needs.
 *
 * This was the LAST block inside a Settings card called "AI Settings" that
 * opened with voice input, on a page that opened with the app version. So the
 * question "how do I point this at a model?" was the hardest thing on the page
 * to find. It is now the index of Integrations: connecting a model is the most
 * common reason to come here.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { ProviderSettingsGrid } from "@/components/ProviderSettings";

export function IntegrationsProvidersPage() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  useLanguageModelProviders();

  const handleRefreshModels = async () => {
    setIsRefreshing(true);
    try {
      const result = await IpcClient.getInstance().refreshModelsDev();
      if (result.success) {
        await queryClient.invalidateQueries({
          queryKey: ["language-models-by-providers"],
        });
        showSuccess("Model list refreshed");
      } else {
        showError("Failed to refresh model list");
      }
    } catch {
      showError("Failed to refresh model list");
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <div className="flex items-center justify-between gap-4 mb-3">
        <h2 className="text-lg font-medium text-foreground">
          Models &amp; providers
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefreshModels}
          disabled={isRefreshing}
        >
          {isRefreshing ? "Refreshing..." : "Refresh model list"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Atlarix Core needs no key. Add your own for any other provider.
      </p>
      <ProviderSettingsGrid />
    </div>
  );
}
