/**
 * LocalProviderModelSelector - Pick the single active chat model for a local
 * provider (Ollama or LM Studio). Mirrors ModelsSection's "Use" pattern:
 * clicking a row sets settings.selectedModel and highlights the active model.
 */

import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, Search } from "lucide-react";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useSettings } from "@/hooks/useSettings";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import { cn } from "@/lib/utils";

interface LocalProviderModelSelectorProps {
  providerId: "ollama" | "lmstudio";
}

export function LocalProviderModelSelector({
  providerId,
}: LocalProviderModelSelectorProps) {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const ollama = useLocalModels();
  const lmStudio = useLocalLMSModels();

  const { models, loading, error, loadModels } =
    providerId === "ollama" ? ollama : lmStudio;

  useEffect(() => {
    loadModels();
  }, [loadModels, providerId]);

  const filteredModels = models.filter((model) =>
    (model.displayName || model.modelName)
      .toLowerCase()
      .includes(searchQuery.toLowerCase()),
  );

  const selectedModel = settings?.selectedModel;

  const applyAsChatModel = useCallback(
    async (modelName: string) => {
      await updateSettings({
        selectedModel: { provider: providerId, name: modelName },
      });
      queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
    },
    [providerId, queryClient, updateSettings],
  );

  if (loading && models.length === 0) {
    return (
      <div className="flex justify-center p-8">
        <p className="text-sm text-muted-foreground">
          Loading {providerId === "ollama" ? "Ollama" : "LM Studio"} models...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg border border-destructive/50 bg-destructive/10">
        <p className="text-sm text-destructive">
          {providerId === "ollama"
            ? "Ensure Ollama is running and models are pulled."
            : "Ensure LM Studio is running and models are loaded."}
        </p>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="p-4 rounded-lg border border-border">
        <p className="text-sm text-muted-foreground">
          No {providerId === "ollama" ? "Ollama" : "LM Studio"} models found.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search models..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium text-muted-foreground">
          All Models ({filteredModels.length})
        </div>
        <ScrollArea className="h-[280px] border rounded-md">
          <div className="p-2 space-y-1">
            {filteredModels.map((model) => {
              const isSelected =
                selectedModel?.provider === providerId &&
                selectedModel?.name === model.modelName;
              return (
                <button
                  key={model.modelName}
                  type="button"
                  onClick={() => void applyAsChatModel(model.modelName)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors flex items-center justify-between gap-2",
                    isSelected && "bg-secondary border border-primary",
                  )}
                >
                  <span className="font-medium text-sm truncate flex-1 min-w-0">
                    {model.displayName || model.modelName}
                  </span>
                  {isSelected ? (
                    <Check className="h-4 w-4 flex-shrink-0 text-primary" />
                  ) : (
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      Use
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
        <p className="text-xs text-muted-foreground">
          The selected model is used for chat with this provider.
        </p>
      </div>
    </div>
  );
}
