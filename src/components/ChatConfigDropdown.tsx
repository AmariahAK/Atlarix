/**
 * Single Config button opening a dropdown: MCP, Models & provider, Auto mode,
 * Delegation (Direct/Guided/Autonomous). Lucide icons only.
 *
 * Pass 7: Blueprint-in-prompt tier override removed with the Blueprint subsystem.
 */

import { useAtom } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { forceDeepThinkNextAtom } from "@/atoms/chatAtoms";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { IpcClient } from "@/ipc/ipc_client";
import { useEffect, useState } from "react";
import {
  buildAutoSettingsForProvider,
  getDefaultAutoSettingsPatchSync,
} from "@/lib/routing/auto-settings-defaults-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  SlidersHorizontal,
  Server,
  Cpu,
  Zap,
  MessageCircle,
  Crosshair,
  Bot,
  Layers,
  Brain,
} from "lucide-react";
import type { AgentMode, UserSettings } from "@/lib/schemas";
import { resolveContextBudgetTier } from "@/lib/routing/context_budget_routing";
import { PROVIDERS_THAT_SUPPORT_THINKING } from "@/ipc/shared/language_model_constants";
import { cn } from "@/lib/utils";
import { formatAutoTierLabel, useLastAutoRoutedTier } from "@/hooks/useLastAutoRoutedTier";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { displayLabelForCompassTier } from "@/lib/atlarix-core-catalog";
import { ATLARIX_CORE_CATEGORY_LABEL, isCompassTierId } from "@/shared/compass_product_copy";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Deep think toggle: Auto needs full tier triple; manual needs Thinking-tier model selection. */
function showDeepThinkNextToggle(settings: UserSettings | undefined | null): boolean {
  if (!settings?.selectedModel) return false;
  if (settings.autoModelRouting === true) {
    const pid = settings.autoProviderId;
    const ids = settings.autoModelIds;
    return Boolean(
      pid &&
      Array.isArray(ids) &&
      Boolean(ids[0]) &&
      Boolean(ids[1]) &&
      Boolean(ids[2]),
    );
  }
  if (resolveContextBudgetTier(settings.selectedModel, settings) === "thinking") {
    return true;
  }
  return PROVIDERS_THAT_SUPPORT_THINKING.includes(settings.selectedModel.provider);
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  compass: ATLARIX_CORE_CATEGORY_LABEL,
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  togetherai: "Together AI",
  mistral: "Mistral",
  xai: "xAI",
};

export function useModelDisplayName(): string {
  const { settings } = useSettings();
  const { data: catalog = [] } = useAtlarixCoreCatalog();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();

  const selectedModel = settings?.selectedModel;
  const autoOn = settings?.autoModelRouting === true;
  const autoProviderId = settings?.autoProviderId;

  // When Auto is ON, show the selected provider for Auto (not the manual model)
  if (autoOn) {
    if (autoProviderId) {
      const name = PROVIDER_DISPLAY_NAMES[autoProviderId] ?? (autoProviderId.charAt(0).toUpperCase() + autoProviderId.slice(1));
      return `${name} (Auto)`;
    }
    return "Auto (select provider)";
  }
  if (!selectedModel) return "—";
  if (selectedModel.provider === "auto") return "Auto";
  if (selectedModel.provider === "compass" || isCompassTierId(selectedModel.name)) {
    const found = modelsByProviders?.compass?.find(
      (m) => m.apiName === selectedModel.name,
    );
    return displayLabelForCompassTier(
      selectedModel.name,
      catalog,
      found?.displayName,
    );
  }
  if (selectedModel.provider === "ollama") {
    const found = ollamaModels.find((m) => m.modelName === selectedModel.name);
    return found?.displayName ?? selectedModel.name;
  }
  if (selectedModel.provider === "lmstudio") {
    const found = lmStudioModels.find((m) => m.modelName === selectedModel.name);
    return found?.displayName ?? selectedModel.name;
  }
  if (modelsByProviders?.[selectedModel.provider]) {
    const custom = modelsByProviders[selectedModel.provider].find(
      (m) => m.type === "custom" && m.id === selectedModel.customModelId
    );
    if (custom) return custom.displayName;
    const byApi = modelsByProviders[selectedModel.provider].find(
      (m) => m.apiName === selectedModel.name
    );
    if (byApi) return byApi.displayName;
  }
  return selectedModel.name;
}

