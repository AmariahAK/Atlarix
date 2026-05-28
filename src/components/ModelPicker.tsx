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
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { LanguageModel, LocalModel } from "@/ipc/ipc_types";
import { useConfiguredProviders } from "@/hooks/useConfiguredProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { PriceBadge } from "@/components/PriceBadge";
import { TURBO_MODELS } from "@/ipc/shared/language_model_constants";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import { useAuth } from "@/lib/auth/useAuth";
import { filterCompassModelsForPlan } from "@/lib/compass-plan-access";
import { IpcClient } from "@/ipc/ipc_client";

import { ATLARIX_CORE_CATEGORY_LABEL } from "@/shared/compass_product_copy";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { displayLabelForCompassTier } from "@/lib/atlarix-core-catalog";

const MODELS_PAGE_SIZE = 20;

function filterLanguageModels(
  models: LanguageModel[],
  query: string,
): LanguageModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.displayName.toLowerCase().includes(q) ||
      m.apiName.toLowerCase().includes(q) ||
      (m.description && m.description.toLowerCase().includes(q)),
  );
}

function filterLocalModels(models: LocalModel[], query: string): LocalModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      (m.displayName || "").toLowerCase().includes(q) ||
      m.modelName.toLowerCase().includes(q),
  );
}

