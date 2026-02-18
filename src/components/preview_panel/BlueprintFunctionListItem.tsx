/**
 * Single function row in Edit container details: type icon + label, name, expandable config.
 * Shows simpleDescription when present; "Simplify" uses AI to generate one; technical details expandable.
 */

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Trash2, Code, Pencil, KeyRound, Sparkles, ArrowRight, Plus } from "lucide-react";
import type { BlueprintFunction, BlueprintFunctionKind, BlueprintRoomFlowEdge } from "@/shared/blueprint-types";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import { toast } from "sonner";

interface BlueprintFunctionListItemProps {
  fn: BlueprintFunction;
  roomId: string;
  workspaceId: number | null;
  onUpdate: (fnId: string, updates: Partial<BlueprintFunction>) => void;
  onRemove: (fnId: string) => void;
  /** Switch right panel to Vault/Creds tab (Phase B) */
  onOpenCreds?: () => void;
  /** When true, start expanded (e.g. after clicking node in Flow view) */
  defaultExpanded?: boolean;
  /** Nodes (e.g. tool calls, steps) shown nested when expanded */
  subBeacons?: BlueprintFunction[];
  /** Flow edges for this room (for "Connected to" section) */
  flowEdges?: BlueprintRoomFlowEdge[];
  /** Update flow edges for this room */
  onFlowEdgesChange?: (edges: BlueprintRoomFlowEdge[]) => void;
  /** All functions in this room (for add-connection target dropdown) */
  otherFunctions?: BlueprintFunction[];
}

