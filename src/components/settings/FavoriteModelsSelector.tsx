import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Star, X } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const MAX_FAVORITES = 3;

export function FavoriteModelsSelector() {
    const [favorites, setFavorites] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);

    const { data: modelsByProviders, isLoading: modelsLoading } = useLanguageModelsByProviders();
    const openrouterModels = modelsByProviders?.["openrouter"] || [];

    // Load favorites on mount
    useEffect(() => {
        const loadFavorites = async () => {
            try {
                const favoriteIds = await IpcClient.getInstance().getFavoriteOpenRouterModels();
                setFavorites(favoriteIds);
            } catch (error) {
                console.error("Failed to load favorites:", error);
            } finally {
                setIsLoading(false);
            }
        };
        loadFavorites();
    }, []);

    // Filter models by search query
    const filteredModels = openrouterModels.filter((model) =>
        model.displayName.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const toggleFavorite = async (modelId: string) => {
        const isFavorited = favorites.includes(modelId);

        if (isFavorited) {
            // Remove from favorites
            const newFavorites = favorites.filter((id) => id !== modelId);
            setFavorites(newFavorites);
            try {
                await IpcClient.getInstance().setFavoriteOpenRouterModels(newFavorites);
                toast.success("Removed from favorites");
            } catch (error) {
                console.error("Failed to remove favorite:", error);
                setFavorites(favorites); // Revert on error
                toast.error("Failed to update favorites");
            }
        } else {
            // Add to favorites
            if (favorites.length >= MAX_FAVORITES) {
                toast.error(`Maximum ${MAX_FAVORITES} favorites allowed`);
                return;
            }

            const newFavorites = [...favorites, modelId];
            setFavorites(newFavorites);
            try {
                await IpcClient.getInstance().setFavoriteOpenRouterModels(newFavorites);
                toast.success("Added to favorites");
            } catch (error) {
                console.error("Failed to add favorite:", error);
                setFavorites(favorites); // Revert on error
                toast.error("Failed to update favorites");
            }
        }
    };

    if (isLoading || modelsLoading) {
        return (
            <div className="flex items-center justify-center p-8">
                <p className="text-sm text-muted-foreground">Loading models...</p>
            </div>
        );
    }

    if (openrouterModels.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center p-8 space-y-2">
                <p className="text-sm text-muted-foreground">No OpenRouter models available</p>
                <p className="text-xs text-muted-foreground">
                    Please configure your OpenRouter API key above
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Selected Favorites Count */}
            <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                    Selected: {favorites.length} / {MAX_FAVORITES}
                </p>
                {favorites.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                            setFavorites([]);
                            try {
                                await IpcClient.getInstance().setFavoriteOpenRouterModels([]);
                                toast.success("Cleared all favorites");
                            } catch (error) {
                                console.error("Failed to clear favorites:", error);
                                toast.error("Failed to clear favorites");
                            }
                        }}
                    >
                        <X className="h-4 w-4 mr-1" />
                        Clear All
                    </Button>
                )}
            </div>

            {/* Selected Favorites Display */}
            {favorites.length > 0 && (
                <div className="space-y-2">
                    <div className="text-sm font-medium text-foreground">
                        Your Favorite Models
                    </div>
                    <div className="border rounded-lg p-3 bg-primary/5 space-y-2 max-h-[200px] overflow-y-auto">
                        {favorites.map((modelId, idx) => {
                            const model = openrouterModels.find((m) => m.apiName === modelId);
                            if (!model) return null;
                            const tierLabels = ["Fast", "Balanced", "Deep"];
                            const tierLabel = idx < 3 ? tierLabels[idx] : null;

                            return (
                                <div
                                    key={modelId}
                                    className="flex items-center justify-between gap-2 p-2 rounded-md bg-background hover:bg-accent/10 transition-colors"
                                >
                                    <div className="flex-1 min-w-0">
                                        <p className="font-medium text-sm truncate">{model.displayName}</p>
                                        {tierLabel && (
                                            <p className="text-[10px] text-muted-foreground">{tierLabel}</p>
                                        )}
                                        {model.description && (
                                            <p className="text-xs text-muted-foreground line-clamp-1">
                                                {model.description}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={async () => {
                                            const newFavorites = favorites.filter((id) => id !== modelId);
                                            setFavorites(newFavorites);
                                            try {
                                                await IpcClient.getInstance().setFavoriteOpenRouterModels(newFavorites);
                                                toast.success("Removed from favorites");
                                            } catch (error) {
                                                console.error("Failed to remove favorite:", error);
                                                setFavorites(favorites);
                                                toast.error("Failed to update favorites");
                                            }
                                        }}
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

            {/* Search Bar */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                    placeholder="Search all models..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10"
                />
            </div>

            {/* All Models List */}
            <div className="space-y-2">
                <div className="text-sm font-medium text-muted-foreground">
                    All Available Models ({filteredModels.length})
                </div>
                <ScrollArea className="h-[400px] border rounded-md">
                    <div className="p-2 space-y-1">
                        {filteredModels.length === 0 ? (
                            <div className="text-center py-8 text-sm text-muted-foreground">
                                No models found
                            </div>
                        ) : (
                            filteredModels.map((model) => {
                                const isFavorited = favorites.includes(model.apiName);
                                return (
                                    <button
                                        key={model.apiName}
                                        onClick={() => toggleFavorite(model.apiName)}
                                        className={cn(
                                            "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors",
                                            isFavorited && "bg-primary/10"
                                        )}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex-1 min-w-0">
                                                <p className="font-medium text-sm truncate">{model.displayName}</p>
                                                {model.description && (
                                                    <p className="text-xs text-muted-foreground line-clamp-1">
                                                        {model.description}
                                                    </p>
                                                )}
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
                            })
                        )}
                    </div>
                </ScrollArea>

                <p className="text-xs text-muted-foreground">
                    Favorites will appear first in the model picker when creating a new chat
                </p>
            </div>
        </div>
    );
}