export function ChatConfigDropdown({
  onOpenModelPicker,
  onOpenMcpTools,
  onOpenAutoConfig,
  hideManualModelControls = false,
}: {
  onOpenModelPicker?: () => void;
  onOpenMcpTools?: () => void;
  onOpenAutoConfig?: () => void;
  /** When Auto routing is on: hide provider/model pickers; use config “Configure Auto” for tiers. */
  hideManualModelControls?: boolean;
}) {
  const { settings, updateSettings } = useSettings();
  const modelDisplayName = useModelDisplayName();
  const { data: coreCatalog = [] } = useAtlarixCoreCatalog();
  const lastAutoTier = useLastAutoRoutedTier(null);
  const autoTierLabel = formatAutoTierLabel(
    lastAutoTier,
    coreCatalog,
    settings?.autoProviderId,
  );

  const agentMode = (settings?.agentMode ?? "guided") as AgentMode;
  const autoOn = settings?.autoModelRouting === true;
  const isAuto = settings?.selectedModel?.provider === "auto";
  const [forceDeepThinkNext, setForceDeepThinkNext] = useAtom(forceDeepThinkNextAtom);

  const [compassBuildOk, setCompassBuildOk] = useState(false);
  const [configuredProviderIds, setConfiguredProviderIds] = useState<string[]>([]);
  useEffect(() => {
    void IpcClient.getInstance()
      .isCompassBuildConfigured()
      .then(setCompassBuildOk)
      .catch(() => setCompassBuildOk(false));
    void IpcClient.getInstance()
      .getConfiguredProviders()
      .then(setConfiguredProviderIds)
      .catch(() => setConfiguredProviderIds([]));
  }, []);

  const { isProviderSetup } = useLanguageModelProviders();

  const ollamaFavs =
    (settings?.providerSettings?.ollama as { favoriteModelIds?: string[] })?.favoriteModelIds ?? [];
  const lmStudioFavs =
    (settings?.providerSettings?.lmstudio as { favoriteModelIds?: string[] })?.favoriteModelIds ?? [];
  const autoProviderId = settings?.autoProviderId ?? null;
  const autoModelIds = settings?.autoModelIds;
  const deepThinkVisible = showDeepThinkNextToggle(settings ?? null);

  const providersForAuto = [
    compassBuildOk && { id: "compass", name: ATLARIX_CORE_CATEGORY_LABEL },
    isProviderSetup("openrouter") && { id: "openrouter", name: "OpenRouter" },
    ollamaFavs.length >= 1 && { id: "ollama", name: "Ollama" },
    lmStudioFavs.length >= 1 && { id: "lmstudio", name: "LM Studio" },
    // Include current auto provider if it has tier model(s) configured and isn't already listed
    autoProviderId &&
      Array.isArray(autoModelIds) &&
      autoModelIds.filter(Boolean).length >= 1 &&
      !["compass", "openrouter", "ollama", "lmstudio"].includes(autoProviderId) && {
        id: autoProviderId,
        name: autoProviderId.charAt(0).toUpperCase() + autoProviderId.slice(1),
      },
  ].filter(Boolean) as { id: string; name: string }[];

  const hasEnoughFavoritesForAuto = providersForAuto.some((p) => p.id === autoProviderId);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              data-testid="chat-config-button"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          Config: MCP, model, Auto, delegation, Blueprint prompt
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
        sticky="partial"
        className="z-200 w-72 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto overflow-x-hidden p-0"
      >
        <div className="p-1">
          {/* MCP */}
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Server className="h-3.5 w-3.5" />
            MCP servers
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              onOpenMcpTools?.();
            }}
          >
            Manage MCP tools
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {hideManualModelControls ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Cpu className="h-3.5 w-3.5" />
                Auto routing
              </DropdownMenuLabel>
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {autoTierLabel ? `Last reply: ${autoTierLabel} tier.` : "Model is chosen per message."}{" "}
                Use <span className="font-medium text-foreground/90">Configure Auto</span> below to change provider or tier models.
              </p>
            </>
          ) : (
            <>
              {/* When Auto OFF: Model selection. When Auto ON: Provider selection (providers with ≥1 favorite, tiers seeded from favorites) */}
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Cpu className="h-3.5 w-3.5" />
                {autoOn ? "Provider (Auto)" : "Model"}
              </DropdownMenuLabel>
              {autoOn ? (
                <>
                  <div className="px-2 py-1.5">
                    <Select
                      value={hasEnoughFavoritesForAuto ? (autoProviderId ?? "") : ""}
                      onValueChange={(v) => {
                        updateSettings(buildAutoSettingsForProvider(v || null));
                      }}
                    >
                      <SelectTrigger className="h-8 w-full">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent position="popper" side="top" avoidCollisions collisionPadding={12}>
                        {providersForAuto.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {providersForAuto.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      Set at least 1 favorite model per provider in Settings to use Auto (we seed Fast/Medium/Thinking from your favorites).
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="px-2 py-1 text-sm text-foreground truncate" title={modelDisplayName}>
                    {modelDisplayName}
                  </div>
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      onOpenModelPicker?.();
                    }}
                  >
                    Change model
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}

          <DropdownMenuSeparator />

          {/* Auto mode */}
          <div className="flex items-center justify-between px-2 py-2">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm">Auto mode</span>
            </div>
            <Switch
              checked={autoOn}
              onCheckedChange={(checked) => {
                if (!checked) {
                  updateSettings({ autoModelRouting: false });
                  return;
                }
                if (!settings) return;
                const patch = getDefaultAutoSettingsPatchSync(settings, {
                  compassAvailable: compassBuildOk,
                  configuredProviderIds,
                });
                if (!patch) return;
                updateSettings({ autoModelRouting: true, ...patch });
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            Route by complexity across your three Auto models when ON.
          </p>
          {autoOn && onOpenAutoConfig && (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onOpenAutoConfig();
              }}
            >
              Configure Auto (provider + 3 models)
            </DropdownMenuItem>
          )}

          {deepThinkVisible ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Brain className="h-3.5 w-3.5" />
                Deep reasoning
              </DropdownMenuLabel>
              <div className="flex items-center justify-between px-2 py-2 gap-2">
                <span className="text-sm">Deep think next message</span>
                <Switch
                  checked={forceDeepThinkNext}
                  onCheckedChange={setForceDeepThinkNext}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <p className="px-2 pb-2 text-xs text-muted-foreground">
                {autoOn
                  ? "Next send uses your Thinking tier model instead of auto-routing for that turn."
                  : "Next send uses the full thinking-tier context budget for your current Thinking-tier model."}
              </p>
            </>
          ) : null}

          <DropdownMenuSeparator />

          {/* Delegation */}
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Delegation
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={agentMode}
            onValueChange={(value) => updateSettings({ agentMode: value as AgentMode })}
          >
            <DropdownMenuRadioItem value="direct" className="gap-2">
              <MessageCircle className="h-3.5 w-3.5" />
              Direct (no agents)
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="guided" className="gap-2">
              <Crosshair className="h-3.5 w-3.5" />
              Guided
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="autonomous" className="gap-2">
              <Bot className="h-3.5 w-3.5" />
              Autonomous
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          {/* Pass 7: Blueprint prompt-tier selector removed with Blueprint subsystem. */}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