export function BlueprintFunctionListItem({
  fn,
  roomId,
  workspaceId,
  onUpdate,
  onRemove,
  onOpenCreds,
  defaultExpanded = false,
  subBeacons = [],
  flowEdges = [],
  onFlowEdgesChange,
  otherFunctions = [],
}: BlueprintFunctionListItemProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [subExpanded, setSubExpanded] = useState(false);
  const [simplifying, setSimplifying] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };
  const config = FUNCTION_KIND_CONFIG[fn.kind as BlueprintFunctionKind] ?? FUNCTION_KIND_CONFIG.feature;
  const { Icon, label, borderClass, iconClass, configHint } = config;
  const hasSubBeacons = subBeacons.length > 0;

  const handleSimplify = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (workspaceId == null) {
      toast.error("No workspace selected");
      return;
    }
    setSimplifying(true);
    try {
      const res = await IpcClient.getInstance().simplifyBlueprintDescription({
        workspaceId,
        roomId,
        functionId: fn.id,
      });
      if (res.success && res.simpleDescription) {
        onUpdate(fn.id, { simpleDescription: res.simpleDescription, descriptionSource: "ai" });
        toast.success("Description updated");
      } else {
        toast.error(res.error ?? "Could not simplify");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Simplify failed");
    } finally {
      setSimplifying(false);
    }
  };

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
            setExpanded((prev) => !prev);
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
          ref={nameInputRef}
          type="text"
          value={fn.name}
          onChange={(e) => onUpdate(fn.id, { name: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          placeholder={configHint}
          className="flex-1 min-w-0 px-2 py-0.5 text-xs rounded border border-border bg-background"
        />
        {fn.simpleDescription && (
          <span className="shrink-0 max-w-[120px] truncate text-[10px] text-muted-foreground" title={fn.simpleDescription}>
            · {fn.simpleDescription}
          </span>
        )}
        {fn.aiGenerated && (
          <span className="shrink-0 text-[10px] text-muted-foreground italic" title="Created by AI from container prompt">
            (AI-generated)
          </span>
        )}
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

      {/* Expanded: simple description prominent, Simplify button, technical details expandable */}
      {expanded && (
        <div className="px-2 pb-2 pt-0 border-t border-border/50 mt-0">
          <div className="space-y-2 pt-2">
            <div className="space-y-1 text-xs">
              <label className="flex gap-2 items-center">
                <span className="text-muted-foreground shrink-0">Short description (for AI):</span>
                <input
                  type="text"
                  value={fn.simpleDescription ?? ""}
                  onChange={(e) => onUpdate(fn.id, { simpleDescription: e.target.value.trim() || undefined })}
                  onClick={(e) => e.stopPropagation()}
                  placeholder="What this does in one line"
                  className="flex-1 min-w-0 px-2 py-0.5 rounded border border-border bg-background text-foreground"
                />
              </label>
            </div>
            {!fn.simpleDescription && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {fn.description && (
                  <span className="text-muted-foreground truncate max-w-[200px]" title={fn.description}>
                    {fn.description}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleSimplify}
                  disabled={simplifying}
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20",
                    simplifying && "opacity-60"
                  )}
                >
                  <Sparkles className="w-3 h-3" />
                  {simplifying ? "Simplifying…" : "Simplify with AI"}
                </button>
              </div>
            )}
            {fn.description && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowTechnical((v) => !v); }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {showTechnical ? "Hide" : "Show"} technical details
                </button>
                {showTechnical && (
                  <div className="mt-1 px-2 py-1 rounded bg-muted/50 font-mono text-[10px] break-all">
                    {fn.description}
                  </div>
                )}
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
            {(fn.kind === "function" || fn.kind === "feature") && !fn.simpleDescription && !fn.description && (
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span>{configHint}</span>
              </div>
            )}
            {/* Connected to: show and edit flow edges for this function */}
            <div className="space-y-1.5 text-xs">
              <h4 className="font-medium text-muted-foreground flex items-center gap-1">
                <ArrowRight className="w-3 h-3" />
                Connected to
              </h4>
              {(() => {
                const outgoing = flowEdges.filter((e) => e.from === fn.id);
                const incoming = flowEdges.filter((e) => e.to === fn.id);
                const idToName = new Map(otherFunctions.map((f) => [f.id, f.name || f.id]));
                if (outgoing.length === 0 && incoming.length === 0 && !onFlowEdgesChange) {
                  return <span className="text-muted-foreground">No connections</span>;
                }
                if (outgoing.length === 0 && incoming.length === 0 && onFlowEdgesChange && otherFunctions.length <= 1) {
                  return <span className="text-muted-foreground">No connections. Add another function in this container to connect.</span>;
                }
                return (
                  <div className="space-y-1">
                    {outgoing.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground shrink-0">Out:</span>
                        {outgoing.map((e) => (
                          <span
                            key={`${e.from}-${e.to}`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted/60"
                          >
                            {idToName.get(e.to) ?? e.to}
                            {onFlowEdgesChange && (
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  onFlowEdgesChange(flowEdges.filter((x) => !(x.from === fn.id && x.to === e.to)));
                                }}
                                className="ml-0.5 p-0 rounded text-muted-foreground hover:text-destructive"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {incoming.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted-foreground shrink-0">In:</span>
                        {incoming.map((e) => (
                          <span
                            key={`${e.from}-${e.to}`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-muted/60"
                          >
                            {idToName.get(e.from) ?? e.from}
                            {onFlowEdgesChange && (
                              <button
                                type="button"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  onFlowEdgesChange(flowEdges.filter((x) => !(x.from === e.from && x.to === fn.id)));
                                }}
                                className="ml-0.5 p-0 rounded text-muted-foreground hover:text-destructive"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {onFlowEdgesChange && otherFunctions.length > 1 && (
                      <div className="flex items-center gap-1 flex-wrap">
                        <select
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const toId = e.target.value;
                            e.target.value = "";
                            if (!toId || toId === fn.id) return;
                            if (flowEdges.some((x) => x.from === fn.id && x.to === toId)) return;
                            onFlowEdgesChange([...flowEdges, { from: fn.id, to: toId }]);
                          }}
                          className="px-1.5 py-0.5 text-xs rounded border border-border bg-background"
                        >
                          <option value="">Add connection…</option>
                          {otherFunctions
                            .filter((f) => f.id !== fn.id && !flowEdges.some((e) => e.from === fn.id && e.to === f.id))
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.name || f.kind}
                              </option>
                            ))}
                        </select>
                        <Plus className="w-3 h-3 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80 text-muted-foreground"
                title="Open file in code view"
              >
                <Code className="w-3 h-3" />
                View code
              </button>
              <button
                type="button"
                onClick={handleEditClick}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80 text-muted-foreground"
                title="Expand to edit name and description"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            </div>
            {hasSubBeacons && (
              <div className="mt-2 border-t border-border/50 pt-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setSubExpanded((v) => !v); }}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {subExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Nodes ({subBeacons.length})
                </button>
                {subExpanded && (
                  <ul className="mt-1 ml-4 space-y-1 list-none pl-0">
                    {subBeacons.map((sub) => {
                      const subConfig = FUNCTION_KIND_CONFIG[sub.kind as BlueprintFunctionKind] ?? FUNCTION_KIND_CONFIG.feature;
                      return (
                        <li
                          key={sub.id}
                          className={cn(
                            "flex items-center gap-2 py-1 px-2 rounded border-l-2 border-border bg-muted/30 text-xs",
                            subConfig.borderClass
                          )}
                        >
                          <subConfig.Icon className={cn("w-3 h-3 shrink-0", subConfig.iconClass)} />
                          <span className="font-medium truncate">{sub.name || sub.kind}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
