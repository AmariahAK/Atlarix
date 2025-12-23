/**
 * Sidebar Navigation Component
 * ============================
 * Modified sidebar with Help, Diagram, and Web sections
 */

import React, { useState } from 'react';
import { useRouter } from 'next/router';

type SidebarTab = 'help' | 'diagram' | 'web';

interface SidebarProps {
    activeTab: SidebarTab;
    onTabChange: (tab: SidebarTab) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
    const tabs: Array<{ id: SidebarTab; label: string; symbol: string }> = [
        { id: 'help', label: 'Help', symbol: '?' },
        { id: 'diagram', label: 'Diagram', symbol: '◈' },
        { id: 'web', label: 'Web', symbol: '⊕' },
    ];

    return (
        <div
            className="sidebar"
            style={{
                width: '240px',
                background: 'var(--slate-charcoal)',
                borderRight: '1px solid var(--graphite-border)',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
            }}
        >
            {/* Tab Navigation */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
                {tabs.map(tab => (
                    <SidebarTab
                        key={tab.id}
                        symbol={tab.symbol}
                        label={tab.label}
                        active={activeTab === tab.id}
                        onClick={() => onTabChange(tab.id)}
                    />
                ))}
            </div>

            {/* Resize Handle */}
            <div
                className="resize-handle"
                style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: '4px',
                    cursor: 'ew-resize',
                    background: 'transparent',
                }}
                onMouseEnter={e => {
                    e.currentTarget.style.background = 'var(--teal-glow)';
                }}
                onMouseLeave={e => {
                    e.currentTarget.style.background = 'transparent';
                }}
            />
        </div>
    );
}

interface SidebarTabProps {
    symbol: string;
    label: string;
    active: boolean;
    onClick: () => void;
}

function SidebarTab({ symbol, label, active, onClick }: SidebarTabProps) {
    const [isHovered, setIsHovered] = useState(false);

    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                cursor: 'pointer',
                background: active ? 'var(--graphite-hover)' : isHovered ? 'var(--graphite-hover)' : 'transparent',
                borderLeft: active ? '3px solid var(--teal-glow)' : '3px solid transparent',
                color: active ? 'var(--primary-text)' : 'var(--secondary-text)',
                transition: 'all 0.2s ease',
                userSelect: 'none',
            }}
        >
            {/* Symbol */}
            <span
                style={{
                    fontSize: '20px',
                    fontWeight: 600,
                    color: active ? 'var(--teal-glow)' : 'var(--secondary-text)',
                }}
            >
                {symbol}
            </span>

            {/* Label */}
            <span
                style={{
                    fontSize: '14px',
                    fontWeight: active ? 600 : 500,
                }}
            >
                {label}
            </span>
        </div>
    );
}

// Content panels for each tab
export function HelpPanel() {
    const capabilities = [
        {
            title: 'Code Understanding',
            desc: 'Analyze codebases, extract structure, find dependencies',
        },
        {
            title: 'Smart Search',
            desc: 'Semantic search, multi-source synthesis, web integration',
        },
        {
            title: 'Code Generation',
            desc: 'Templates, scaffolding, refactoring, batch modifications',
        },
        {
            title: 'Visualization',
            desc: 'Auto-generate architecture and class diagrams',
        },
        {
            title: 'Testing & Preview',
            desc: 'Run tests, start dev servers, live preview',
        },
        {
            title: 'Version Control',
            desc: 'Git status, diffs, branch management',
        },
    ];

    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Atlarix Capabilities
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Your AI development partner with 41 powerful tools
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {capabilities.map((cap, index) => (
                    <div
                        key={index}
                        style={{
                            padding: '12px',
                            background: 'var(--graphite-hover)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--teal-glow)',
                        }}
                    >
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>{cap.title}</div>
                        <div style={{ fontSize: '13px', color: 'var(--secondary-text)' }}>
                            {cap.desc}
                        </div>
                    </div>
                ))}
            </div>

            <div
                style={{
                    marginTop: '24px',
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    border: '1px solid var(--teal-glow)',
                }}
            >
                <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
                    💡 Pro Tip
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)' }}>
                    Use @ to attach files from your workspace or computer. Atlarix will analyze them in context.
                </div>
            </div>
        </div>
    );
}

export function DiagramPanel() {
    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Project Diagrams
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Visual representation of your workspace architecture
            </p>

            <div
                style={{
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    textAlign: 'center',
                }}
            >
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>◈</div>
                <div style={{ fontSize: '14px', color: 'var(--secondary-text)' }}>
                    No workspace selected
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)', marginTop: '4px' }}>
                    Open a project to generate diagrams
                </div>
            </div>
        </div>
    );
}

export function WebPanel() {
    return (
        <div style={{ padding: '24px', color: 'var(--primary-text)' }}>
            <h2 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '8px' }}>
                Web Search History
            </h2>
            <p style={{ color: 'var(--secondary-text)', marginBottom: '24px', fontSize: '14px' }}>
                Recent web searches and resources
            </p>

            <div
                style={{
                    padding: '16px',
                    background: 'var(--graphite-hover)',
                    borderRadius: '8px',
                    textAlign: 'center',
                }}
            >
                <div style={{ fontSize: '48px', marginBottom: '12px' }}>⊕</div>
                <div style={{ fontSize: '14px', color: 'var(--secondary-text)' }}>
                    No searches yet
                </div>
                <div style={{ fontSize: '13px', color: 'var(--secondary-text)', marginTop: '4px' }}>
                    Ask Atlarix to search the web
                </div>
            </div>
        </div>
    );
}
