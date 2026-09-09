/**
 * Compact model search — inline search bar + filtered dropdown.
 * Used when right panel is open (main chat area) or in the right-panel Chat tab.
 * Replaces the full model sidebar/sheet in those contexts.
 */

import { useState, useMemo, useCallback } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useQueryClient } from "@tanstack/react-query";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LargeLanguageModel } from "@/lib/schemas";
import type { LanguageModel } from "@/ipc/ipc_types";
import { useModelDisplayName } from "@/components/ChatConfigDropdown";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";

/** Split `model (provider)` labels from resolveModelDisplayLabel; otherwise use provider column. */
function optionLabelLines(
  resolved: string,
  fallbackProviderName: string,
): { primary: string; secondary: string } {
  const match = resolved.match(/^(.+?)\s+\(([^)]+)\)\s*$/);
  if (match) {
    return { primary: match[1]!.trim(), secondary: match[2]!.trim() };
  }
  return { primary: resolved, secondary: fallbackProviderName };
}

export function CompactModelSearch({
  triggerLabel,
  className,
  disabled,
}: {
  triggerLabel?: string;
  className?: string;
  /** When true (Auto routing): no model picking; matches ChatConfigDropdown behavior. */
  disabled?: boolean;
}) {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const { data: modelsByProviders, isLoading } = useLanguageModelsByProviders();
  const { data: providers } = useLanguageModelProviders();
  const { data: catalog = [] } = useAtlarixCoreCatalog();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();
  const modelDisplayName = useModelDisplayName();

  const selectedModel = settings?.selectedModel;

  const getProviderName = (providerId: string) =>
    providers?.find((p) => p.id === providerId)?.name ?? providerId;

  const resolveOptionLabel = useCallback(
    (providerId: string, model: LanguageModel) => {
      const providerName = getProviderName(providerId);
      const resolved = resolveModelDisplayLabel(
        {
          provider: providerId as LargeLanguageModel["provider"],
          name: model.apiName,
          customModelId: model.type === "custom" ? model.id : undefined,
        },
        {
          catalog,
          modelsByProviders: modelsByProviders ?? undefined,
          ollamaDisplayName: ollamaModels.find(
            (m) => m.modelName === model.apiName,
          )?.displayName,
          lmStudioDisplayName: lmStudioModels.find(
            (m) => m.modelName === model.apiName,
          )?.displayName,
        },
      );
      return optionLabelLines(resolved, providerName);
    },
    [catalog, modelsByProviders, ollamaModels, lmStudioModels, providers],
  );

  // Flatten all models with provider id, then filter by search
  const filteredOptions = useMemo(() => {
    if (!modelsByProviders) return [];
    const q = searchQuery.trim().toLowerCase();
    const list: {
      providerId: string;
      providerName: string;
      model: LanguageModel;
      primary: string;
      secondary: string;
    }[] = [];
    for (const [providerId, models] of Object.entries(modelsByProviders)) {
      if (providerId === "auto" || !models?.length) continue;
      const providerName = getProviderName(providerId);
      for (const model of models) {
        const { primary, secondary } = resolveOptionLabel(providerId, model);
        const match =
          !q ||
          providerId.toLowerCase().includes(q) ||
          providerName.toLowerCase().includes(q) ||
          primary.toLowerCase().includes(q) ||
          secondary.toLowerCase().includes(q) ||
          (model.displayName?.toLowerCase().includes(q) ?? false) ||
          (model.apiName?.toLowerCase().includes(q) ?? false);
        if (match)
          list.push({ providerId, providerName, model, primary, secondary });
      }
    }
    return list.slice(0, 50);
  }, [modelsByProviders, searchQuery, providers, resolveOptionLabel]);

  const onSelect = (model: LargeLanguageModel) => {
    updateSettings({ selectedModel: model });
    queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
    setOpen(false);
    setSearchQuery("");
  };

  const displayName =
    selectedModel?.provider && selectedModel?.name
      ? modelDisplayName
      : "Select model";

  if (!settings) return null;

  if (disabled) {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        title="Auto routing is on — the model is chosen per message."
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm opacity-60 cursor-not-allowed pointer-events-none select-none",
          className,
        )}
        onClick={(e) => e.preventDefault()}
      >
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="truncate max-w-[180px]">
          {triggerLabel ?? displayName}
        </span>
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary/20",
            className,
          )}
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate max-w-[180px]">
            {triggerLabel ?? displayName}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
        className="z-200 w-[280px] max-h-[min(70vh,var(--radix-popover-content-available-height,70vh))] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search providers & models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-sm"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto p-1">
          {isLoading ? (
            <p className="text-xs text-muted-foreground py-3 text-center">
              Loading...
            </p>
          ) : filteredOptions.length === 0 ? (
            <p className="text-xs text-muted-foreground py-3 text-center">
              {searchQuery.trim()
                ? "No matches. Try openrouter, claude, grok…"
                : "Type to search providers and models."}
            </p>
          ) : (
            <div className="space-y-0.5">
              {filteredOptions.map(
                ({ providerId, model, primary, secondary }) => (
                  <button
                    key={`${providerId}:${model.apiName}`}
                    type="button"
                    onClick={() =>
                      onSelect({
                        provider: providerId as LargeLanguageModel["provider"],
                        name: model.apiName,
                        ...(model.type === "custom"
                          ? { customModelId: model.id }
                          : {}),
                      })
                    }
                    className={cn(
                      "w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors",
                      selectedModel?.provider === providerId &&
                        selectedModel?.name === model.apiName &&
                        "bg-secondary",
                    )}
                  >
                    <span className="font-medium truncate block">
                      {primary}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {secondary}
                    </span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
