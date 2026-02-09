/**
 * Single Config button opening a dropdown: MCP, Models & provider, Auto mode,
 * Delegation (Direct/Guided/Autonomous), Self-Review. Lucide icons only.
 */

import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
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

function useModelDisplayName(): string {
  const { settings } = useSettings();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();

  const selectedModel = settings?.selectedModel;
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

          {/* Model & provider */}
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" />
            Model
          </DropdownMenuLabel>
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
          {isAuto && autoOn && onOpenAutoConfig && (
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
                updateSettings({
                  aiConfiguration: {
                    ...settings?.aiConfiguration,
                    selfReview: {
                      ...settings?.aiConfiguration?.selfReview,
                      enabled: checked,
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
