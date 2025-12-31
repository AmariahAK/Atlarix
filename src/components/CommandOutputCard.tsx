import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronUp, Terminal, CheckCircle2, XCircle, Loader2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * CommandOutputCard - Collapsed card showing terminal output (like ThinkingCard)
 * - Auto-collapsed on success, auto-expanded on error
 * - Shows spinner while running, checkmark/error on complete
 * - Click to expand full terminal output
 */

export interface CommandOutputCardProps {
    command: string;
    status: 'running' | 'success' | 'error';
    output?: string;
    stderr?: string;
    exitCode?: number;
    startTime?: Date;
    duration?: number;  // milliseconds
}

export function CommandOutputCard({
    command,
    status,
    output = '',
    stderr = '',
    exitCode,
    startTime,
    duration,
}: CommandOutputCardProps) {
    // Auto-expand on error, start collapsed otherwise
    const [isExpanded, setIsExpanded] = useState(status === 'error');
    const [copied, setCopied] = useState(false);
    const outputRef = useRef<HTMLPreElement>(null);

    // Auto-expand when error occurs
    useEffect(() => {
        if (status === 'error') {
            setIsExpanded(true);
        }
    }, [status]);

    // Auto-scroll to bottom when output changes
    useEffect(() => {
        if (outputRef.current && isExpanded) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [output, isExpanded]);

    // Format duration
    const formatDuration = (ms?: number) => {
        if (!ms) return null;
        if (ms < 1000) return `${ms}ms`;
        return `${(ms / 1000).toFixed(1)}s`;
    };

    // Truncate command for display
    const displayCommand = command.length > 50
        ? command.substring(0, 50) + '...'
        : command;

    // Copy output to clipboard
    const handleCopy = async () => {
        const textToCopy = [output, stderr].filter(Boolean).join('\n\n--- STDERR ---\n');
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Combined output for display
    const fullOutput = [output, stderr && `\n--- STDERR ---\n${stderr}`].filter(Boolean).join('');

    return (
        <div
            className={cn(
                "mb-3 rounded-lg border overflow-hidden",
                "bg-slate-900/60 border-slate-700/50",
                status === 'running' && "border-amber-500/30",
                status === 'error' && "border-rose-500/30"
            )}
        >
            {/* Header - Click to expand/collapse */}
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-800/30 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Terminal className={cn(
                        "w-4 h-4",
                        status === 'error' ? "text-rose-400"
                            : status === 'running' ? "text-amber-400"
                                : "text-purple-400"
                    )} />
                    <span className="text-sm font-medium text-slate-200 font-mono">
                        {displayCommand}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {/* Status indicator */}
                    {status === 'running' && (
                        <span className="flex items-center gap-1.5 text-amber-400 text-xs">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Running...
                        </span>
                    )}
                    {status === 'success' && (
                        <span className="flex items-center gap-1.5 text-emerald-400 text-xs">
                            <CheckCircle2 className="w-3 h-3" />
                            {formatDuration(duration) || 'Completed'}
                        </span>
                    )}
                    {status === 'error' && (
                        <span className="flex items-center gap-1.5 text-rose-400 text-xs">
                            <XCircle className="w-3 h-3" />
                            {exitCode !== undefined ? `Exit ${exitCode}` : 'Failed'}
                        </span>
                    )}

                    {/* Expand/collapse chevron */}
                    {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-slate-500" />
                    ) : (
                        <ChevronDown className="w-4 h-4 text-slate-500" />
                    )}
                </div>
            </button>

            {/* Expanded content - Terminal output */}
            {isExpanded && (
                <div className="border-t border-slate-700/50">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800/30">
                        <span className="text-xs text-slate-500">
                            {output.split('\n').length} lines
                        </span>
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                        >
                            {copied ? (
                                <>
                                    <Check className="w-3 h-3" />
                                    Copied!
                                </>
                            ) : (
                                <>
                                    <Copy className="w-3 h-3" />
                                    Copy
                                </>
                            )}
                        </button>
                    </div>

                    {/* Output */}
                    <pre
                        ref={outputRef}
                        className={cn(
                            "px-4 py-3 text-xs font-mono whitespace-pre-wrap break-words",
                            "max-h-[300px] overflow-auto",
                            "bg-slate-950/50 text-slate-300",
                            status === 'running' && "opacity-80"
                        )}
                    >
                        {fullOutput || (
                            <span className="text-slate-500 italic">
                                {status === 'running' ? 'Waiting for output...' : 'No output'}
                            </span>
                        )}
                    </pre>
                </div>
            )}
        </div>
    );
}

export default CommandOutputCard;
