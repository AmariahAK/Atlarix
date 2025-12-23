/**
 * Diagram Viewer Component
 * ========================
 * Interactive Mermaid diagram viewer with export
 */

import React, { useEffect, useRef } from 'react';
import mermaid from 'mermaid';

interface DiagramViewerProps {
    mermaidCode: string;
    title?: string;
    onExport?: (format: 'svg' | 'png') => void;
}

export function DiagramViewer({ mermaidCode, title, onExport }: DiagramViewerProps) {
    const diagramRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (diagramRef.current && mermaidCode) {
            // Initialize mermaid
            mermaid.initialize({
                startOnLoad: true,
                theme: 'dark',
                themeVariables: {
                    primaryColor: '#4FD1C5',
                    primaryTextColor: '#E5E7EB',
                    primaryBorderColor: '#2D3748',
                    lineColor: '#4FD1C5',
                    secondaryColor: '#A78BFA',
                    tertiaryColor: '#1C2230',
                    background: '#11151B',
                    mainBkg: '#161B22',
                    secondBkg: '#1C2230',
                    tertiaryBkg: '#2D3748',
                },
            });

            // Render diagram
            mermaid.render('generated-diagram', mermaidCode).then(({ svg }) => {
                if (diagramRef.current) {
                    diagramRef.current.innerHTML = svg;
                }
            });
        }
    }, [mermaidCode]);

    return (
        <div
            style={{
                background: 'var(--slate-charcoal)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '12px',
                padding: '16px',
                marginTop: '12px',
            }}
        >
            {/* Header */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '16px',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '20px' }}>◊</span>
                    <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--primary-text)' }}>
                        {title || 'Diagram'}
                    </span>
                </div>

                {/* Export Buttons */}
                {onExport && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => onExport('svg')}
                            style={{
                                padding: '6px 12px',
                                background: 'var(--graphite-hover)',
                                border: '1px solid var(--graphite-border)',
                                borderRadius: '6px',
                                color: 'var(--primary-text)',
                                fontSize: '12px',
                                cursor: 'pointer',
                                fontWeight: 500,
                            }}
                        >
                            Export SVG
                        </button>
                        <button
                            onClick={() => onExport('png')}
                            style={{
                                padding: '6px 12px',
                                background: 'var(--graphite-hover)',
                                border: '1px solid var(--graphite-border)',
                                borderRadius: '6px',
                                color: 'var(--primary-text)',
                                fontSize: '12px',
                                cursor: 'pointer',
                                fontWeight: 500,
                            }}
                        >
                            Export PNG
                        </button>
                    </div>
                )}
            </div>

            {/* Diagram Container */}
            <div
                ref={diagramRef}
                style={{
                    background: 'var(--obsidian-graphite)',
                    borderRadius: '8px',
                    padding: '24px',
                    overflow: 'auto',
                    minHeight: '200px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            />

            {/* Controls */}
            <div
                style={{
                    marginTop: '12px',
                    display: 'flex',
                    gap: '8px',
                    justifyContent: 'center',
                }}
            >
                <DiagramControl icon="+" label="Zoom In" />
                <DiagramControl icon="−" label="Zoom Out" />
                <DiagramControl icon="⊡" label="Fit" />
                <DiagramControl icon="◈" label="Edit Source" />
            </div>
        </div>
    );
}

function DiagramControl({ icon, label }: { icon: string; label: string }) {
    return (
        <button
            title={label}
            style={{
                padding: '8px 12px',
                background: 'var(--graphite-hover)',
                border: '1px solid var(--graphite-border)',
                borderRadius: '6px',
                color: 'var(--secondary-text)',
                fontSize: '16px',
                cursor: 'pointer',
                transition: 'all 0.2s',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.borderColor = 'var(--teal-glow)';
                e.currentTarget.style.color = 'var(--teal-glow)';
            }}
            onMouseLeave={e => {
                e.currentTarget.style.borderColor = 'var(--graphite-border)';
                e.currentTarget.style.color = 'var(--secondary-text)';
            }}
        >
            {icon}
        </button>
    );
}
