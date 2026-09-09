/**
 * ModelPickerSheetContent - Full provider + model list for the "Change model" Sheet.
 * Shows all configured providers (OpenRouter, OpenAI, Claude, etc.) as collapsible sections.
 * One search bar filters across all models. Only providers you've set up appear.
 */

import { useState, useMemo } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useQueryClient } from "@tanstack/react-query";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PriceBadge } from "@/components/PriceBadge";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LargeLanguageModel } from "@/lib/schemas";
import type { LanguageModel } from "@/ipc/ipc_types";

export function ModelPickerSheetContent({
  onClose,
  disabled,
}: {
  onClose: () => void;
  /** When Auto routing is on — sheet should not be used; guard for safety. */
  disabled?: boolean;
}) {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const { data: modelsByProviders, isLoading } = useLanguageModelsByProviders();
  const { data: providers } = useLanguageModelProviders();

  const selectedModel = settings?.selectedModel;

  // Provider entries that have models (only configured providers appear)
  const providerEntries = useMemo(() => {
    if (!modelsByProviders) return [];
    return Object.entries(modelsByProviders).filter(
      ([id]) => id !== "auto" && (modelsByProviders[id]?.length ?? 0) > 0,
    ) as [string, LanguageModel[]][];
  }, [modelsByProviders]);

  const getProviderName = (providerId: string) =>
    providers?.find((p) => p.id === providerId)?.name ?? providerId;

  const onSelect = (model: LargeLanguageModel) => {
    updateSettings({ selectedModel: model });
    queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
    onClose();
  };

  if (!settings) return null;

  if (disabled) {
    return (
      <div className="flex flex-col gap-3 pt-2">
        <p className="text-sm text-muted-foreground">
          <strong>Auto</strong> is on — the model is chosen per message. Turn
          off <strong>Auto mode</strong> in the chat config menu (sliders icon)
          to pick a fixed model.
        </p>
        <button
          type="button"
          className="text-sm text-primary underline-offset-2 hover:underline w-fit"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      <p className="text-sm text-muted-foreground">
        Only providers you’ve set up in Settings appear. Expand a provider to
        choose a model.
      </p>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search models..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading models...</p>
      ) : providerEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No providers configured. Add an API key in{" "}
          <strong>Settings → Model providers</strong> (e.g. OpenRouter, OpenAI,
          Claude).
        </p>
      ) : (
        <ScrollArea className="h-[min(60vh,400px)] rounded-md border [&_[data-radix-scroll-area-viewport]>div]:!block">
          <Accordion type="multiple" className="w-full p-2">
            {providerEntries.map(([providerId, models]) => {
              const q = searchQuery.trim().toLowerCase();
              const filtered = !q
                ? models
                : models.filter(
                    (m) =>
                      m.displayName.toLowerCase().includes(q) ||
                      m.apiName.toLowerCase().includes(q),
                  );
              const displayName = getProviderName(providerId);
              return (
                <AccordionItem key={providerId} value={providerId}>
                  <AccordionTrigger className="text-sm py-3">
                    <span className="font-medium">{displayName}</span>
                    <span className="text-muted-foreground font-normal ml-2">
                      ({filtered.length} {q ? "matching" : ""} model
                      {filtered.length !== 1 ? "s" : ""})
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-1 pb-2">
                      {filtered.length === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No models match your search.
                        </p>
                      ) : (
                        filtered.map((model) => (
                          <button
                            key={model.apiName}
                            type="button"
                            onClick={() =>
                              onSelect({
                                provider:
                                  providerId as LargeLanguageModel["provider"],
                                name: model.apiName,
                              })
                            }
                            className={cn(
                              "w-full text-left px-3 py-2 rounded-md hover:bg-accent transition-colors flex items-center justify-between gap-2",
                              selectedModel?.provider === providerId &&
                                selectedModel?.name === model.apiName &&
                                "bg-secondary border border-primary",
                            )}
                          >
                            <span className="font-medium text-sm truncate flex-1 min-w-0">
                              {model.displayName}
                            </span>
                            <PriceBadge
                              cost={"cost" in model ? model.cost : undefined}
                              isCore={providerId === "compass"}
                            />
                          </button>
                        ))
                      )}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </ScrollArea>
      )}

      <p className="text-xs text-muted-foreground">
        Add or manage API keys in <strong>Settings → Model providers</strong>.
      </p>
    </div>
  );
}
