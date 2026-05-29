/**
 * Tool Summary Component (Claude-style)
 * ======================================
 * Compact, grouped display of tool calls
 * Shows: "read_file×3 • list_files×2" instead of 6 separate cards
 * 
 * Features:
 * - Groups tools by name with count
 * - Single-line compact header (expandable)
 * - Shows status indicators (success/error)
 * - Non-intrusive, appears after message text
 */

import React, { useState, useMemo } from 'react';
import {
    ChevronDown,
    ChevronUp,
    Search,
    FileText,
    FolderOpen,
    Globe,
    GitBranch,
    Database,
    Terminal,
    Wrench,
    BarChart3,
    MessageSquare,
    CheckCircle2,
    XCircle,
    Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Tool call data structure
export interface ToolCall {
    id: string;
    toolName: string;
    args?: any;
    result?: any;
    error?: string;
    duration?: number; // ms
    status: 'pending' | 'running' | 'success' | 'error';
}

interface ToolSummaryProps {
    toolCalls: ToolCall[];
    defaultExpanded?: boolean;
}

// Tool icons for compact display (Lucide only, no emoji)
const toolIcons: Record<string, React.ElementType> = {
    read_file: FileText,
    list_files: FolderOpen,
    find_file: Search,
    search_code: Search,
    search: Search,
    web_search: Globe,
    deep_search: Globe,
    read_url: Globe,
    get_diagram: BarChart3,
    visualize_graph: BarChart3,
    recall_memory: Database,
    search_memory: Search,
    run_command: Terminal,
    ask_user: MessageSquare,
    parse_code_structure: BarChart3,
    health_check: CheckCircle2,
};

// Format args for display
function formatArgs(args: any): string {
    if (!args) return '';
    if (args.path || args.file) {
        const path = args.path || args.file;
        // Show just filename if path is too long
        if (path.length > 30) {
            const parts = path.split('/');
            return parts[parts.length - 1];
        }
        return path;
    }
    if (args.query) {
        return `"${args.query.substring(0, 20)}${args.query.length > 20 ? '...' : ''}"`;
    }
    if (args.command) {
        return args.command.substring(0, 25) + (args.command.length > 25 ? '...' : '');
    }
    return '';
}

export function ToolSummary({ toolCalls, defaultExpanded = false }: ToolSummaryProps) {
    const [expanded, setExpanded] = useState(defaultExpanded);

    // Group by tool name
    const grouped = useMemo(() => {
        return toolCalls.reduce((acc, call) => {
            const name = call.toolName;
            if (!acc[name]) acc[name] = [];
            acc[name].push(call);
            return acc;
        }, {} as Record<string, ToolCall[]>);
    }, [toolCalls]);

    // Stats for each tool type
    const stats = useMemo(() => {
        return Object.entries(grouped).map(([name, calls]) => ({
            name,
            count: calls.length,
            errors: calls.filter(c => c.status === 'error').length,
            running: calls.some(c => c.status === 'running' || c.status === 'pending'),
            Icon: toolIcons[name] || Wrench,
        }));
    }, [grouped]);

    const hasErrors = stats.some(s => s.errors > 0);
    const isRunning = stats.some(s => s.running);

    if (toolCalls.length === 0) return null;

    return (
        <div className={cn(
            "my-2 rounded-lg border overflow-hidden text-sm",
            "bg-zinc-900/50 backdrop-blur-sm",
            hasErrors && "border-rose-500/30",
            isRunning && "border-purple-500/30",
            !hasErrors && !isRunning && "border-zinc-700/50"
        )}>
            {/* Compact Header - Always visible */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full px-3 py-2 flex items-center gap-2 hover:bg-zinc-800/50 transition"
            >
                {/* Icon */}
                <Search className="h-3.5 w-3.5 text-muted-foreground" />

                {/* Label */}
                <span className="text-muted-foreground text-xs">Tools used:</span>

                {/* Badge list - grouped */}
                <div className="flex gap-1.5 flex-wrap flex-1">
                    {stats.map(({ name, count, errors, running, Icon }) => (
                        <span
                            key={name}
                            className={cn(
                                "px-1.5 py-0.5 rounded text-xs font-mono inline-flex items-center gap-1",
                                errors > 0
                                    ? "bg-rose-500/20 text-rose-400"
                                    : running
                                        ? "bg-purple-500/20 text-purple-400"
                                        : "bg-emerald-500/20 text-emerald-400"
                            )}
                        >
                            <Icon className="h-3 w-3 shrink-0" />
                            <span>{name.replace(/_/g, '_')}</span>
                            {count > 1 && <span>×{count}</span>}
                            {running && <Loader2 className="h-3 w-3 animate-spin" />}
                        </span>
                    ))}
                </div>

                {/* Chevron */}
                {expanded
                    ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                }
            </button>

            {/* Expanded Details */}
            {expanded && (
                <div className="px-3 py-2 space-y-1 border-t border-zinc-800/50 text-xs">
                    {toolCalls.map((call) => (
                        <div
                            key={call.id}
                            className="flex items-center gap-2 font-mono py-0.5"
                        >
                            {/* Status dot */}
                            <div className={cn(
                                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                                call.status === 'success' && "bg-emerald-500",
                                call.status === 'error' && "bg-rose-500",
                                call.status === 'running' && "bg-purple-500 animate-pulse",
                                call.status === 'pending' && "bg-amber-500 animate-pulse"
                            )} />

                            {/* Tool name */}
                            <span className="text-zinc-400">
                                {call.toolName}
                            </span>

                            {/* Args preview */}
                            <span className="text-zinc-500 truncate flex-1">
                                {formatArgs(call.args) && `(${formatArgs(call.args)})`}
                            </span>

                            {/* Duration */}
                            {call.duration && (
                                <span className="text-zinc-600">
                                    {call.duration}ms
                                </span>
                            )}

                            {/* Error indicator */}
                            {call.status === 'error' && (
                                <XCircle className="h-3 w-3 text-rose-400 flex-shrink-0" />
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default ToolSummary;
