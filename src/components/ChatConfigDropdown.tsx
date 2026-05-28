/**
 * Single Config button opening a dropdown: MCP, Models & provider, Auto mode,
 * Delegation (Direct/Guided/Autonomous). Lucide icons only.
 *
 * Pass 7: Blueprint-in-prompt tier override removed with the Blueprint subsystem.
 */

import { useAtom } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { forceDeepThinkNextAtom } from "@/atoms/chatAtoms";
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
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  SlidersHorizontal,
  Server,
  Cpu,
  Brain,
} from "lucide-react";
import type { UserSettings } from "@/lib/schemas";
import { resolveContextBudgetTier } from "@/lib/routing/context_budget_routing";
import { PROVIDERS_THAT_SUPPORT_THINKING } from "@/ipc/shared/language_model_constants";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";
import { ATLARIX_CORE_CATEGORY_LABEL } from "@/shared/compass_product_copy";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Deep think toggle when the selected model supports thinking-tier context. */
function showDeepThinkNextToggle(settings: UserSettings | undefined | null): boolean {
  if (!settings?.selectedModel) return false;
  if (resolveContextBudgetTier(settings.selectedModel, settings) === "thinking") {
    return true;
  }
  return PROVIDERS_THAT_SUPPORT_THINKING.includes(settings.selectedModel.provider);
}

export function useModelDisplayName(): string {
  const { settings } = useSettings();
  const { data: catalog = [] } = useAtlarixCoreCatalog();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();

  return resolveModelDisplayLabel(settings?.selectedModel, {
    catalog,
    modelsByProviders: modelsByProviders ?? undefined,
    ollamaDisplayName: ollamaModels.find(
      (m) => m.modelName === settings?.selectedModel?.name,
    )?.displayName,
    lmStudioDisplayName: lmStudioModels.find(
      (m) => m.modelName === settings?.selectedModel?.name,
    )?.displayName,
  });
}

export function ChatConfigDropdown({
  onOpenModelPicker,
  onOpenMcpTools,
}: {
  onOpenModelPicker?: () => void;
  onOpenMcpTools?: () => void;
}) {
  const { settings } = useSettings();
  const modelDisplayName = useModelDisplayName();
  const [forceDeepThinkNext, setForceDeepThinkNext] = useAtom(forceDeepThinkNextAtom);
  const deepThinkVisible = showDeepThinkNextToggle(settings ?? null);

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
          Config: MCP, model
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
                Next send uses the full thinking-tier context budget for your current model.
              </p>
            </>
          ) : null}

          {/* Pass 7: Blueprint prompt-tier selector removed with Blueprint subsystem. */}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
