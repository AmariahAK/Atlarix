/**
 * Tool Call Card Component
 * ========================
 * Visual representation of tool execution
 */

import React, { useState } from 'react';

interface ToolCall {
    id: string;
    name: string;
    status: 'running' | 'complete' | 'error';
    params: Record<string, any>;
    result?: any;
}

interface ToolCallCardProps {
    tool: ToolCall;
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    const toolSymbols: Record<string, string> = {
        web_search: '⊕',
        generate_from_template: '◈',
        write_file: '▣',
        read_file: '▢',
        run_command: '▸',
        get_diagram: '◊',
        git_status: '◐',
        semantic_search: '◉',
        analyze_context: '◬',
        test_changes: '◆',
    };

    const symbol = toolSymbols[tool.name] || '●';

    return (
        <div
            style={{
                background: 'var(--slate-charcoal)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '8px',
                padding: '12px',
                position: 'relative',
                overflow: 'hidden',
            }}
        >
            {/* Tool Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px',
                    cursor: 'pointer',
                }}
                onClick={() => setIsExpanded(!isExpanded)}
            >
                {/* Symbol */}
                <span style={{ fontSize: '18px', color: 'var(--teal-glow)' }}>
                    {symbol}
                </span>

                {/* Tool Name */}
                <span
                    style={{
                        color: 'var(--teal-glow)',
                        fontWeight: 600,
                        fontSize: '14px',
                        fontFamily: 'JetBrains Mono, monospace',
                    }}
                >
                    {tool.name}
                </span>

                {/* Status Badge */}
                <StatusBadge status={tool.status} />

                {/* Expand Arrow */}
                <span
                    style={{
                        marginLeft: 'auto',
                        color: 'var(--secondary-text)',
                        fontSize: '12px',
                        transition: 'transform 0.2s',
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                >
                    ▼
                </span>
            </div>

            {/* Tool Parameters (Collapsed) */}
            {!isExpanded && (
                <div
                    style={{
                        color: 'var(--secondary-text)',
                        fontSize: '13px',
                        fontFamily: 'JetBrains Mono, monospace',
                    }}
                >
                    {Object.keys(tool.params).length > 0 && (
                        <span>
                            {Object.keys(tool.params)[0]}: {String(Object.values(tool.params)[0]).substring(0, 50)}
                            {String(Object.values(tool.params)[0]).length > 50 ? '...' : ''}
                        </span>
                    )}
                </div>
            )}

            {/* Tool Parameters (Expanded) */}
            {isExpanded && (
                <div
                    style={{
                        color: 'var(--secondary-text)',
                        fontSize: '13px',
                        fontFamily: 'JetBrains Mono, monospace',
                        lineHeight: '1.6',
                        marginTop: '8px',
                    }}
                >
                    {Object.entries(tool.params).map(([key, value]) => (
                        <div key={key} style={{ marginBottom: '4px' }}>
                            <span style={{ color: 'var(--purple-accent)' }}>{key}:</span>{' '}
                            <span style={{ color: 'var(--primary-text)' }}>
                                {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {/* Progress Bar for Running Tools */}
            {tool.status === 'running' && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: '3px',
                        background: 'linear-gradient(90deg, var(--teal-glow), var(--purple-accent))',
                        animation: 'shimmer 2s infinite',
                    }}
                />
            )}

            {/* View Result Button */}
            {tool.status === 'complete' && tool.result && isExpanded && (
                <button
                    style={{
                        marginTop: '12px',
                        padding: '8px 12px',
                        background: 'transparent',
                        border: '1px solid var(--teal-glow)',
                        borderRadius: '4px',
                        color: 'var(--teal-glow)',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: 500,
                    }}
                    onClick={() => {
                        // Show result modal or panel
                        console.log('Result:', tool.result);
                    }}
                >
                    View Results ↗
                </button>
            )}

            {/* Error Message */}
            {tool.status === 'error' && isExpanded && tool.result?.error && (
                <div
                    style={{
                        marginTop: '12px',
                        padding: '8px 12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '4px',
                        color: '#EF4444',
                        fontSize: '12px',
                    }}
                >
                    ⚠ {tool.result.error}
                </div>
            )}
        </div>
    );
}

function StatusBadge({ status }: { status: 'running' | 'complete' | 'error' }) {
    const styles = {
        running: { bg: 'rgba(167, 139, 250, 0.2)', color: 'var(--purple-accent)', symbol: '⏳' },
        complete: { bg: 'rgba(34, 197, 94, 0.2)', color: '#22C55E', symbol: '✓' },
        error: { bg: 'rgba(239, 68, 68, 0.2)', color: '#EF4444', symbol: '✕' },
    };

    const s = styles[status];

    return (
        <span
            style={{
                background: s.bg,
                color: s.color,
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 500,
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
            }}
        >
            <span>{s.symbol}</span>
            <span style={{ textTransform: 'capitalize' }}>{status}</span>
        </span>
    );
}
