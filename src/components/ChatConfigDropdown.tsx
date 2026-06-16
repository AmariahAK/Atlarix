/**
 * Single Config button opening a dropdown: Models & provider, Deep reasoning.
 * Lucide icons only.
 *
 * Pass 7: Blueprint-in-prompt tier override removed with the Blueprint subsystem.
 * v12.7: MCP entry removed — MCP management lives in Settings → MCP Servers.
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlidersHorizontal, Cpu } from "lucide-react";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
}: {
  onOpenModelPicker?: () => void;
}) {
  const modelDisplayName = useModelDisplayName();

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
          Config: model
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
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
