/**
 * Single Config button opening a dropdown: MCP, Models & provider, Auto mode,
 * Delegation (Direct/Guided/Autonomous), Self-Review. Lucide icons only.
 */

import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useFavoriteOpenRouterModels } from "@/hooks/useFavoriteOpenRouterModels";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SlidersHorizontal,
  Server,
  Cpu,
  Zap,
  MessageCircle,
  Crosshair,
  Bot,
  Eye,
} from "lucide-react";
import type { AgentMode } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
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

function useModelDisplayName(): string {
  const { settings } = useSettings();
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
}: {
  onOpenModelPicker?: () => void;
  onOpenMcpTools?: () => void;
  onOpenAutoConfig?: () => void;
}) {
  const { settings, updateSettings } = useSettings();
  const modelDisplayName = useModelDisplayName();

  const agentMode = (settings?.agentMode ?? "guided") as AgentMode;
  const autoOn = settings?.autoModelRouting === true;
  const isAuto = settings?.selectedModel?.provider === "auto";
  const selfReviewEnabled = settings?.aiConfiguration?.selfReview?.enabled ?? false;

  // When Auto is ON: only show providers that have at least 2 favorite models set
  const { data: openRouterFavorites = [] } = useFavoriteOpenRouterModels();
  const ollamaFavs =
    (settings?.providerSettings?.ollama as { favoriteModelIds?: string[] })?.favoriteModelIds ?? [];
  const lmStudioFavs =
    (settings?.providerSettings?.lmstudio as { favoriteModelIds?: string[] })?.favoriteModelIds ?? [];
  const autoProviderId = settings?.autoProviderId ?? null;
  const autoModelIds = settings?.autoModelIds;

  const providersForAuto = [
    openRouterFavorites.length >= 2 && { id: "openrouter", name: "OpenRouter" },
    ollamaFavs.length >= 2 && { id: "ollama", name: "Ollama" },
    lmStudioFavs.length >= 2 && { id: "lmstudio", name: "LM Studio" },
    // Include current auto provider if it has 2+ models and isn't already listed
    autoProviderId &&
      Array.isArray(autoModelIds) &&
      autoModelIds.length >= 2 &&
      !["openrouter", "ollama", "lmstudio"].includes(autoProviderId) && {
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
        <TooltipContent>Config: MCP, model, Auto, delegation, self-review</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-72" sideOffset={6}>
        <ScrollArea className="max-h-[70vh]">
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

          {/* When Auto OFF: Model selection. When Auto ON: Provider selection (only providers with ≥2 favs) */}
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
                    updateSettings({ autoProviderId: v || null, autoModelIds: undefined });
                  }}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue placeholder="Select provider" />
                  </SelectTrigger>
                  <SelectContent>
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
                  Set at least 2 favorite models per provider in Settings to use Auto.
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
                updateSettings({ autoModelRouting: checked });
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            Route by complexity (Fast/Medium/Thinking) when ON.
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

          <DropdownMenuSeparator />

          {/* Self-Review */}
          <div className="flex items-center justify-between px-2 py-2">
            <div className="flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm">Self-Review</span>
            </div>
            <Switch
              checked={selfReviewEnabled}
              onCheckedChange={(checked) => {
                const prev = settings?.aiConfiguration?.selfReview;
                updateSettings({
                  aiConfiguration: {
                    ...settings?.aiConfiguration,
                    selfReview: {
                      ...prev,
                      enabled: checked,
                      strategy: (prev?.strategy ?? "both") as "runtime" | "agentLightning" | "both",
                      maxIterations: prev?.maxIterations ?? 2,
                      qualityThreshold: prev?.qualityThreshold ?? 0.85,
                      reviewModel: (prev?.reviewModel ?? "fast") as "custom" | "same" | "fast",
                      criteria: prev?.criteria ?? ["completeness", "correctness", "clarity", "safety", "best_practices"],
                      showInActivityStream: prev?.showInActivityStream ?? true,
                    },
                  },
                });
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <p className="px-2 pb-2 text-xs text-muted-foreground">
            Quality check before replying. Configure in Settings.
          </p>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
