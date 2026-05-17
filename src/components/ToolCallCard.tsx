/**
 * Tool Call Card Component (Enhanced)
 * ====================================
 * Hybrid UI: Dyad clarity + StackSense status + Aurora colors
 * - Collapsible by default
 * - Status indicators with animated states
 * - Auto-expand on errors
 * - Aurora color scheme
 */

import React, { useState, useEffect } from 'react';
import {
    ChevronDown,
    ChevronUp,
    Loader2,
    CheckCircle2,
    XCircle,
    FileText,
    Search,
    Globe,
    FolderOpen,
    Terminal,
    GitBranch,
    Database,
    Wrench,
    MessageSquare,
    BarChart3
} from 'lucide-react';

// Tool call status
export type ToolStatus = 'pending' | 'running' | 'complete' | 'error';

// Tool call data
export interface ToolCallData {
    id?: string;
    name: string;
    status: ToolStatus;
    params?: Record<string, any>;
    result?: any;
    error?: string;
    duration?: number; // milliseconds
}

interface ToolCallCardProps {
    tool: ToolCallData;
    defaultExpanded?: boolean;
}

// Tool icons mapping
const toolIcons: Record<string, React.FC<{ size?: number; className?: string }>> = {
    read_file: FileText,
    list_files: FolderOpen,
    find_file: Search,
    search_code: Search,
    search: Search,
    get_blueprint: BarChart3,
    web_search: Globe,
    deep_search: Globe,
    read_url: Globe,
    get_diagram: BarChart3,
    recall_memory: Database,
    search_memory: Database,
    run_command: Terminal,
    run_tests: Terminal,
    ask_user: MessageSquare,
    parse_code_structure: FileText,
    health_check: BarChart3,
};

// Status dot component with animation
function StatusDot({ status }: { status: ToolStatus }) {
    const baseClasses = "w-2 h-2 rounded-full";

    switch (status) {
        case 'pending':
            return (
                <span className={`${baseClasses} bg-yellow-400 animate-pulse`} />
            );
        case 'running':
            return (
                <Loader2 size={14} className="text-purple-400 animate-spin" />
            );
        case 'complete':
            return (
                <CheckCircle2 size={14} className="text-emerald-400" />
            );
        case 'error':
            return (
                <XCircle size={14} className="text-red-400" />
            );
    }
}

// Status label
function StatusLabel({ status, duration }: { status: ToolStatus; duration?: number }) {
    const labels: Record<ToolStatus, { text: string; color: string }> = {
        pending: { text: 'Pending', color: 'text-yellow-400' },
        running: { text: 'Running', color: 'text-purple-400' },
        complete: { text: duration ? `${(duration / 1000).toFixed(1)}s` : 'Done', color: 'text-emerald-400' },
        error: { text: 'Failed', color: 'text-red-400' },
    };

    const { text, color } = labels[status];

    return (
        <span className={`text-xs font-mono ${color}`}>{text}</span>
    );
}

