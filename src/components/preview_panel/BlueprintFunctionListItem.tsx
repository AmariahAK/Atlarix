/**
 * Single function row in Edit room details: type icon + label, name, expandable config.
 * Phase A: differentiate API / Webhook / Function / Feature with icons and expandable details.
 */

import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Trash2, Code, Pencil, KeyRound } from "lucide-react";
import type { BlueprintFunction, BlueprintFunctionKind } from "@/shared/blueprint-types";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import { cn } from "@/lib/utils";

interface BlueprintFunctionListItemProps {
  fn: BlueprintFunction;
  roomId: string;
  onUpdate: (fnId: string, updates: Partial<BlueprintFunction>) => void;
  onRemove: (fnId: string) => void;
  /** Switch right panel to Vault/Creds tab (Phase B) */
  onOpenCreds?: () => void;
  /** When true, start expanded (e.g. after clicking node in Flow view) */
  defaultExpanded?: boolean;
}

export function BlueprintFunctionListItem({
  fn,
  roomId: _roomId,
  onUpdate,
  onRemove,
  onOpenCreds,
  defaultExpanded = false,
}: BlueprintFunctionListItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  const config = FUNCTION_KIND_CONFIG[fn.kind as BlueprintFunctionKind] ?? FUNCTION_KIND_CONFIG.feature;
  const { Icon, label, borderClass, iconClass, configHint } = config;

  return (
    <div
      className={cn(
        "rounded-lg border-l-4 border border-border bg-card/50 overflow-hidden transition-colors",
        borderClass
      )}
    >
      {/* Header: icon + type + name + expand + delete */}
      <div
        className="flex items-center gap-2 py-1.5 px-2 cursor-pointer hover:bg-muted/30"
        onClick={() => setExpanded((e) => !e)}
      >
        <button
          type="button"
          className="p-0.5 rounded text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((e) => !e);
          }}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <Icon className={cn("w-3.5 h-3.5 shrink-0", iconClass)} />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
          {label}
        </span>
        <input
          type="text"
          value={fn.name}
          onChange={(e) => onUpdate(fn.id, { name: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          placeholder={configHint}
          className="flex-1 min-w-0 px-2 py-0.5 text-xs rounded border border-border bg-background"
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(fn.id);
          }}
          className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
          title="Remove"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Expanded: description + credential + type-specific config + actions */}
      {expanded && (
        <div className="px-2 pb-2 pt-0 border-t border-border/50 mt-0">
          <div className="space-y-2 pt-2">
            {fn.description && (
              <div className="flex gap-2 text-xs">
                <span className="text-muted-foreground shrink-0">Description:</span>
                <span className="text-foreground/90">{fn.description}</span>
              </div>
            )}
            {(fn.kind === "api" || fn.kind === "webhook") && (
              <div className="space-y-1.5 text-xs">
                {fn.provider && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">Provider:</span>
                    <span className="text-foreground/90">{fn.provider}</span>
                  </div>
                )}
                {fn.trigger && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">Trigger:</span>
                    <span className="text-foreground/90">{fn.trigger}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground shrink-0">Key:</span>
                  <input
                    type="text"
                    value={fn.credentialKey ?? ""}
                    onChange={(e) => onUpdate(fn.id, { credentialKey: e.target.value.trim() || undefined })}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="e.g. OPENROUTER_API_KEY"
                    className="flex-1 min-w-[120px] px-1.5 py-0.5 text-xs rounded border border-border bg-background font-mono"
                  />
                  {fn.credentialKey && onOpenCreds && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCreds();
                      }}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
                    >
                      <KeyRound className="w-3 h-3" />
                      Edit in Creds
                    </button>
                  )}
                </div>
              </div>
            )}
            {(fn.kind === "function" || fn.kind === "feature") && !fn.description && (
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span>{configHint}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80 text-muted-foreground"
              >
                <Code className="w-3 h-3" />
                View code
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80 text-muted-foreground"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
