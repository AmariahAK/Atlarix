import { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, Brain, Sparkles, CheckCircle2, XCircle, Loader2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentBusExchange } from '@/atoms/sourceAtoms';

/**
 * ThinkingCard - A SEPARATE, INDEPENDENT card showing thoughts + tools
 * Collapsed by default, user can expand to see details
 * Lives SEPARATELY from the response - no connection
 */

export interface ToolCallInfo {
    id: string;
    toolName: string;
    status: 'success' | 'error' | 'running';
    args?: any;
    error?: string;
}

interface ThinkingCardProps {
    thoughts: string[];
    /** Content from `<reasoning>` blocks in the stream (distinct from provider redacted reasoning). */
    reasoningFromTags?: string;
    /** Streamed provider reasoning (`<think>`), shown above tools. */
    modelReasoning?: string;
    toolCalls: ToolCallInfo[];
    /** When true, show a single tool count instead of per-tool pills (multi-agent turns). */
    compactTools?: boolean;
    /** Recent agent-bus lines for this chat (e.g. last 5). */
    busExchanges?: AgentBusExchange[];
    /** Smaller chrome while the assistant message is still streaming. */
    size?: "default" | "compact";
    /** When set, controls initial expand state (e.g. collapsed after turn completes). */
    initialExpanded?: boolean;
}

