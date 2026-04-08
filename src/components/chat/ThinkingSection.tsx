import React, { useState, useMemo } from 'react';
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
    toolCalls: ToolCallInfo[];
    /** When true, show a single tool count instead of per-tool pills (multi-agent turns). */
    compactTools?: boolean;
    /** Recent agent-bus lines for this chat (e.g. last 5). */
    busExchanges?: AgentBusExchange[];
}

export function ThinkingCard({ thoughts, toolCalls, compactTools = false, busExchanges = [] }: ThinkingCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    // Calculate stats
    const stats = useMemo(() => {
        const toolCounts: Record<string, number> = {};
        toolCalls.forEach(tool => {
            toolCounts[tool.toolName] = (toolCounts[tool.toolName] || 0) + 1;
        });

        const toolSummary = Object.entries(toolCounts)
            .map(([name, count]) => count > 1 ? `${name}×${count}` : name)
            .join(' • ');

        return {
            thoughtCount: thoughts.length,
            toolCount: toolCalls.length,
            toolSummary,
            hasErrors: toolCalls.some(t => t.status === 'error'),
            isRunning: toolCalls.some(t => t.status === 'running'),
        };
    }, [thoughts, toolCalls]);

    if (thoughts.length === 0 && toolCalls.length === 0 && busExchanges.length === 0) return null;

    return (
        <div
            className={cn(
                "mb-3 rounded-lg border overflow-hidden",
                "bg-slate-900/60 border-slate-700/50",
                stats.isRunning && "border-amber-500/30",
                // Smooth animation on appear
                "animate-in fade-in slide-in-from-top-2 duration-200"
            )}
        >
            {/* Header - Click to expand/collapse */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-800/30 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Brain className={cn(
                        "w-4 h-4",
                        stats.hasErrors ? "text-rose-400"
                            : stats.isRunning ? "text-amber-400"
                                : "text-teal-400"
                    )} />
                    <span className="text-sm font-medium text-slate-200">
                        Thinking
                        {stats.isRunning && (
                            <Loader2 className="w-3 h-3 inline ml-2 animate-spin text-amber-400" />
                        )}
                    </span>
                    <span className="text-xs text-slate-500">
                        {stats.thoughtCount > 0 && `${stats.thoughtCount} thought${stats.thoughtCount > 1 ? 's' : ''}`}
                        {stats.thoughtCount > 0 && (stats.toolCount > 0 || busExchanges.length > 0) && ' • '}
                        {stats.toolCount > 0 && `${stats.toolCount} tool${stats.toolCount > 1 ? 's' : ''}`}
                        {stats.toolCount > 0 && busExchanges.length > 0 && ' • '}
                        {busExchanges.length > 0 && `bus ${busExchanges.length}`}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {!isExpanded && stats.toolSummary && !compactTools && (
                        <span className="hidden sm:inline text-xs text-slate-600 truncate max-w-[200px]">
                            {stats.toolSummary}
                        </span>
                    )}
                    {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-4 pb-3 border-t border-slate-700/50 pt-3 space-y-3">
                    {/* Thoughts */}
                    {thoughts.length > 0 && (
                        <div className="space-y-2">
                            {thoughts.map((thought, idx) => (
                                <div
                                    key={idx}
                                    className="flex items-start gap-2 text-sm text-slate-400"
                                >
                                    <Sparkles className="w-3 h-3 mt-1 text-teal-500/70 flex-shrink-0" />
                                    <span className="italic">"{thought}"</span>
                                </div>
                            ))}
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