export function ModelPicker() {
  const { settings, updateSettings } = useSettings();
  const { data: coreCatalog = [] } = useAtlarixCoreCatalog();
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const onModelSelect = (model: LargeLanguageModel) => {
    updateSettings({ selectedModel: model });
    // Invalidate token count when model changes since different models have different context windows
    // (technically they have different tokenizers, but we don't keep track of that).
    queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
  };

  const [open, setOpen] = useState(false);
  const { data: configuredProviderIds = [] } = useConfiguredProviders();
  const [compassBuildOk, setCompassBuildOk] = useState(false);
  useEffect(() => {
    void IpcClient.getInstance()
      .isCompassBuildConfigured()
      .then(setCompassBuildOk)
      .catch(() => setCompassBuildOk(false));
  }, []);
  const [providersPage, setProvidersPage] = useState(0);
  const [cloudModelSearch, setCloudModelSearch] = useState<Record<string, string>>({});
  const [cloudModelPage, setCloudModelPage] = useState<Record<string, number>>({});
  const [compassModelSearch, setCompassModelSearch] = useState("");
  const [compassModelPage, setCompassModelPage] = useState(0);
  const [ollamaListSearch, setOllamaListSearch] = useState("");
  const [ollamaListPage, setOllamaListPage] = useState(0);
  const [lmStudioListSearch, setLmStudioListSearch] = useState("");
  const [lmStudioListPage, setLmStudioListPage] = useState(0);
  const PROVIDERS_PER_PAGE = 5;

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
      setCloudModelSearch({});
      setCloudModelPage({});
      setCompassModelSearch("");
      setCompassModelPage(0);
      setOllamaListSearch("");
      setOllamaListPage(0);
      setLmStudioListSearch("");
      setLmStudioListPage(0);
    }
  }, [open, loadOllamaModels, loadLMStudioModels]);

  // Get display name for the selected model
  const getModelDisplayName = () => {
    if (selectedModel.provider === "compass") {
      const cm = modelsByProviders?.compass?.find(
        (m) => m.apiName === selectedModel.name,
      );
      return displayLabelForCompassTier(
        selectedModel.name,
        coreCatalog,
        cm?.displayName,
      );
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
    if (providerId === "compass") return true;
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
              {/* Primary providers (paginated) */}
              {primaryProvidersPaginated.map(([providerId, models]) => {
                if (providerId === "compass") {
                  const plan = status?.plan ?? "free";
                  const compassModels = filterCompassModelsForPlan(
                    models,
                    plan === "workforce"
                      ? "workforce"
                      : plan === "pro"
                        ? "pro"
                        : "free",
                  );
                  const compassFiltered = filterLanguageModels(
                    compassModels,
                    compassModelSearch,
                  );
                  const compassTotalPages = Math.max(
                    1,
                    Math.ceil(compassFiltered.length / MODELS_PAGE_SIZE),
                  );
                  const compassSafePage = Math.min(
                    compassModelPage,
                    compassTotalPages - 1,
                  );
                  const compassSlice = compassFiltered.slice(
                    compassSafePage * MODELS_PAGE_SIZE,
                    (compassSafePage + 1) * MODELS_PAGE_SIZE,
                  );
                  return (
                    <DropdownMenuSub key="compass">
                      <DropdownMenuSubTrigger className="w-full font-normal">
                        <div className="flex flex-col items-start w-full">
                          <span>{ATLARIX_CORE_CATEGORY_LABEL}</span>
                          <span className="text-xs text-muted-foreground">
                            Managed models · monthly quota
                          </span>
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-72 max-h-[min(72vh,420px)] flex flex-col p-0 overflow-hidden">
                        <div className="px-2 pt-2">
                          <DropdownMenuLabel className="px-0">
                            {ATLARIX_CORE_CATEGORY_LABEL}
                          </DropdownMenuLabel>
                        </div>
                        <div
                          className="px-2 py-1.5 border-b border-border"
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                            <Input
                              className="h-8 pl-8 text-xs"
                              placeholder="Search models..."
                              value={compassModelSearch}
                              onChange={(e) => {
                                setCompassModelSearch(e.target.value);
                                setCompassModelPage(0);
                              }}
                            />
                          </div>
                        </div>
                        <div className="overflow-y-auto flex-1 min-h-0 max-h-[240px]">
                          {compassSlice.length === 0 ? (
                            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                              No matches
                            </div>
                          ) : (
                            compassSlice.map((model) => (
                              <DropdownMenuItem
                                key={`compass-${model.apiName}`}
                                className={
                                  selectedModel.provider === "compass" &&
                                  selectedModel.name === model.apiName
                                    ? "bg-secondary"
                                    : ""
                                }
                                onClick={() => {
                                  onModelSelect({
                                    name: model.apiName,
                                    provider: "compass",
                                  });
                                  setOpen(false);
                                }}
                              >
                                <div className="flex flex-col items-start gap-0.5 w-full">
                                  <span>{model.displayName}</span>
                                  <span className="text-[10px] text-muted-foreground line-clamp-2">
                                    {model.description}
                                  </span>
                                </div>
                              </DropdownMenuItem>
                            ))
                          )}
                        </div>
                        {compassTotalPages > 1 ? (
                          <div
                            className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border bg-popover shrink-0"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-[10px] px-2"
                              disabled={compassSafePage <= 0}
                              onClick={(e) => {
                                e.preventDefault();
                                setCompassModelPage((p) =>
                                  Math.max(
                                    0,
                                    Math.min(p, compassTotalPages - 1) - 1,
                                  ),
                                );
                              }}
                            >
                              Prev
                            </Button>
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {compassSafePage + 1} / {compassTotalPages}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 text-[10px] px-2"
                              disabled={
                                compassSafePage >= compassTotalPages - 1
                              }
                              onClick={(e) => {
                                e.preventDefault();
                                setCompassModelPage((p) =>
                                  Math.min(
                                    compassTotalPages - 1,
                                    Math.min(p, compassTotalPages - 1) + 1,
                                  ),
                                );
                              }}
                            >
                              Next
                            </Button>
                          </div>
                        ) : null}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
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
                const cloudFiltered = filterLanguageModels(
                  models,
                  cloudModelSearch[providerId] ?? "",
                );
                const cloudTotalPages = Math.max(
                  1,
                  Math.ceil(cloudFiltered.length / MODELS_PAGE_SIZE),
                );
                const cloudSafePage = Math.min(
                  cloudModelPage[providerId] ?? 0,
                  cloudTotalPages - 1,
                );
                const cloudSlice = cloudFiltered.slice(
                  cloudSafePage * MODELS_PAGE_SIZE,
                  (cloudSafePage + 1) * MODELS_PAGE_SIZE,
                );
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
                    <DropdownMenuSubContent className="w-72 max-h-[min(72vh,420px)] flex flex-col p-0 overflow-hidden">
                      <div className="px-2 pt-2 pb-1">
                        <DropdownMenuLabel className="px-0">
                          {providerDisplayName + " Models"}
                        </DropdownMenuLabel>
                      </div>
                      <div
                        className="px-2 pb-2 border-b border-border"
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                          <Input
                            className="h-8 pl-8 text-xs"
                            placeholder="Search models..."
                            value={cloudModelSearch[providerId] ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setCloudModelSearch((s) => ({
                                ...s,
                                [providerId]: v,
                              }));
                              setCloudModelPage((p) => ({
                                ...p,
                                [providerId]: 0,
                              }));
                            }}
                          />
                        </div>
                      </div>
                      <div className="overflow-y-auto flex-1 min-h-0 max-h-[280px]">
                        {cloudSlice.length === 0 ? (
                          <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                            No matches
                          </div>
                        ) : (
                          cloudSlice.map((model) => (
                            <DropdownMenuItem
                              key={`${providerId}-${model.apiName}`}
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
                              <div className="flex justify-between items-start w-full gap-2">
                                <span className="flex flex-col items-start min-w-0">
                                  <span>{model.displayName}</span>
                                  {model.description ? (
                                    <span className="text-[10px] text-muted-foreground line-clamp-2">
                                      {model.description}
                                    </span>
                                  ) : null}
                                </span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <PriceBadge
                                    dollarSigns={model.dollarSigns}
                                  />
                                  {model.tag && (
                                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                                      {model.tag}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </DropdownMenuItem>
                          ))
                        )}
                      </div>
                      {cloudTotalPages > 1 ? (
                        <div
                          className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border bg-popover shrink-0"
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] px-2"
                            disabled={cloudSafePage <= 0}
                            onClick={(e) => {
                              e.preventDefault();
                              setCloudModelPage((prev) => {
                                const cur = Math.min(
                                  prev[providerId] ?? 0,
                                  cloudTotalPages - 1,
                                );
                                return {
                                  ...prev,
                                  [providerId]: Math.max(0, cur - 1),
                                };
                              });
                            }}
                          >
                            Prev
                          </Button>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {cloudSafePage + 1} / {cloudTotalPages}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-[10px] px-2"
                            disabled={cloudSafePage >= cloudTotalPages - 1}
                            onClick={(e) => {
                              e.preventDefault();
                              setCloudModelPage((prev) => {
                                const cur = Math.min(
                                  prev[providerId] ?? 0,
                                  cloudTotalPages - 1,
                                );
                                return {
                                  ...prev,
                                  [providerId]: Math.min(
                                    cloudTotalPages - 1,
                                    cur + 1,
                                  ),
                                };
                              });
                            }}
                          >
                            Next
                          </Button>
                        </div>
                      ) : null}
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
                    {secondaryProviders.map(([providerId, rawModels]) => {
                      let models = rawModels.filter((model) => {
                        if (
                          isAtlarixProEnabled(settings) &&
                          model.apiName.endsWith(":free")
                        ) {
                          return false;
                        }
                        return true;
                      });
                      const provider = providers?.find(
                        (p) => p.id === providerId,
                      );
                      const secDisplayName = provider?.name ?? providerId;
                      const secFiltered = filterLanguageModels(
                        models,
                        cloudModelSearch[providerId] ?? "",
                      );
                      const secTotalPages = Math.max(
                        1,
                        Math.ceil(secFiltered.length / MODELS_PAGE_SIZE),
                      );
                      const secSafePage = Math.min(
                        cloudModelPage[providerId] ?? 0,
                        secTotalPages - 1,
                      );
                      const secSlice = secFiltered.slice(
                        secSafePage * MODELS_PAGE_SIZE,
                        (secSafePage + 1) * MODELS_PAGE_SIZE,
                      );
                      return (
                        <DropdownMenuSub key={providerId}>
                          <DropdownMenuSubTrigger className="w-full font-normal">
                            <div className="flex flex-col items-start w-full">
                              <div className="flex items-center gap-2">
                                <span>{secDisplayName}</span>
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
                          <DropdownMenuSubContent className="w-72 max-h-[min(72vh,420px)] flex flex-col p-0 overflow-hidden">
                            <div className="px-2 pt-2 pb-1">
                              <DropdownMenuLabel className="px-0">
                                {secDisplayName + " Models"}
                              </DropdownMenuLabel>
                            </div>
                            <div
                              className="px-2 pb-2 border-b border-border"
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div className="relative">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                                <Input
                                  className="h-8 pl-8 text-xs"
                                  placeholder="Search models..."
                                  value={cloudModelSearch[providerId] ?? ""}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setCloudModelSearch((s) => ({
                                      ...s,
                                      [providerId]: v,
                                    }));
                                    setCloudModelPage((p) => ({
                                      ...p,
                                      [providerId]: 0,
                                    }));
                                  }}
                                />
                              </div>
                            </div>
                            <div className="overflow-y-auto flex-1 min-h-0 max-h-[280px]">
                              {secSlice.length === 0 ? (
                                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                  No matches
                                </div>
                              ) : (
                                secSlice.map((model) => (
                                  <DropdownMenuItem
                                    key={`sec-${providerId}-${model.apiName}`}
                                    className={
                                      selectedModel.provider ===
                                        providerId &&
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
                                    <div className="flex justify-between items-start w-full gap-1">
                                      <span className="flex flex-col min-w-0">
                                        <span className="truncate">
                                          {model.displayName}
                                        </span>
                                        {model.description ? (
                                          <span className="text-[10px] text-muted-foreground line-clamp-2">
                                            {model.description}
                                          </span>
                                        ) : null}
                                      </span>
                                      <div className="flex items-center gap-1 shrink-0">
                                        <PriceBadge
                                          dollarSigns={
                                            "dollarSigns" in model
                                              ? model.dollarSigns
                                              : undefined
                                          }
                                        />
                                        {model.tag && (
                                          <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
                                            {model.tag}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </DropdownMenuItem>
                                ))
                              )}
                            </div>
                            {secTotalPages > 1 ? (
                              <div
                                className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border bg-popover shrink-0"
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-[10px] px-2"
                                  disabled={secSafePage <= 0}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setCloudModelPage((prev) => {
                                      const cur = Math.min(
                                        prev[providerId] ?? 0,
                                        secTotalPages - 1,
                                      );
                                      return {
                                        ...prev,
                                        [providerId]: Math.max(0, cur - 1),
                                      };
                                    });
                                  }}
                                >
                                  Prev
                                </Button>
                                <span className="text-[10px] text-muted-foreground tabular-nums">
                                  {secSafePage + 1} / {secTotalPages}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-[10px] px-2"
                                  disabled={
                                    secSafePage >= secTotalPages - 1
                                  }
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setCloudModelPage((prev) => {
                                      const cur = Math.min(
                                        prev[providerId] ?? 0,
                                        secTotalPages - 1,
                                      );
                                      return {
                                        ...prev,
                                        [providerId]: Math.min(
                                          secTotalPages - 1,
                                          cur + 1,
                                        ),
                                      };
                                    });
                                  }}
                                >
                                  Next
                                </Button>
                              </div>
                            ) : null}
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
                <DropdownMenuSubContent className="w-72 max-h-[min(72vh,440px)] flex flex-col p-0 overflow-hidden">
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
                    (() => {
                      const ollamaRest = ollamaModels.filter(
                        (m) => !ollamaFavorites.includes(m.modelName),
                      );
                      const ollamaFiltered = filterLocalModels(
                        ollamaRest,
                        ollamaListSearch,
                      );
                      const ollamaTotalPages = Math.max(
                        1,
                        Math.ceil(ollamaFiltered.length / MODELS_PAGE_SIZE),
                      );
                      const ollamaSafePage = Math.min(
                        ollamaListPage,
                        ollamaTotalPages - 1,
                      );
                      const ollamaSlice = ollamaFiltered.slice(
                        ollamaSafePage * MODELS_PAGE_SIZE,
                        (ollamaSafePage + 1) * MODELS_PAGE_SIZE,
                      );
                      return (
                        <>
                          <div
                            className="px-2 pt-2 pb-2 border-b border-border"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <DropdownMenuLabel className="px-0">
                              Ollama — routing slots
                            </DropdownMenuLabel>
                            <table className="w-full text-xs mt-1">
                              <tbody>
                                {(["Slot 1", "Slot 2", "Slot 3"] as const).map((label, idx) => {
                                  const id = ollamaFavorites[idx];
                                  const m = id
                                    ? ollamaModels.find(
                                        (om) => om.modelName === id,
                                      )
                                    : null;
                                  const isSel =
                                    selectedModel.provider === "ollama" &&
                                    !!id &&
                                    selectedModel.name === id;
                                  return (
                                    <tr
                                      key={label}
                                      className={cn(
                                        isSel && "bg-secondary/60 rounded-sm",
                                      )}
                                    >
                                      <td className="py-1 pr-1 font-medium text-muted-foreground align-middle w-16">
                                        {label}
                                      </td>
                                      <td className="py-1 pr-1 align-middle min-w-0 max-w-[12rem]">
                                        {m ? (
                                          <button
                                            type="button"
                                            className="text-left truncate w-full hover:underline"
                                            onClick={() => {
                                              onModelSelect({
                                                name: m.modelName,
                                                provider: "ollama",
                                              });
                                              setOpen(false);
                                            }}
                                          >
                                            {m.displayName || m.modelName}
                                          </button>
                                        ) : (
                                          <span className="text-muted-foreground">
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-1 w-7 align-middle text-right">
                                        {id ? (
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 shrink-0"
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              void updateSettings({
                                                providerSettings: {
                                                  ...settings?.providerSettings,
                                                  ollama: {
                                                    ...(settings
                                                      ?.providerSettings
                                                      ?.ollama as object),
                                                    favoriteModelIds:
                                                      ollamaFavorites.filter(
                                                        (_, i) => i !== idx,
                                                      ),
                                                  },
                                                },
                                              });
                                            }}
                                            aria-label={`Remove ${label} favorite`}
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </Button>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <p className="text-[10px] text-muted-foreground mt-1.5">
                              Add favorites in Settings → Providers → Ollama (up
                              to 3).
                            </p>
                          </div>
                          <div
                            className="px-2 py-1.5 border-b border-border"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <div className="relative">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                              <Input
                                className="h-8 pl-8 text-xs"
                                placeholder="Search models..."
                                value={ollamaListSearch}
                                onChange={(e) => {
                                  setOllamaListSearch(e.target.value);
                                  setOllamaListPage(0);
                                }}
                              />
                            </div>
                          </div>
                          <div className="overflow-y-auto flex-1 min-h-0 max-h-[220px]">
                            {ollamaSlice.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No matches
                              </div>
                            ) : (
                              ollamaSlice.map((model: LocalModel) => (
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
                              ))
                            )}
                          </div>
                          {ollamaTotalPages > 1 ? (
                            <div
                              className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border bg-popover shrink-0"
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] px-2"
                                disabled={ollamaSafePage <= 0}
                                onClick={(e) => {
                                  e.preventDefault();
                                  setOllamaListPage((p) =>
                                    Math.max(
                                      0,
                                      Math.min(p, ollamaTotalPages - 1) - 1,
                                    ),
                                  );
                                }}
                              >
                                Prev
                              </Button>
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {ollamaSafePage + 1} / {ollamaTotalPages}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] px-2"
                                disabled={
                                  ollamaSafePage >= ollamaTotalPages - 1
                                }
                                onClick={(e) => {
                                  e.preventDefault();
                                  setOllamaListPage((p) =>
                                    Math.min(
                                      ollamaTotalPages - 1,
                                      Math.min(p, ollamaTotalPages - 1) + 1,
                                    ),
                                  );
                                }}
                              >
                                Next
                              </Button>
                            </div>
                          ) : null}
                        </>
                      );
                    })()
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
                <DropdownMenuSubContent className="w-72 max-h-[min(72vh,440px)] flex flex-col p-0 overflow-hidden">
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
                    (() => {
                      const lmRest = lmStudioModels.filter(
                        (m) => !lmStudioFavorites.includes(m.modelName),
                      );
                      const lmFiltered = filterLocalModels(
                        lmRest,
                        lmStudioListSearch,
                      );
                      const lmTotalPages = Math.max(
                        1,
                        Math.ceil(lmFiltered.length / MODELS_PAGE_SIZE),
                      );
                      const lmSafePage = Math.min(
                        lmStudioListPage,
                        lmTotalPages - 1,
                      );
                      const lmSlice = lmFiltered.slice(
                        lmSafePage * MODELS_PAGE_SIZE,
                        (lmSafePage + 1) * MODELS_PAGE_SIZE,
                      );
                      return (
                        <>
                          <div
                            className="px-2 pt-2 pb-2 border-b border-border"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <DropdownMenuLabel className="px-0">
                              LM Studio — routing slots
                            </DropdownMenuLabel>
                            <table className="w-full text-xs mt-1">
                              <tbody>
                                {(["Slot 1", "Slot 2", "Slot 3"] as const).map((label, idx) => {
                                  const id = lmStudioFavorites[idx];
                                  const m = id
                                    ? lmStudioModels.find(
                                        (om) => om.modelName === id,
                                      )
                                    : null;
                                  const isSel =
                                    selectedModel.provider === "lmstudio" &&
                                    !!id &&
                                    selectedModel.name === id;
                                  return (
                                    <tr
                                      key={label}
                                      className={cn(
                                        isSel && "bg-secondary/60 rounded-sm",
                                      )}
                                    >
                                      <td className="py-1 pr-1 font-medium text-muted-foreground align-middle w-16">
                                        {label}
                                      </td>
                                      <td className="py-1 pr-1 align-middle min-w-0 max-w-[12rem]">
                                        {m ? (
                                          <button
                                            type="button"
                                            className="text-left truncate w-full hover:underline"
                                            onClick={() => {
                                              onModelSelect({
                                                name: m.modelName,
                                                provider: "lmstudio",
                                              });
                                              setOpen(false);
                                            }}
                                          >
                                            {m.displayName || m.modelName}
                                          </button>
                                        ) : (
                                          <span className="text-muted-foreground">
                                            —
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-1 w-7 align-middle text-right">
                                        {id ? (
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 shrink-0"
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              void updateSettings({
                                                providerSettings: {
                                                  ...settings?.providerSettings,
                                                  lmstudio: {
                                                    ...(settings
                                                      ?.providerSettings
                                                      ?.lmstudio as object),
                                                    favoriteModelIds:
                                                      lmStudioFavorites.filter(
                                                        (_, i) => i !== idx,
                                                      ),
                                                  },
                                                },
                                              });
                                            }}
                                            aria-label={`Remove ${label} favorite`}
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </Button>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            <p className="text-[10px] text-muted-foreground mt-1.5">
                              Add favorites in Settings → Providers → LM Studio
                              (up to 3).
                            </p>
                          </div>
                          <div
                            className="px-2 py-1.5 border-b border-border"
                            onPointerDown={(e) => e.stopPropagation()}
                          >
                            <div className="relative">
                              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                              <Input
                                className="h-8 pl-8 text-xs"
                                placeholder="Search models..."
                                value={lmStudioListSearch}
                                onChange={(e) => {
                                  setLmStudioListSearch(e.target.value);
                                  setLmStudioListPage(0);
                                }}
                              />
                            </div>
                          </div>
                          <div className="overflow-y-auto flex-1 min-h-0 max-h-[220px]">
                            {lmSlice.length === 0 ? (
                              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                No matches
                              </div>
                            ) : (
                              lmSlice.map((model: LocalModel) => (
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
                              ))
                            )}
                          </div>
                          {lmTotalPages > 1 ? (
                            <div
                              className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border bg-popover shrink-0"
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] px-2"
                                disabled={lmSafePage <= 0}
                                onClick={(e) => {
                                  e.preventDefault();
                                  setLmStudioListPage((p) =>
                                    Math.max(
                                      0,
                                      Math.min(p, lmTotalPages - 1) - 1,
                                    ),
                                  );
                                }}
                              >
                                Prev
                              </Button>
                              <span className="text-[10px] text-muted-foreground tabular-nums">
                                {lmSafePage + 1} / {lmTotalPages}
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 text-[10px] px-2"
                                disabled={lmSafePage >= lmTotalPages - 1}
                                onClick={(e) => {
                                  e.preventDefault();
                                  setLmStudioListPage((p) =>
                                    Math.min(
                                      lmTotalPages - 1,
                                      Math.min(p, lmTotalPages - 1) + 1,
                                    ),
                                  );
                                }}
                              >
                                Next
                              </Button>
                            </div>
                          ) : null}
                        </>
                      );
                    })()
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

    </>
  );
}