export function ThinkingCard({
    thoughts,
    reasoningFromTags,
    modelReasoning,
    toolCalls,
    compactTools = false,
    busExchanges = [],
    size = "default",
    initialExpanded = false,
}: ThinkingCardProps) {
    const [isExpanded, setIsExpanded] = useState(initialExpanded);
    const [modelReasoningOpen, setModelReasoningOpen] = useState(false);
    const reasoningTagPresent = Boolean(reasoningFromTags?.trim());

    // Calculate stats
    const stats = useMemo(() => {
        return {
            thoughtCount: thoughts.length,
            reasoningPresent:
                Boolean(modelReasoning?.trim()) || reasoningTagPresent,
            toolCount: toolCalls.length,
            hasErrors: toolCalls.some(t => t.status === 'error'),
            isRunning: toolCalls.some(t => t.status === 'running'),
        };
    }, [thoughts, toolCalls, modelReasoning, reasoningTagPresent]);

    const headerTitle = useMemo(() => {
        const rp = stats.reasoningPresent;
        const tc = stats.toolCount;
        const run = stats.isRunning;
        const th = stats.thoughtCount;
        if (rp && tc > 0 && run) return "Reasoning & tools…";
        if (rp && run) return "Reasoning…";
        if (rp && !run) return "Thought";
        if (tc > 0 && run) return tc === 1 ? "Using tool…" : "Using tools…";
        if (tc > 0 && !run) return "Tools";
        if (th > 0) return "Thinking";
        if (busExchanges.length > 0) return "Activity";
        return "Thinking";
    }, [stats, busExchanges.length]);

    if (
        thoughts.length === 0 &&
        !reasoningTagPresent &&
        !modelReasoning?.trim() &&
        toolCalls.length === 0 &&
        busExchanges.length === 0
    )
        return null;

    const compact = size === "compact";

    return (
        <div
            className={cn(
                "rounded-lg border overflow-hidden",
                compact ? "mb-1.5 mt-1.5" : "mb-3",
                "bg-slate-900/60 border-slate-700/50",
                stats.isRunning && "border-amber-500/30",
                // Smooth animation on appear
                "animate-in fade-in slide-in-from-bottom-1 duration-200"
            )}
        >
            {/* Header - Click to expand/collapse */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                    "w-full flex items-center justify-between hover:bg-slate-800/30 transition-colors",
                    compact ? "px-2 py-1.5" : "px-4 py-2.5",
                )}
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    <Brain className={cn(
                        compact ? "w-3 h-3 shrink-0" : "w-4 h-4",
                        stats.hasErrors ? "text-rose-400"
                            : stats.isRunning ? "text-amber-400"
                                : "text-teal-400"
                    )} />
                    <span className={cn(
                        "font-medium text-slate-200 truncate",
                        compact ? "text-xs" : "text-sm",
                    )}>
                        {headerTitle}
                        {stats.isRunning && (
                            <Loader2 className="w-3 h-3 inline ml-2 animate-spin text-amber-400" />
                        )}
                    </span>
                    <span className={cn("text-slate-500", compact ? "text-[10px]" : "text-xs")}>
                        {stats.reasoningPresent && "reasoning"}
                        {stats.reasoningPresent && stats.thoughtCount > 0 && " · "}
                        {stats.thoughtCount > 0 && `${stats.thoughtCount} thought${stats.thoughtCount > 1 ? 's' : ''}`}
                        {(stats.thoughtCount > 0 || stats.reasoningPresent) && (stats.toolCount > 0 || busExchanges.length > 0) && ' • '}
                        {stats.toolCount > 0 && `${stats.toolCount} tool${stats.toolCount > 1 ? 's' : ''}`}
                        {stats.toolCount > 0 && busExchanges.length > 0 && ' • '}
                        {busExchanges.length > 0 && `bus ${busExchanges.length}`}
                    </span>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                    {isExpanded ? (
                        <ChevronUp className={cn("text-slate-500", compact ? "w-3 h-3" : "w-4 h-4")} />
                    ) : (
                        <ChevronDown className={cn("text-slate-500", compact ? "w-3 h-3" : "w-4 h-4")} />
                    )}
                </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
                <div className={cn(
                    "border-t border-slate-700/50 space-y-3 max-h-72 min-h-0 overflow-y-auto overflow-x-hidden",
                    compact ? "px-2 pb-2 pt-2" : "px-4 pb-3 pt-3",
                )}>
                    {thoughts.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                Thinking
                            </div>
                            {thoughts.map((thought, idx) => (
                                <div
                                    key={idx}
                                    className="flex items-start gap-2 text-sm text-slate-400"
                                >
                                    <Sparkles className="w-3 h-3 mt-1 text-teal-500/70 flex-shrink-0" />
                                    <span className="italic whitespace-pre-wrap">"{thought}"</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {reasoningFromTags?.trim() && (
                        <div className="space-y-1.5">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                Reasoning
                            </div>
                            <div
                                className={cn(
                                    "text-sm text-slate-300/95 whitespace-pre-wrap leading-snug font-mono",
                                )}
                            >
                                {reasoningFromTags.trim()}
                            </div>
                        </div>
                    )}
                    {modelReasoning?.trim() && (
                        <div className="space-y-1.5">
                            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                Model reasoning
                            </div>
                            <div
                                className={cn(
                                    "text-sm text-slate-300/95 whitespace-pre-wrap leading-snug font-mono",
                                    !modelReasoningOpen && "line-clamp-3",
                                )}
                            >
                                {modelReasoning.trim()}
                            </div>
                            {(modelReasoning.length > 180 || modelReasoning.split("\n").length > 3) && (
                                <button
                                    type="button"
                                    className="text-xs text-teal-400/90 hover:text-teal-300"
                                    onClick={() => setModelReasoningOpen((v) => !v)}
                                >
                                    {modelReasoningOpen ? "Show less" : "Show more"}
                                </button>
                            )}
                        </div>
                    )}

                    {/* Tools */}
                    {toolCalls.length > 0 && (
                        compactTools ? (
                            <div className="flex items-center gap-2 text-xs text-slate-400">
                                {stats.hasErrors ? (
                                    <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                                ) : stats.isRunning ? (
                                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                                ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5 text-teal-400 shrink-0" />
                                )}
                                <span>
                                    {stats.toolCount} tool{stats.toolCount === 1 ? "" : "s"}
                                    {stats.hasErrors ? " (some failed)" : ""}
                                    {stats.isRunning ? " (running…)" : ""}
                                </span>
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {toolCalls.map((tool) => (
                                    <div
                                        key={tool.id}
                                        className={cn(
                                            "inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs",
                                            tool.status === 'error' ? "bg-rose-500/15 text-rose-400"
                                                : tool.status === 'running' ? "bg-amber-500/15 text-amber-400"
                                                    : "bg-teal-500/15 text-teal-400"
                                        )}
                                    >
                                        {tool.status === 'error' ? (
                                            <XCircle className="w-3 h-3" />
                                        ) : tool.status === 'running' ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                            <CheckCircle2 className="w-3 h-3" />
                                        )}
                                        <span>{tool.toolName}</span>
                                    </div>
                                ))}
                            </div>
                        )
                    )}

                    {busExchanges.length > 0 && (
                        <div className="space-y-1.5 pt-1 border-t border-slate-700/40">
                            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                                <MessageSquare className="w-3 h-3" />
                                Agent bus (recent)
                            </div>
                            <ul className="space-y-1 font-mono text-[11px] text-slate-500 leading-snug">
                                {busExchanges.map((ex) => (
                                    <li key={ex.id} className="truncate" title={ex.label}>
                                        {ex.label}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default ThinkingCard;
