/**
 * Command Terminal Output
 * =======================
 * Terminal-like display for command execution results
 */

import React, { useRef, useEffect } from 'react';

interface TerminalOutputProps {
    command: string;
    output: string;
    exitCode?: number;
    isRunning?: boolean;
    onStop?: () => void;
}

export function TerminalOutput({
    command,
    output,
    exitCode,
    isRunning,
    onStop,
}: TerminalOutputProps) {
    const outputRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        if (outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [output]);

    return (
        <div
            style={{
                background: 'var(--obsidian-graphite)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '12px',
                overflow: 'hidden',
                marginTop: '12px',
                fontFamily: 'monospace',
            }}
        >
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    background: 'var(--slate-charcoal)',
                    borderBottom: '1px solid var(--graphite-border)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '18px' }}>▸</span>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--primary-text)' }}>
                        run_command
                    </span>
                    {isRunning && (
                        <span
                            style={{
                                fontSize: '12px',
                                color: 'var(--purple-accent)',
                                background: 'rgba(167, 139, 250, 0.2)',
                                padding: '2px 8px',
                                borderRadius: '12px',
                            }}
                        >
                            Running...
                        </span>
                    )}
                </div>

                {/* Stop Button */}
                {isRunning && onStop && (
                    <button
                        onClick={onStop}
                        style={{
                            padding: '6px 12px',
                            background: 'rgba(239, 68, 68, 0.2)',
                            border: '1px solid #EF4444',
                            borderRadius: '6px',
                            color: '#EF4444',
                            fontSize: '12px',
                            cursor: 'pointer',
                            fontWeight: 500,
                        }}
                    >
                        Stop
                    </button>
                )}
            </div>

            {/* Command */}
            <div
                style={{
                    padding: '12px 16px',
                    background: 'var(--slate-charcoal)',
                    borderBottom: '1px solid var(--graphite-border)',
                }}
            >
                <span style={{ color: 'var(--teal-glow)', marginRight: '8px' }}>$</span>
                <span style={{ color: 'var(--primary-text)' }}>{command}</span>
            </div>

            {/* Output */}
            <div
                ref={outputRef}
                style={{
                    padding: '16px',
                    maxHeight: '300px',
                    overflowY: 'auto',
                    fontSize: '13px',
                    lineHeight: '1.6',
                    color: 'var(--primary-text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                }}
            >
                {output || (
                    <span style={{ color: 'var(--secondary-text)', fontStyle: 'italic' }}>
                        Waiting for output...
                    </span>
                )}
            </div>

            {/* Exit Code */}
            {exitCode !== undefined && !isRunning && (
                <div
                    style={{
                        padding: '12px 16px',
                        background: 'var(--slate-charcoal)',
                        borderTop: '1px solid var(--graphite-border)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                    }}
                >
                    {exitCode === 0 ? (
                        <>
                            <span style={{ color: '#22C55E' }}>✓</span>
                            <span style={{ color: '#22C55E', fontSize: '13px' }}>
                                Exit code: 0
                            </span>
                        </>
                    ) : (
                        <>
                            <span style={{ color: '#EF4444' }}>✕</span>
                            <span style={{ color: '#EF4444', fontSize: '13px' }}>
                                Exit code: {exitCode}
                            </span>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
