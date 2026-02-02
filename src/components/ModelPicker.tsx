import { isAtlarixProEnabled, type LargeLanguageModel } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { useEffect, useState } from "react";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useFavoriteOpenRouterModels } from "@/hooks/useFavoriteOpenRouterModels";

import { LocalModel } from "@/ipc/ipc_types";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { PriceBadge } from "@/components/PriceBadge";
import { TURBO_MODELS } from "@/ipc/shared/language_model_constants";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import { OpenRouterModelsModal } from "@/components/OpenRouterModelsModal";

export function ModelPicker() {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const onModelSelect = (model: LargeLanguageModel) => {
    updateSettings({ selectedModel: model });
    // Invalidate token count when model changes since different models have different context windows
    // (technically they have different tokenizers, but we don't keep track of that).
    queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
  };

  const [open, setOpen] = useState(false);
  const [providersPage, setProvidersPage] = useState(0);
  const [modelsExpandedProviders, setModelsExpandedProviders] = useState<Set<string>>(new Set());
  const PROVIDERS_PER_PAGE = 5;
  const MODELS_PER_PAGE = 25;

  // Cloud models from providers
  const { data: modelsByProviders, isLoading: modelsByProvidersLoading } =
    useLanguageModelsByProviders();

  const { data: providers, isLoading: providersLoading } =
    useLanguageModelProviders();

  const loading = modelsByProvidersLoading || providersLoading;
  //  Local models from Ollama API, local LMStudio
  const {
    models: ollamaModels = [],
    loading: ollamaLoading,
    error: ollamaError,
    loadModels: loadOllamaModels,
  } = useLocalModels();

  const {
    models: lmStudioModels = [],
    loading: lmStudioLoading,
    error: lmStudioError,
    loadModels: loadLMStudioModels,
  } = useLocalLMSModels();

  // Favorite OpenRouter models
  const { data: favoriteModelIds = [] } = useFavoriteOpenRouterModels();

  // Local provider favorites (Ollama, LM Studio)
  const ollamaFavorites =
    (settings?.providerSettings?.ollama as { favoriteModelIds?: string[] })
      ?.favoriteModelIds ?? [];
  const lmStudioFavorites =
    (settings?.providerSettings?.lmstudio as { favoriteModelIds?: string[] })
      ?.favoriteModelIds ?? [];

  // Load local models when dropdown opens; reset pagination when closes
  useEffect(() => {
    if (open) {
      loadOllamaModels();
      loadLMStudioModels();
    } else {
      setProvidersPage(0);
      setModelsExpandedProviders(new Set());
    }
  }, [open, loadOllamaModels, loadLMStudioModels]);

  // Get display name for the selected model
  const getModelDisplayName = () => {
    if (selectedModel.provider === "auto") {
      return "Auto";
    }
    if (selectedModel.provider === "ollama") {
      return (
        ollamaModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name
      );
    }
    if (selectedModel.provider === "lmstudio") {
      return (
        lmStudioModels.find(
          (model: LocalModel) => model.modelName === selectedModel.name,
        )?.displayName || selectedModel.name // Fallback to path if not found
      );
    }

    // For cloud models, look up in the modelsByProviders data
    if (modelsByProviders && modelsByProviders[selectedModel.provider]) {
      const customFoundModel = modelsByProviders[selectedModel.provider].find(
        (model) =>
          model.type === "custom" && model.id === selectedModel.customModelId,
      );
      if (customFoundModel) {
        return customFoundModel.displayName;
      }
      const foundModel = modelsByProviders[selectedModel.provider].find(
        (model) => model.apiName === selectedModel.name,
      );
      if (foundModel) {
        return foundModel.displayName;
      }
    }

    // Fallback if not found
    return selectedModel.name;
  };

  // Get auto provider models (if any)
  const autoModels =
    !loading && modelsByProviders && modelsByProviders["auto"]
      ? modelsByProviders["auto"].filter((model) => {
        if (
          settings &&
          !isAtlarixProEnabled(settings) &&
          ["turbo", "value"].includes(model.apiName)
        ) {
          return false;
        }
        if (
          settings &&
          isAtlarixProEnabled(settings) &&
          model.apiName === "free"
        ) {
          return false;
        }
        return true;
      })
      : [];

  // Determine availability of local models
  const hasOllamaModels =
    !ollamaLoading && !ollamaError && ollamaModels.length > 0;
  const hasLMStudioModels =
    !lmStudioLoading && !lmStudioError && lmStudioModels.length > 0;

  if (!settings) {
    return null;
  }
  const selectedModel = settings?.selectedModel;
  const modelDisplayName = getModelDisplayName();
  // Split providers into primary and secondary groups (excluding auto)
  const providerEntries =
    !loading && modelsByProviders
      ? Object.entries(modelsByProviders).filter(
        ([providerId]) => providerId !== "auto",
      )
      : [];
  const primaryProviders = providerEntries.filter(([providerId, models]) => {
    // Always show OpenRouter even if 0 models (user needs to add API key)
    if (providerId === "openrouter") return true;
    if (models.length === 0) return false;
    const provider = providers?.find((p) => p.id === providerId);
    return !(provider && provider.secondary);
  });
  if (settings && isAtlarixProEnabled(settings)) {
    primaryProviders.unshift(["auto", TURBO_MODELS]);
  }
  const allPrimary = primaryProviders;
  const primaryProvidersPaginated = allPrimary.slice(
    0,
    (providersPage + 1) * PROVIDERS_PER_PAGE
  );
  const hasMoreProviders =
    allPrimary.length > primaryProvidersPaginated.length;
  const secondaryProviders = providerEntries.filter(([providerId, models]) => {
    if (models.length === 0) return false;
    const provider = providers?.find((p) => p.id === providerId);
    return !!(provider && provider.secondary);
  });

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="flex items-center gap-2 h-8 max-w-[130px] px-1.5 text-xs-sm"
              >
                <span className="truncate">
                  {modelDisplayName === "Models" && (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Model:
                      </span>{" "}
                    </>
                  )}
                  {modelDisplayName}
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{modelDisplayName}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          className="w-64 max-h-[min(80vh,500px)] flex flex-col"
          align="start"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <DropdownMenuLabel>Select Model</DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* Auto option - always visible; Pro enables smart routing, else uses first available model */}
          {settings && (
            <>
              <DropdownMenuItem
                className={
                  selectedModel.provider === "auto" ? "bg-secondary" : ""
                }
                onClick={() => {
                  const firstAuto = autoModels[0];
                  // Pro: use turbo/smart routing; non-Pro: use first auto model or "free" for OpenRouter free tier
                  const modelName =
                    firstAuto?.apiName ??
                    (isAtlarixProEnabled(settings) ? "turbo" : "free");
                  onModelSelect({
                    name: modelName,
                    provider: "auto",
                  });
                  setOpen(false);
                }}
              >
                <div className="flex flex-col items-start">
                  <span>Auto</span>
                  <span className="text-xs text-muted-foreground">
                    {isAtlarixProEnabled(settings)
                      ? "Smart model routing"
                      : "Use default model"}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}

          {/* Cloud models - loading state */}
          {loading ? (
            <div className="text-xs text-center py-2 text-muted-foreground">
              Loading models...
            </div>
          ) : !modelsByProviders ||
            Object.keys(modelsByProviders).length === 0 ? (
            <div className="text-xs text-center py-2 text-muted-foreground">
              No cloud models available
            </div>
          ) : (
            /* Cloud models loaded */
            <>
              {/* Auto models at top level if any */}
              {autoModels.length > 0 && (
                <>
                  {autoModels.map((model) => (
                    <Tooltip key={`auto-${model.apiName}`}>
                      <TooltipTrigger asChild>
                        <DropdownMenuItem
                          className={
                            selectedModel.provider === "auto" &&
                              selectedModel.name === model.apiName
                              ? "bg-secondary"
                              : ""
                          }
                          onClick={() => {
                            onModelSelect({
                              name: model.apiName,
                              provider: "auto",
                            });
                            setOpen(false);
                          }}
                        >
                          <div className="flex justify-between items-start w-full">
                            <span className="flex flex-col items-start">
                              <span>{model.displayName}</span>
                            </span>
                            <div className="flex items-center gap-1.5">
                              {model.tag && (
                                <span
                                  className={cn(
                                    "text-[11px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium",
                                    model.tagColor,
                                  )}
                                >
                                  {model.tag}
                                </span>
                              )}
                            </div>
                          </div>
                        </DropdownMenuItem>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {model.description}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  {Object.keys(modelsByProviders).length > 1 && (
                    <DropdownMenuSeparator />
                  )}
                </>
              )}

              {/* Primary providers (paginated) */}
              {primaryProvidersPaginated.map(([providerId, models]) => {
                // Special handling for OpenRouter
                if (providerId === "openrouter") {
                  // Get favorite models
                  const favoriteModels = models.filter((m) =>
                    favoriteModelIds.includes(m.apiName)
                  );

                  // If user has favorites, show them inline like Ollama/LMStudio
                  if (favoriteModels.length > 0) {
                    return (
                      <DropdownMenuSub key="openrouter">
                        <DropdownMenuSubTrigger className="w-full font-normal">
                          <div className="flex flex-col items-start w-full">
                            <div className="flex items-center gap-2">
                              <span>OpenRouter</span>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {favoriteModels.length} favorites
                            </span>
                          </div>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                          <DropdownMenuLabel>Favorite Models</DropdownMenuLabel>
                          <DropdownMenuSeparator />

                          {favoriteModels.map((model, idx) => {
                            const tierLabels = ["⚡ Fast", "⚖️ Balanced", "🧠 Deep"];
                            const tierLabel = idx < 3 ? tierLabels[idx] : null;
                            return (
                              <Tooltip key={`openrouter-fav-${model.apiName}`}>
                                <TooltipTrigger asChild>
                                  <DropdownMenuItem
                                    className={
                                      selectedModel.provider === "openrouter" &&
                                        selectedModel.name === model.apiName
                                        ? "bg-secondary"
                                        : ""
                                    }
                                    onClick={() => {
                                      onModelSelect({
                                        name: model.apiName,
                                        provider: "openrouter",
                                      });
                                      setOpen(false);
                                    }}
                                  >
                                    <div className="flex justify-between items-start w-full">
                                      <span className="flex flex-col items-start gap-0.5">
                                        <span>{model.displayName}</span>
                                        {tierLabel && (
                                          <span className="text-[10px] text-muted-foreground">
                                            {tierLabel}
                                          </span>
                                        )}
                                      </span>
                                      <div className="flex items-center gap-1.5">
                                        <PriceBadge dollarSigns={model.dollarSigns} />
                                      </div>
                                    </div>
                                  </DropdownMenuItem>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {model.description}
                                </TooltipContent>
                              </Tooltip>
                            );
                          })}

                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setIsModalOpen(true);
                              setOpen(false);
                            }}
                            className="font-medium"
                          >
                            Show All Models ({models.length})...
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    );
                  }

                  // No favorites: show button to open modal
                  return (
                    <DropdownMenuItem
                      key="openrouter"
                      onClick={() => {
                        setIsModalOpen(true);
                        setOpen(false);
                      }}
                      className="flex justify-between items-center"
                    >
                      <div className="flex flex-col items-start">
                        <span>OpenRouter</span>
                        <span className="text-xs text-muted-foreground">
                          {models.length} tool-calling models
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">→</span>
                    </DropdownMenuItem>
                  );
                }

                models = models.filter((model) => {
                  // Don't show free models if Atlarix Pro is enabled because
                  // we will use the paid models (in Atlarix Pro backend) which
                  // don't have the free limitations.
                  if (
                    isAtlarixProEnabled(settings) &&
                    model.apiName.endsWith(":free")
                  ) {
                    return false;
                  }
                  return true;
                });
                const provider = providers?.find((p) => p.id === providerId);
                const providerDisplayName =
                  provider?.id === "auto"
                    ? "Atlarix Turbo"
                    : (provider?.name ?? providerId);
                return (
                  <DropdownMenuSub key={providerId}>
                    <DropdownMenuSubTrigger className="w-full font-normal">
                      <div className="flex flex-col items-start w-full">
                        <div className="flex items-center gap-2">
                          <span>{providerDisplayName}</span>
                          {provider?.type === "cloud" &&
                            !provider?.secondary &&
                            isAtlarixProEnabled(settings) && (
                              <span className="text-[10px] bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-600 bg-[length:200%_100%] animate-[shimmer_5s_ease-in-out_infinite] text-white px-1.5 py-0.5 rounded-full font-medium">
                                Pro
                              </span>
                            )}
                          {provider?.type === "custom" && (
                            <span className="text-[10px] bg-amber-500/20 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                              Custom
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {models.length} models
                        </span>
                      </div>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                      <DropdownMenuLabel>
                        {providerDisplayName + " Models"}
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {(modelsExpandedProviders.has(providerId)
                        ? models
                        : models.slice(0, MODELS_PER_PAGE)
                      ).map((model) => (
                        <Tooltip key={`${providerId}-${model.apiName}`}>
                          <TooltipTrigger asChild>
                            <DropdownMenuItem
                              className={
                                selectedModel.provider === providerId &&
                                  selectedModel.name === model.apiName
                                  ? "bg-secondary"
                                  : ""
                              }
                              onClick={() => {
                                const customModelId =
                                  model.type === "custom" ? model.id : undefined;
                                onModelSelect({
                                  name: model.apiName,
                                  provider: providerId,
                                  customModelId,
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex justify-between items-start w-full">
                                <span>{model.displayName}</span>
                                <PriceBadge dollarSigns={model.dollarSigns} />
                                {model.tag && (
                                  <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                                    {model.tag}
                                  </span>
                                )}
                              </div>
                            </DropdownMenuItem>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            {model.description}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                      {!modelsExpandedProviders.has(providerId) &&
                        models.length > MODELS_PER_PAGE && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.preventDefault();
                              setModelsExpandedProviders((s) =>
                                new Set(s).add(providerId)
                              );
                            }}
                            className="font-medium text-muted-foreground justify-center"
                          >
                            Show more ({models.length - MODELS_PER_PAGE} more)
                          </DropdownMenuItem>
                        )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
              {hasMoreProviders && (
                <DropdownMenuItem
                  onClick={() => setProvidersPage((p) => p + 1)}
                  className="font-medium text-muted-foreground justify-center"
                >
                  Show more providers ({allPrimary.length - primaryProvidersPaginated.length} more)
                </DropdownMenuItem>
              )}

              {/* Secondary providers grouped under Other AI providers */}
              {secondaryProviders.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="w-full font-normal">
                    <div className="flex flex-col items-start">
                      <span>Other AI providers</span>
                      <span className="text-xs text-muted-foreground">
                        {secondaryProviders.length} providers
                      </span>
                    </div>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                    <DropdownMenuLabel>Other AI providers</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {secondaryProviders.map(([providerId, models]) => {
                      const provider = providers?.find(
                        (p) => p.id === providerId,
                      );
                      return (
                        <DropdownMenuSub key={providerId}>
                          <DropdownMenuSubTrigger className="w-full font-normal">
                            <div className="flex flex-col items-start w-full">
                              <div className="flex items-center gap-2">
                                <span>{provider?.name ?? providerId}</span>
                                {provider?.type === "custom" && (
                                  <span className="text-[10px] bg-amber-500/20 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">
                                    Custom
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {models.length} models
                              </span>
                            </div>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                            <DropdownMenuLabel>
                              {(provider?.name ?? providerId) + " Models"}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {(modelsExpandedProviders.has(providerId)
                              ? models
                              : models.slice(0, MODELS_PER_PAGE)
                            ).map((model) => (
                              <Tooltip key={`sec-${providerId}-${model.apiName}`}>
                                <TooltipTrigger asChild>
                                  <DropdownMenuItem
                                    className={
                                      selectedModel.provider === providerId &&
                                        selectedModel.name === model.apiName
                                        ? "bg-secondary"
                                        : ""
                                    }
                                    onClick={() => {
                                      const customModelId =
                                        model.type === "custom"
                                          ? model.id
                                          : undefined;
                                      onModelSelect({
                                        name: model.apiName,
                                        provider: providerId,
                                        customModelId,
                                      });
                                      setOpen(false);
                                    }}
                                  >
                                    <div className="flex justify-between items-start w-full">
                                      <span>{model.displayName}</span>
                                      {model.tag && (
                                        <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                                          {model.tag}
                                        </span>
                                      )}
                                    </div>
                                  </DropdownMenuItem>
                                </TooltipTrigger>
                                <TooltipContent side="right">
                                  {model.description}
                                </TooltipContent>
                              </Tooltip>
                            ))}
                            {!modelsExpandedProviders.has(providerId) &&
                              models.length > MODELS_PER_PAGE && (
                                <DropdownMenuItem
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setModelsExpandedProviders((s) =>
                                      new Set(s).add(providerId)
                                    );
                                  }}
                                  className="font-medium text-muted-foreground justify-center"
                                >
                                  Show more ({models.length - MODELS_PER_PAGE} more)
                                </DropdownMenuItem>
                              )}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      );
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </>
          )}

          <DropdownMenuSeparator />
          {/* Local Models Parent SubMenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="w-full font-normal">
              <div className="flex flex-col items-start">
                <span>Local models</span>
                <span className="text-xs text-muted-foreground">
                  LM Studio, Ollama
                </span>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
              {/* Ollama Models SubMenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={ollamaLoading && !hasOllamaModels}
                  className="w-full font-normal"
                >
                  <div className="flex flex-col items-start">
                    <span>Ollama</span>
                    {ollamaLoading ? (
                      <span className="text-xs text-muted-foreground">Loading...</span>
                    ) : ollamaError ? (
                      <span className="text-xs text-red-500">Error loading</span>
                    ) : !hasOllamaModels ? (
                      <span className="text-xs text-muted-foreground">None available</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {ollamaFavorites.length > 0
                          ? `${ollamaFavorites.length} favorites`
                          : `${ollamaModels.length} models`}
                      </span>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                  <DropdownMenuLabel>Ollama Models</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {ollamaLoading && ollamaModels.length === 0 ? (
                    <div className="text-xs text-center py-2 text-muted-foreground">
                      Loading models...
                    </div>
                  ) : ollamaError ? (
                    <div className="px-2 py-1.5 text-sm text-red-600">
                      <span>Error loading models. Is Ollama running?</span>
                    </div>
                  ) : !hasOllamaModels ? (
                    <div className="px-2 py-1.5 text-sm">
                      <span>No models found. Ensure Ollama is running.</span>
                    </div>
                  ) : (
                    <>
                      {ollamaFavorites
                        .map((id) => ollamaModels.find((m) => m.modelName === id))
                        .filter(Boolean)
                        .map((model, idx) => {
                          const tierLabels = ["⚡ Fast", "⚖️ Balanced", "🧠 Deep"];
                          return (
                            <DropdownMenuItem
                              key={`ollama-fav-${model!.modelName}`}
                              className={
                                selectedModel.provider === "ollama" &&
                                selectedModel.name === model!.modelName
                                  ? "bg-secondary"
                                  : ""
                              }
                              onClick={() => {
                                onModelSelect({
                                  name: model!.modelName,
                                  provider: "ollama",
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span>{model!.displayName}</span>
                                {idx < 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {tierLabels[idx]}
                                  </span>
                                )}
                              </div>
                            </DropdownMenuItem>
                          );
                        })}
                      {ollamaFavorites.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            All models
                          </div>
                        </>
                      )}
                      {ollamaModels
                        .filter((m) => !ollamaFavorites.includes(m.modelName))
                        .slice(0, 100)
                        .map((model: LocalModel) => (
                          <DropdownMenuItem
                            key={`ollama-${model.modelName}`}
                            className={
                              selectedModel.provider === "ollama" &&
                              selectedModel.name === model.modelName
                                ? "bg-secondary"
                                : ""
                            }
                            onClick={() => {
                              onModelSelect({
                                name: model.modelName,
                                provider: "ollama",
                              });
                              setOpen(false);
                            }}
                          >
                            <div className="flex flex-col">
                              <span>{model.displayName}</span>
                              <span className="text-xs text-muted-foreground truncate">
                                {model.modelName}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        ))}
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>

              {/* LM Studio Models SubMenu */}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  disabled={lmStudioLoading && !hasLMStudioModels}
                  className="w-full font-normal"
                >
                  <div className="flex flex-col items-start">
                    <span>LM Studio</span>
                    {lmStudioLoading ? (
                      <span className="text-xs text-muted-foreground">Loading...</span>
                    ) : lmStudioError ? (
                      <span className="text-xs text-red-500">Error loading</span>
                    ) : !hasLMStudioModels ? (
                      <span className="text-xs text-muted-foreground">None available</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {lmStudioFavorites.length > 0
                          ? `${lmStudioFavorites.length} favorites`
                          : `${lmStudioModels.length} models`}
                      </span>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56 max-h-[min(60vh,360px)] overflow-y-auto">
                  <DropdownMenuLabel>LM Studio Models</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {lmStudioLoading && lmStudioModels.length === 0 ? (
                    <div className="text-xs text-center py-2 text-muted-foreground">
                      Loading models...
                    </div>
                  ) : lmStudioError ? (
                    <div className="px-2 py-1.5 text-sm text-red-600">
                      <span>Error loading models. {lmStudioError.message}</span>
                    </div>
                  ) : !hasLMStudioModels ? (
                    <div className="px-2 py-1.5 text-sm">
                      <span>No models found. Ensure LM Studio is running.</span>
                    </div>
                  ) : (
                    <>
                      {lmStudioFavorites
                        .map((id) => lmStudioModels.find((m) => m.modelName === id))
                        .filter(Boolean)
                        .map((model, idx) => {
                          const tierLabels = ["⚡ Fast", "⚖️ Balanced", "🧠 Deep"];
                          return (
                            <DropdownMenuItem
                              key={`lmstudio-fav-${model!.modelName}`}
                              className={
                                selectedModel.provider === "lmstudio" &&
                                selectedModel.name === model!.modelName
                                  ? "bg-secondary"
                                  : ""
                              }
                              onClick={() => {
                                onModelSelect({
                                  name: model!.modelName,
                                  provider: "lmstudio",
                                });
                                setOpen(false);
                              }}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span>{model!.displayName}</span>
                                {idx < 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    {tierLabels[idx]}
                                  </span>
                                )}
                              </div>
                            </DropdownMenuItem>
                          );
                        })}
                      {lmStudioFavorites.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                            All models
                          </div>
                        </>
                      )}
                      {lmStudioModels
                        .filter((m) => !lmStudioFavorites.includes(m.modelName))
                        .slice(0, 100)
                        .map((model: LocalModel) => (
                          <DropdownMenuItem
                            key={`lmstudio-${model.modelName}`}
                            className={
                              selectedModel.provider === "lmstudio" &&
                              selectedModel.name === model.modelName
                                ? "bg-secondary"
                                : ""
                            }
                            onClick={() => {
                              onModelSelect({
                                name: model.modelName,
                                provider: "lmstudio",
                              });
                              setOpen(false);
                            }}
                          >
                            <div className="flex flex-col">
                              <span>{model.displayName}</span>
                              <span className="text-xs text-muted-foreground truncate">
                                {model.modelName}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        ))}
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* OpenRouter Models Modal */}
      <OpenRouterModelsModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSelectModel={(apiName) => {
          onModelSelect({
            name: apiName,
            provider: "openrouter",
          });
        }}
        models={modelsByProviders?.["openrouter"] || []}
        currentModelName={
          selectedModel.provider === "openrouter" ? selectedModel.name : undefined
        }
      />
    </>
  );
}
