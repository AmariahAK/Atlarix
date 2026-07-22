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
import { useTranscriptionProviders } from "@/hooks/useTranscriptionProviders";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlidersHorizontal, Cpu, Brain, Mic } from "lucide-react";
import { isReasoningCapableModel } from "@/lib/routing/reasoning-detector";
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
  const { settings, updateSettings } = useSettings();
  // Only offer "deep thinking" for models that can actually reason (opencode's
  // capability gate) — otherwise the toggle would be a no-op.
  const reasoningCapable = isReasoningCapableModel(settings?.selectedModel);
  const deepThinking = !!settings?.deepThinking;
  const voiceProvider = settings?.voiceTranscriptionProvider ?? "local";
  const voiceMode = settings?.voiceInputMode ?? "dictate";
  // Derived in main from (providers with a key) ∩ (providers with an
  // audio-input model), so the menu can't offer something that would fail at
  // transcription time. The curated list stays as the fallback while the query
  // is loading/errored — voice must never present an empty picker.
  const { data: voiceProviders } = useTranscriptionProviders();
  const VOICE_PROVIDERS =
    voiceProviders && voiceProviders.length > 0
      ? voiceProviders
      : [
          { id: "local", label: "On-device (free)" },
          { id: "openai", label: "OpenAI (BYOK)" },
          { id: "groq", label: "Groq (BYOK)" },
          { id: "gemini", label: "Gemini (BYOK)" },
        ];

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
          {reasoningCapable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Brain className="h-3.5 w-3.5" />
                Reasoning
              </DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={deepThinking}
                onCheckedChange={(v) => updateSettings({ deepThinking: !!v })}
                onSelect={(e) => e.preventDefault()}
                data-testid="deep-thinking-toggle"
              >
                Deep thinking
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {deepThinking ? "on" : "off"}
                </span>
              </DropdownMenuCheckboxItem>
              <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                Off = high reasoning (default); on = the maximum this model
                supports. Scales automatically to each model's capability.
              </p>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Mic className="h-3.5 w-3.5" />
            Voice input
          </DropdownMenuLabel>
          {VOICE_PROVIDERS.map((p) => (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={voiceProvider === p.id}
              onCheckedChange={() =>
                updateSettings({ voiceTranscriptionProvider: p.id })
              }
              onSelect={(e) => e.preventDefault()}
            >
              {p.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuCheckboxItem
            checked={voiceMode === "live"}
            onCheckedChange={(v) =>
              updateSettings({ voiceInputMode: v ? "live" : "dictate" })
            }
            onSelect={(e) => e.preventDefault()}
          >
            Live transcription
            <span className="ml-auto text-[10px] text-muted-foreground">
              {voiceMode === "live" ? "on" : "off"}
            </span>
          </DropdownMenuCheckboxItem>
          <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
            On-device is free & private (first use downloads a small model). Live
            shows words as you speak (on-device + WebGPU).
          </p>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