export function ToolCallCard({ tool, defaultExpanded = false }: ToolCallCardProps) {
    // Auto-expand on error
    const [isExpanded, setIsExpanded] = useState(
        defaultExpanded || tool.status === 'error'
    );

    // Update expansion state if status changes to error
    useEffect(() => {
        if (tool.status === 'error') {
            setIsExpanded(true);
        }
    }, [tool.status]);

    // Get icon component
    const IconComponent = toolIcons[tool.name] || Wrench;

    // Format tool name for display
    const displayName = tool.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Get first param preview
    const paramPreview = tool.params
        ? Object.entries(tool.params)
            .filter(([k]) => !['workspace', 'workspaceId'].includes(k))
            .slice(0, 1)
            .map(([k, v]) => `${k}: ${String(v).substring(0, 40)}${String(v).length > 40 ? '...' : ''}`)
            .join(', ')
        : '';

    return (
        <div
            className={`
                relative overflow-hidden rounded-lg border my-2 transition-all duration-200
                ${tool.status === 'error'
                    ? 'border-red-500/30 bg-red-950/20'
                    : tool.status === 'running'
                        ? 'border-purple-500/30 bg-purple-950/10'
                        : 'border-zinc-700/50 bg-zinc-900/50 hover:bg-zinc-800/50'
                }
            `}
        >
            {/* Running animation bar */}
            {tool.status === 'running' && (
                <div
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-teal-400 via-purple-500 to-teal-400 animate-shimmer"
                    style={{
                        backgroundSize: '200% 100%',
                        animation: 'shimmer 2s linear infinite',
                    }}
                />
            )}

            {/* Header - always visible */}
            <div
                className="flex items-center gap-3 px-3 py-2 cursor-pointer select-none"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                {/* Status indicator */}
                <StatusDot status={tool.status} />

                {/* Icon */}
                <IconComponent
                    size={16}
                    className={`
                        ${tool.status === 'error' ? 'text-red-400' : ''}
                        ${tool.status === 'running' ? 'text-purple-400' : ''}
                        ${tool.status === 'complete' ? 'text-teal-400' : ''}
                        ${tool.status === 'pending' ? 'text-yellow-400' : ''}
                    `}
                />

                {/* Tool name */}
                <span className="font-mono text-sm font-medium text-zinc-200">
                    {displayName}
                </span>

                {/* Param preview (collapsed only) */}
                {!isExpanded && paramPreview && (
                    <span className="text-xs text-zinc-500 truncate max-w-[200px]">
                        {paramPreview}
                    </span>
                )}

                {/* Spacer */}
                <div className="flex-1" />

                {/* Status label */}
                <StatusLabel status={tool.status} duration={tool.duration} />

                {/* Expand/collapse chevron */}
                {isExpanded
                    ? <ChevronUp size={16} className="text-zinc-500" />
                    : <ChevronDown size={16} className="text-zinc-500" />
                }
            </div>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-3 pb-3 pt-1 border-t border-zinc-800/50">
                    {/* Parameters */}
                    {tool.params && Object.keys(tool.params).length > 0 && (
                        <div className="mb-2">
                            <div className="text-xs text-zinc-500 mb-1">Parameters</div>
                            <div className="bg-zinc-950/50 rounded p-2 text-xs font-mono">
                                {Object.entries(tool.params)
                                    .filter(([k]) => !['workspace', 'workspaceId'].includes(k))
                                    .map(([key, value]) => (
                                        <div key={key} className="flex gap-2 mb-1 last:mb-0">
                                            <span className="text-purple-400">{key}:</span>
                                            <span className="text-zinc-300 break-all">
                                                {typeof value === 'object'
                                                    ? JSON.stringify(value)
                                                    : String(value)
                                                }
                                            </span>
                                        </div>
                                    ))
                                }
                            </div>
                        </div>
                    )}

                    {/* Result */}
                    {tool.status === 'complete' && tool.result && (
                        <div>
                            <div className="text-xs text-zinc-500 mb-1">Result</div>
                            <div className="bg-zinc-950/50 rounded p-2 text-xs font-mono text-zinc-300 max-h-40 overflow-y-auto">
                                {typeof tool.result === 'string'
                                    ? tool.result.substring(0, 500) + (tool.result.length > 500 ? '...' : '')
                                    : JSON.stringify(tool.result, null, 2).substring(0, 500)
                                }
                            </div>
                        </div>
                    )}

                    {/* Error */}
                    {tool.status === 'error' && (
                        <div className="bg-red-950/30 border border-red-500/30 rounded p-2">
                            <div className="text-xs text-red-400 font-medium mb-1">Error</div>
                            <div className="text-xs text-red-300 font-mono">
                                {tool.error || tool.result?.error || 'Unknown error'}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Add shimmer animation to globals.css or inline
const shimmerKeyframes = `
@keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
}
`;

// Inject keyframes if not already present
if (typeof document !== 'undefined') {
    const styleId = 'tool-call-card-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = shimmerKeyframes;
        document.head.appendChild(style);
    }
}

export default ToolCallCard;
