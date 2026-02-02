/**
 * AutoProviderOrderList
 * Drag-and-drop list to set the order of AI providers when "Auto" is selected.
 * Matches the providers shown in the AI Providers grid.
 */

import { useState, useMemo } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { CLOUD_PROVIDERS, LOCAL_PROVIDERS } from "@/ipc/shared/language_model_constants";

function getProviderLabel(id: string): string {
  return (
    CLOUD_PROVIDERS[id]?.displayName ??
    LOCAL_PROVIDERS[id]?.displayName ??
    id
  );
}

interface AutoProviderOrderListProps {
  order: string[];
  onOrderChange: (newOrder: string[]) => void;
  /** All provider IDs from the AI Providers grid (same list, so order matches). */
  allProviderIds?: string[];
  disabled?: boolean;
}

const DEFAULT_ORDER = [
  "openrouter",
  "openai",
  "google",
  "anthropic",
  "xai",
  "togetherai",
  "groq",
  "mistral",
  "ollama",
  "lmstudio",
];

export function AutoProviderOrderList({
  order,
  onOrderChange,
  allProviderIds = DEFAULT_ORDER,
  disabled,
}: AutoProviderOrderListProps) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const displayOrder = useMemo(() => {
    if (order.length > 0) {
      const ordered = order.filter((id) => allProviderIds.includes(id));
      const appended = allProviderIds.filter((id) => !ordered.includes(id));
      return [...ordered, ...appended];
    }
    return [...allProviderIds];
  }, [order, allProviderIds]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (disabled) return;
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    e.dataTransfer.setData("application/json", JSON.stringify({ index }));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (disabled) return;
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    setDraggedIndex(null);
    setDragOverIndex(null);
    if (disabled) return;
    const fromIndex = draggedIndex;
    if (fromIndex == null || fromIndex === dropIndex) return;
    const next = [...displayOrder];
    const [removed] = next.splice(fromIndex, 1);
    next.splice(dropIndex, 0, removed);
    onOrderChange(next);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        When <strong>Auto</strong> is selected, AI is used in this order. Drag
        to reorder.
      </p>
      <ul
        className={cn(
          "rounded-md border border-border divide-y divide-border bg-muted/20",
          disabled && "opacity-60 pointer-events-none"
        )}
      >
        {displayOrder.map((providerId, index) => (
          <li
            key={providerId}
            draggable={!disabled}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, index)}
            onDragEnd={handleDragEnd}
            className={cn(
              "flex items-center gap-2 px-3 py-2 text-sm cursor-grab active:cursor-grabbing",
              draggedIndex === index && "opacity-50",
              dragOverIndex === index && "bg-primary/10 border-y border-primary/30 -my-px"
            )}
          >
            <GripVertical className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="w-6 text-xs text-muted-foreground shrink-0">
              {index + 1}.
            </span>
            <span className="font-medium text-foreground">
              {getProviderLabel(providerId)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
