/**
 * LocalProviderFavoritesSelector - Select 3 favorites for Ollama or LM Studio
 * Fast / Balanced / Deep
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Star, X } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const MAX_FAVORITES = 3;
const TIER_LABELS = ["Fast", "Balanced", "Deep"];

interface LocalProviderFavoritesSelectorProps {
  providerId: "ollama" | "lmstudio";
  favorites: string[];
  onFavoritesChange: (ids: string[]) => void;
}

export function LocalProviderFavoritesSelector({
  providerId,
  favorites,
  onFavoritesChange,
}: LocalProviderFavoritesSelectorProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const ollama = useLocalModels();
  const lmStudio = useLocalLMSModels();

  const { models, loading, error, loadModels } =
    providerId === "ollama" ? ollama : lmStudio;

  useEffect(() => {
    loadModels();
  }, [loadModels, providerId]);

  const filteredModels = models.filter((model) =>
    (model.displayName || model.modelName).toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleFavorite = (modelId: string) => {
    const isFavorited = favorites.includes(modelId);

    if (isFavorited) {
      onFavoritesChange(favorites.filter((id) => id !== modelId));
    } else if (favorites.length < MAX_FAVORITES) {
      onFavoritesChange([...favorites, modelId]);
    } else {
      toast.error(`Maximum ${MAX_FAVORITES} favorites (Fast/Balanced/Deep)`);
    }
  };

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
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          Selected: {favorites.length} / {MAX_FAVORITES}
        </p>
        {favorites.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFavoritesChange([])}
          >
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {favorites.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Your Favorites</div>
          <div className="border rounded-lg p-3 bg-primary/5 space-y-2 max-h-[140px] overflow-y-auto">
            {favorites.map((modelId, idx) => {
              const model = models.find((m) => m.modelName === modelId);
              return (
                <div
                  key={modelId}
                  className="flex items-center justify-between gap-2 p-2 rounded-md bg-background"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">
                      {model?.displayName || modelId}
                    </p>
                    {idx < 3 && (
                      <p className="text-[10px] text-muted-foreground">
                        {TIER_LABELS[idx]}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onFavoritesChange(favorites.filter((f) => f !== modelId))}
                    className="h-8 px-2"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
              const isFavorited = favorites.includes(model.modelName);
              return (
                <button
                  key={model.modelName}
                  onClick={() => toggleFavorite(model.modelName)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors",
                    isFavorited && "bg-primary/10"
                  )}
                >
                  <div className="flex justify-between items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {model.displayName || model.modelName}
                      </p>
                    </div>
                    <Star
                      className={cn(
                        "h-4 w-4 flex-shrink-0",
                        isFavorited ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
                      )}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
        <p className="text-xs text-muted-foreground">
          Favorites appear first in the model picker. Select 3 for Fast / Balanced / Deep.
        </p>
      </div>
    </div>
  );
}
